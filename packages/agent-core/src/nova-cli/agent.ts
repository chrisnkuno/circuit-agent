import { randomUUID } from "node:crypto";
import path from "node:path";
import { BoundedAgentRuntime, type AgentMessage, type AgentRuntimeEvent, type AgentRuntimeResult, type AgentTurnProvider } from "../agent-runtime";
import { affordableOutputTokens, approximateInputTokens, priceActualModelUsage, type ModelPriceCatalog } from "../model-cost";
import type { ModelUsage } from "../providers/model";
import type { ExaSearchClient } from "../providers/exa";
import { CheckpointStore, type Checkpoint, type GitRunner } from "./checkpoints";
import { capabilitiesForMode, PermissionLedger, type ApprovalPrompt, type NovaMode } from "./permissions";
import { buildNovaSystemPrompt, collectProjectContext, type ProjectContext } from "./prompt";
import { assertTurnTransition, EventJournal, runtimeEventForJournal, type TurnStatus } from "./protocol";
import {
  buildCompactedMessages,
  COMPACTION_INSTRUCTION,
  newSessionId,
  planCompaction,
  saveSession,
  titleFromObjective,
  type SessionRecord,
} from "./session";
import { createNovaTools, TodoList, type TodoItem } from "./tools";
import type { Expense } from "./cost";
import { predictAgentUsage, type AgentCostPrediction } from "./cost";
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
  /** Reported when a tool spends money outside the model, so the ledger sees the whole bill. */
  onExpense?: (expense: Expense) => void;
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
  private readonly todoList = new TodoList();
  private readonly workspace: NovaWorkspace;
  private readonly permissions: PermissionLedger;
  private readonly checkpoints: CheckpointStore;
  private readonly budgets: NovaBudgets;
  private messages: AgentMessage[] = [];
  private context: ProjectContext | null = null;
  private cancelled = false;
  private session: SessionRecord;
  private journal: EventJournal;
  private activeTurnId: string | null = null;
  private activeTransition: ((to: TurnStatus, durable?: boolean) => Promise<void>) | null = null;

  constructor(private readonly options: NovaAgentOptions) {
    this.budgets = { ...DEFAULT_NOVA_BUDGETS, ...options.budgets };
    this.workspace = options.workspace ?? new LocalWorkspace(options.root, options.limits);
    this.checkpoints = new CheckpointStore(options.root, path.join(options.root, ".nova", "checkpoint-index"), options.git);
    this.session = {
      schemaVersion: 2,
      revision: 0,
      id: newSessionId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      root: options.root,
      title: "Untitled session",
      messages: [],
      approvals: {},
      totalRwf: 0,
    };
    this.journal = new EventJournal(options.root, this.session.id);
    this.permissions = new PermissionLedger(options.mode, async (request) => {
      const turnId = this.activeTurnId ?? "turn_unbound";
      await this.activeTransition?.("waiting_approval", true);
      await this.journal.append({
        type: "approval_requested",
        turnId,
        request: {
          toolCallId: request.call.id,
          toolName: request.tool.name,
          summary: request.summary,
          actionDigest: request.actionDigest,
          scopeKey: request.scopeKey,
          policyVersion: request.policyVersion,
        },
      }, { durable: true });
      const decision = await options.approve(request);
      await this.journal.append({ type: "approval_decided", turnId, actionDigest: request.actionDigest, decision }, { durable: true });
      if (decision === "allow" || decision === "allow_always") await this.activeTransition?.("running", true);
      return decision;
    });
  }

  get sessionId(): string {
    return this.session.id;
  }

  /** Restores a previous session's transcript and standing approvals. */
  resume(record: SessionRecord): void {
    this.session = record;
    this.messages = [...record.messages];
    this.permissions.restore(record.approvals ?? {});
    this.journal = new EventJournal(this.options.root, record.id);
  }

  cancel(): void {
    this.cancelled = true;
  }

  /** Updates the amount this next exchange may spend; used by the CLI's session-wide cap. */
  setModelSpendLimit(remaining: number): void {
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("remaining model spend must be a non-negative integer");
    this.budgets.maxRwf = remaining;
  }

  /** Where this agent is reading and writing — a directory, or a sandbox id. */
  get workspaceLabel(): string {
    return this.workspace.label;
  }

  get workspaceKind(): NovaWorkspace["kind"] {
    return this.workspace.kind;
  }

  /** The agent's current plan, for `/todos` — a read-only snapshot, empty before the first turn. */
  get todos(): TodoItem[] {
    return this.todoList.list();
  }

  /** What changed since the last checkpoint, for `/diff`. */
  diffStat(): Promise<string> {
    return this.checkpoints.diffStat();
  }

  /** Releases the backend. For E2B that stops the sandbox; locally it does nothing. */
  async dispose(): Promise<void> {
    await this.relinquish();
    await this.workspace.dispose();
  }

  /**
   * Closes this front end's journal before a mode/model/settings handoff without destroying the
   * shared workspace. This prevents abandoned file handles while keeping an E2B sandbox alive.
   */
  async relinquish(): Promise<void> {
    await this.journal.close();
  }

  listCheckpoints(): Checkpoint[] {
    return this.checkpoints.list();
  }

  /** Token-based preflight using the actual system prompt, history and tool schemas for this mode. */
  async estimateNextTurn(objective: string): Promise<AgentCostPrediction> {
    const context = await collectProjectContext(this.options.root);
    const tools = createNovaTools({ workspace: this.workspace, todos: this.todoList, search: this.options.search, onExpense: this.options.onExpense });
    const capabilities = capabilitiesForMode(this.options.mode);
    const scoped = tools.filter((tool) => capabilities.includes(tool.capabilityId));
    const systemPrompt = buildNovaSystemPrompt(context, this.options.mode, scoped.map((tool) => tool.name), this.workspace);
    const toolSchemas = JSON.stringify(scoped.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
    const initialInputTokens = approximateInputTokens([
      systemPrompt,
      ...this.messages.filter((message) => message.role !== "system").map((message) => message.content),
      objective,
      toolSchemas,
    ]).expectedInputTokens;
    return predictAgentUsage({ initialInputTokens, objective, mode: this.options.mode });
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
    const turnId = `turn_${randomUUID()}`;
    this.activeTurnId = turnId;
    let turnStatus: TurnStatus = "queued";
    const transition = async (to: TurnStatus, durable = false) => {
      assertTurnTransition(turnStatus, to);
      await this.journal.append({ type: "turn_status", turnId, from: turnStatus, to }, { durable });
      turnStatus = to;
    };
    this.activeTransition = transition;
    try {
      // Recording start is ordered but not fsynced: no side effect has happened yet, so forcing a
      // disk barrier here would add latency without improving recovery. Tool calls and approvals
      // do use durable barriers before they can affect the world.
      await transition("running");

      // Repository instructions and cheap world-state signals are refreshed at every user turn.
      // A long-lived session must not keep following an AGENTS.md that changed three turns ago.
      this.context = await collectProjectContext(this.options.root);

      const tools = createNovaTools({ workspace: this.workspace, todos: this.todoList, search: this.options.search, onExpense: this.options.onExpense });
      const capabilities = capabilitiesForMode(this.options.mode);
      const scoped = tools.filter((tool) => capabilities.includes(tool.capabilityId));
      const systemPrompt = buildNovaSystemPrompt(
        this.context,
        this.options.mode,
        scoped.map((tool) => tool.name),
        this.workspace,
      );

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

      const compaction = await this.compactIfNeeded(turnId);
      const runtime = new BoundedAgentRuntime({
        model: this.options.model,
        tools: scoped,
        prices: this.options.prices,
        control: {
          heartbeat: async () => {},
          isCancellationRequested: async () => this.cancelled,
          isToolCallApproved: (call, tool) => this.permissions.decide(call, tool),
          persistEvent: async (event) => {
            this.options.onEvent?.({ type: "runtime", event });
            if (event.type !== "assistant_delta") {
              await this.journal.append(
                { type: "runtime", turnId, event: runtimeEventForJournal(event) },
                { durable: event.type === "tool_call" && event.effect !== "none" },
              );
            }
          },
        },
      });

      // The runtime owns one exchange; the CLI owns the conversation. Native messages preserve
      // provider tool-call structure and prompt caching across turns.
      const priorHistory = this.messages.filter((message) => message.role !== "system");
      const result = await runtime.execute({
        taskId: this.session.id,
        runId: this.session.id,
        stepId: `turn_${this.messages.length}`,
        objective,
        history: priorHistory,
        systemPrompt,
        allowedCapabilityIds: capabilities,
        maxIterations: this.budgets.maxIterations,
        maxToolCalls: this.budgets.maxToolCalls,
        maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
        maxToolResultChars: this.budgets.maxToolResultChars,
        maxTotalToolResultChars: this.budgets.maxTotalToolResultChars,
        maxOutputTokens: this.budgets.maxOutputTokens,
        modelReservationRwf: Math.max(0, this.budgets.maxRwf - compaction.actualRwf),
        safetyIdentifier: `nova_cli_${this.session.id}`.slice(0, 64),
      });

      const combinedUsage = addModelUsage(compaction.usage, result.usage);
      const combinedRwf = compaction.actualRwf + result.actualModelRwf;
      this.messages = result.messages;
      this.session = {
        ...this.session,
        title: this.session.messages.length === 0 ? titleFromObjective(objective) : this.session.title,
        messages: this.messages,
        approvals: this.permissions.snapshot(),
        totalRwf: this.session.totalRwf + combinedRwf,
        updatedAt: Date.now(),
      };
      const terminalStatus = runtimeStatusToTurnStatus(result.status);
      await transition(terminalStatus, true);
      await saveSession(this.session);
      return { ...result, usage: combinedUsage, actualModelRwf: combinedRwf, checkpoint };
    } catch (error) {
      if (isActiveTurnStatus(turnStatus)) {
        await transition("failed", true).catch(() => undefined);
      }
      throw error;
    } finally {
      this.activeTurnId = null;
      this.activeTransition = null;
    }
  }

  /**
   * Summarizes the transcript when it approaches the context limit.
   *
   * Uses the same model that does the work, with no tools: compaction is a reading task, and a
   * summarizer holding an `edit_file` tool is a summarizer that will eventually use it.
   */
  private async compactIfNeeded(turnId: string): Promise<{ usage: ModelUsage; actualRwf: number }> {
    const plan = planCompaction(this.messages, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens });
    if (!plan) return { usage: emptyModelUsage(), actualRwf: 0 };
    const before = this.messages.length;

    const maximumOutputTokens = affordableOutputTokens(
      [...plan.toSummarize.map((message) => message.content), COMPACTION_INSTRUCTION],
      Math.min(this.budgets.maxOutputTokens, 4_000),
      this.budgets.maxRwf,
      this.options.prices,
    );
    if (maximumOutputTokens < 1) return { usage: emptyModelUsage(), actualRwf: 0 };

    const turn = await this.options.model.complete({
      messages: [...plan.toSummarize, { role: "user", content: COMPACTION_INSTRUCTION }],
      tools: [],
      maxOutputTokens: maximumOutputTokens,
      safetyIdentifier: `nova_cli_${this.session.id}`.slice(0, 64),
    });
    const actualRwf = priceActualModelUsage(turn.usage.inputTokens, turn.usage.outputTokens, this.options.prices);
    if (actualRwf > this.budgets.maxRwf) throw new Error("Compaction usage exceeds the approved model budget");
    if (!turn.content.trim()) return { usage: turn.usage, actualRwf };

    this.messages = buildCompactedMessages(turn.content, plan);
    this.options.onEvent?.({ type: "compaction", tokensBefore: 0, messagesBefore: before, messagesAfter: this.messages.length });
    await this.journal.append({ type: "compaction", turnId, messagesBefore: before, messagesAfter: this.messages.length, actualRwf });
    return { usage: turn.usage, actualRwf };
  }
}

function emptyModelUsage(): ModelUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}

function addModelUsage(left: ModelUsage, right: ModelUsage): ModelUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  };
}

function runtimeStatusToTurnStatus(status: AgentRuntimeResult["status"]): TurnStatus {
  if (status === "needs_approval") return "waiting_approval";
  return status;
}

function isActiveTurnStatus(status: TurnStatus): boolean {
  return status === "queued" || status === "running" || status === "waiting_approval";
}
