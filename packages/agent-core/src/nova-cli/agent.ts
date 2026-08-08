import path from "node:path";
import { BoundedAgentRuntime, type AgentMessage, type AgentRuntimeEvent, type AgentRuntimeResult, type AgentTurnProvider } from "../agent-runtime";
import type { ModelPriceCatalog } from "../model-cost";
import type { ExaSearchClient } from "../providers/exa";
import { CheckpointStore, type Checkpoint, type GitRunner } from "./checkpoints";
import { capabilitiesForMode, PermissionLedger, type ApprovalPrompt, type NovaMode } from "./permissions";
import { buildNovaSystemPrompt, collectProjectContext, type ProjectContext } from "./prompt";
import {
  buildCompactedMessages,
  COMPACTION_INSTRUCTION,
  newSessionId,
  planCompaction,
  saveSession,
  titleFromObjective,
  type SessionRecord,
} from "./session";
import { createNovaTools, TodoList } from "./tools";
import { LocalWorkspace, type NovaWorkspace } from "./backends";
import type { WorkspaceLimits } from "./workspace";

/**
 * Nova CLI's agent: the hosted `BoundedAgentRuntime`, hosted locally instead.
 *
 * This is the whole architectural bet of the CLI. The runtime that drives the hosted product —
 * with its capability scoping, approval gate, budget ceiling, parallel-safe tool execution and
 * context accounting — is not reimplemented here. It is given local tools, a local approval
 * prompt, and git checkpoints instead of a disposable container. Everything the hosted worker
 * proves about safety and cost applies unchanged, and a fix to either host benefits both.
 */

export type NovaAgentOptions = {
  /** Local project directory: where sessions and checkpoints live, whatever the backend is. */
  root: string;
  model: AgentTurnProvider;
  prices: ModelPriceCatalog;
  mode: NovaMode;
  approve: ApprovalPrompt;
  /**
   * Where files are read and written. Defaults to the local project; pass an `E2BWorkspace` to
   * keep the work off this machine entirely.
   */
  workspace?: NovaWorkspace;
  search?: ExaSearchClient;
  git?: GitRunner;
  limits?: WorkspaceLimits;
  /** Reported as the session unfolds: tool calls, model turns, checkpoints. */
  onEvent?: (event: NovaEvent) => void;
  budgets?: Partial<NovaBudgets>;
};

export type NovaEvent =
  | { type: "runtime"; event: AgentRuntimeEvent }
  | { type: "checkpoint"; checkpoint: Checkpoint }
  | { type: "compaction"; tokensBefore: number; messagesBefore: number; messagesAfter: number };

export type NovaBudgets = {
  maxIterations: number;
  maxToolCalls: number;
  maxToolCallsPerTurn: number;
  maxToolResultChars: number;
  maxTotalToolResultChars: number;
  maxOutputTokens: number;
  /** RWF ceiling for one turn of work, mirroring the hosted product's reservation model. */
  maxRwf: number;
  contextLimit: number;
};

export const DEFAULT_NOVA_BUDGETS: NovaBudgets = {
  maxIterations: 60,
  maxToolCalls: 200,
  maxToolCallsPerTurn: 8,
  maxToolResultChars: 40_000,
  maxTotalToolResultChars: 400_000,
  maxOutputTokens: 8_000,
  maxRwf: 20_000,
  contextLimit: 200_000,
};

export type NovaTurnResult = AgentRuntimeResult & { checkpoint?: Checkpoint };

export class NovaAgent {
  private readonly todos = new TodoList();
  private readonly workspace: NovaWorkspace;
  private readonly permissions: PermissionLedger;
  private readonly checkpoints: CheckpointStore;
  private readonly budgets: NovaBudgets;
  private messages: AgentMessage[] = [];
  private context: ProjectContext | null = null;
  private cancelled = false;
  private session: SessionRecord;

  constructor(private readonly options: NovaAgentOptions) {
    this.budgets = { ...DEFAULT_NOVA_BUDGETS, ...options.budgets };
    this.workspace = options.workspace ?? new LocalWorkspace(options.root, options.limits);
    this.permissions = new PermissionLedger(options.mode, options.approve);
    this.checkpoints = new CheckpointStore(options.root, path.join(options.root, ".nova", "checkpoint-index"), options.git);
    this.session = {
      id: newSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      root: options.root,
      title: "Untitled session",
      messages: [],
      approvals: {},
      totalRwf: 0,
    };
  }

  get sessionId(): string {
    return this.session.id;
  }

  /** Restores a previous session's transcript and standing approvals. */
  resume(record: SessionRecord): void {
    this.session = record;
    this.messages = [...record.messages];
    this.permissions.restore(record.approvals ?? {});
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** Where this agent is reading and writing — a directory, or a sandbox id. */
  get workspaceLabel(): string {
    return this.workspace.label;
  }

  get workspaceKind(): NovaWorkspace["kind"] {
    return this.workspace.kind;
  }

  /** Releases the backend. For E2B that stops the sandbox; locally it does nothing. */
  async dispose(): Promise<void> {
    await this.workspace.dispose();
  }

  listCheckpoints(): Checkpoint[] {
    return this.checkpoints.list();
  }

  /** Restores the workspace to the checkpoint taken before the last turn. */
  async undo(): Promise<Checkpoint | undefined> {
    const checkpoint = this.checkpoints.latest();
    if (!checkpoint) return undefined;
    return (await this.checkpoints.restore(checkpoint.tree)) ? checkpoint : undefined;
  }

  /**
   * Runs one turn: the user says something, the agent works until it has an answer.
   *
   * The transcript persists across turns, which is what makes a follow-up like "now do the same
   * for the other module" mean anything.
   */
  async send(objective: string): Promise<NovaTurnResult> {
    if (!objective.trim()) throw new Error("A request is required");
    this.cancelled = false;
    this.context ??= await collectProjectContext(this.options.root);

    const tools = createNovaTools({ workspace: this.workspace, todos: this.todos, search: this.options.search });
    const capabilities = capabilitiesForMode(this.options.mode);
    const scoped = tools.filter((tool) => capabilities.includes(tool.capabilityId));
    const systemPrompt = buildNovaSystemPrompt(this.context, this.options.mode, scoped.map((tool) => tool.name), this.workspace);

    // Snapshot before the agent can touch anything, so `/undo` returns to the state the user saw
    // when they typed. Taken per turn rather than per tool call: a turn is the unit a person
    // actually thinks in, and forty checkpoints for one request is a list nobody can navigate.
    // Checkpoints snapshot the local git tree, so they mean nothing for a remote sandbox: the
    // machine's files were never touched, and the sandbox is disposable by construction.
    let checkpoint: Checkpoint | undefined;
    if (this.options.mode !== "plan" && this.workspace.kind === "local") {
      checkpoint = await this.checkpoints.capture(titleFromObjective(objective));
      if (checkpoint) this.options.onEvent?.({ type: "checkpoint", checkpoint });
    }

    await this.compactIfNeeded();

    const runtime = new BoundedAgentRuntime({
      model: this.options.model,
      tools: scoped,
      prices: this.options.prices,
      control: {
        heartbeat: async () => {},
        isCancellationRequested: async () => this.cancelled,
        isToolCallApproved: (call, tool) => this.permissions.isApproved(call, tool),
        persistEvent: async (event) => this.options.onEvent?.({ type: "runtime", event }),
      },
    });

    // The runtime owns one exchange; the CLI owns the conversation. Prior turns are replayed as
    // history so the agent continues rather than restarting, while the runtime still sees the
    // clean (system, objective) opening it validates.
    const priorHistory = this.messages.filter((message) => message.role !== "system");
    const result = await runtime.execute({
      taskId: this.session.id,
      runId: this.session.id,
      stepId: `turn_${this.messages.length}`,
      objective: priorHistory.length > 0 ? renderContinuation(priorHistory, objective) : objective,
      systemPrompt,
      allowedCapabilityIds: capabilities,
      maxIterations: this.budgets.maxIterations,
      maxToolCalls: this.budgets.maxToolCalls,
      maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
      maxToolResultChars: this.budgets.maxToolResultChars,
      maxTotalToolResultChars: this.budgets.maxTotalToolResultChars,
      maxOutputTokens: this.budgets.maxOutputTokens,
      modelReservationRwf: this.budgets.maxRwf,
      safetyIdentifier: `nova_cli_${this.session.id}`.slice(0, 64),
    });

    this.messages = result.messages;
    this.session = {
      ...this.session,
      title: this.session.messages.length === 0 ? titleFromObjective(objective) : this.session.title,
      messages: this.messages,
      approvals: this.permissions.snapshot(),
      totalRwf: this.session.totalRwf + result.actualModelRwf,
      updatedAt: Date.now(),
    };
    await saveSession(this.session).catch(() => undefined);
    return { ...result, checkpoint };
  }

  /**
   * Summarizes the transcript when it approaches the context limit.
   *
   * Uses the same model that does the work, with no tools: compaction is a reading task, and a
   * summarizer holding an `edit_file` tool is a summarizer that will eventually use it.
   */
  private async compactIfNeeded(): Promise<void> {
    const plan = planCompaction(this.messages, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens });
    if (!plan) return;
    const before = this.messages.length;

    const turn = await this.options.model.complete({
      messages: [...plan.toSummarize, { role: "user", content: COMPACTION_INSTRUCTION }],
      tools: [],
      maxOutputTokens: Math.min(this.budgets.maxOutputTokens, 4_000),
      safetyIdentifier: `nova_cli_${this.session.id}`.slice(0, 64),
    });
    if (!turn.content.trim()) return;

    this.messages = buildCompactedMessages(turn.content, plan);
    this.options.onEvent?.({ type: "compaction", tokensBefore: 0, messagesBefore: before, messagesAfter: this.messages.length });
  }
}

/**
 * Replays prior turns into the next request.
 *
 * The runtime deliberately accepts a single objective, which keeps its own contract simple and
 * its validation honest. Rather than widening that contract for the CLI's sake, the conversation
 * is rendered into the request — the model sees what happened, and the runtime stays the same
 * component the hosted product runs.
 */
function renderContinuation(history: readonly AgentMessage[], objective: string): string {
  const transcript = history
    .map((message) => {
      if (message.role === "tool") return `[tool ${message.name}] ${truncateLine(message.content, 800)}`;
      if (message.role === "assistant" && "toolCalls" in message) {
        const names = message.toolCalls.map((call) => call.name).join(", ");
        return `Nova: ${truncateLine(message.content, 800)}${names ? ` (called: ${names})` : ""}`;
      }
      return `${message.role === "user" ? "User" : "Nova"}: ${truncateLine(message.content, 800)}`;
    })
    .join("\n");
  return `Earlier in this session:\n${transcript}\n\nThe user now says:\n${objective}`;
}

function truncateLine(value: string, maximum: number): string {
  const clean = (value ?? "").replace(/\s+/g, " ").trim();
  return clean.length <= maximum ? clean : `${clean.slice(0, maximum)}…`;
}
