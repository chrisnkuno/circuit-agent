import { randomUUID } from "node:crypto";
import path from "node:path";
import { agentMessagePromptParts, BoundedAgentRuntime, type AgentMessage, type AgentRuntimeEvent, type AgentRuntimeResult, type AgentTool, type AgentTurnProvider } from "../agent-runtime";
import { affordableOutputTokens, approximateInputTokens, priceActualModelUsage, type ModelPriceCatalog } from "../model-cost";
import type { ModelUsage } from "../providers/model";
import type { ExaSearchClient } from "../providers/exa";
import { CheckpointStore, type Checkpoint, type GitRunner } from "./checkpoints";
import { capabilitiesForMode, PermissionLedger, type ApprovalPrompt, type NovaMode } from "./permissions";
import { loadMemories, memoryPromptBlock, recallMemories, recalledMemoryKey } from "./memory";
import { probeEnvironment, type EnvironmentReport } from "./environment";
import { buildNovaSystemPrompt, collectProjectContext, type ProjectContext } from "./prompt";
import { assertTurnTransition, EventJournal, runtimeEventForJournal, type TurnStatus } from "./protocol";
import {
  atSafeBoundary,
  buildCompactedMessages,
  COMPACTION_INSTRUCTION,
  compactionUrgency,
  newSessionId,
  planCompaction,
  saveSession,
  STANDING_CONSTRAINTS_HEADING,
  titleFromObjective,
  type CompactionBoundary,
  type CompactionUrgency,
  type SessionRecord,
  type StandingConstraints,
} from "./session";
import { loadLocalExternalTooling, type LocalExternalTooling } from "./external-tools";
import { NestedInstructionTracker } from "./nested-instructions";
import { createNovaTools, scanWorkspaceForSecrets, TodoList, type DelegateResult, type DelegateRunner, type PlacedSecretFinding, type TodoItem } from "./tools";
import type { Expense } from "./cost";
import { predictAgentUsage, type AgentCostPrediction } from "./cost";
import { LocalWorkspace, type NovaWorkspace } from "./backends";
import { WorkspaceArtifactStore } from "./artifacts";
import type { ReadResult, WorkspaceLimits } from "./workspace";
import { DEFAULT_OUTPUT_CEILING } from "../providers/model-capabilities";
import { DefenderBrain } from "./defender-brain";
import { toolProfileForObjective, toolsForProfile } from "./tool-profile";

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
  // `urgency` and `boundary` say *why* the transcript was compacted here rather than later, which
  // is the only interesting thing about a compaction from outside: at 70% because the work reached
  // a clean stopping point, or at 90% because it had to be.
  | { type: "compaction"; tokensBefore: number; messagesBefore: number; messagesAfter: number; urgency?: CompactionUrgency; boundary?: CompactionBoundary };

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
  // Long repository tasks routinely need more than the old 200-call ceiling. These remain hard
  // bounded at the runtime validator's limits and the monetary reservation still caps every model
  // turn, so increasing capacity does not grant unbounded execution or spending.
  maxIterations: 100,
  maxToolCalls: 500,
  maxToolCallsPerTurn: 16,
  maxToolResultChars: 40_000,
  maxTotalToolResultChars: 400_000,
  // Raised from 8,000 because that ceiling was being hit in ordinary work — a long file written in
  // one go, a full plan, or a thinking model whose hidden reasoning shares this same budget. Hitting
  // it is now recoverable (the runtime resumes a `length` turn rather than failing it), but each
  // resumption costs a round trip and re-sends the whole transcript, so the cheaper fix is to let
  // the common case finish in one reply. Well inside every current model's own output limit, and
  // costed only when actually used: the runtime clamps each call to what the remaining budget can
  // afford, so a higher ceiling spends nothing on a short answer.
  maxOutputTokens: 16_000,
  maxRwf: 20_000,
  // The floor, not the answer. A session whose provider reports what its model can hold replaces
  // both this and `maxOutputTokens` with the model's own figures (see the constructor): 200,000 is
  // a fifth of a current Opus or Sonnet window, and compacting at 70% of it threw away a
  // transcript that had not come close to filling anything.
  contextLimit: 200_000,
};

export type NovaTurnResult = AgentRuntimeResult & { checkpoint?: Checkpoint };

/** Which half of a checkpoint to restore. "both" is the historical, sole behaviour of `/undo`. */
export type RestoreScope = "code" | "conversation" | "both";

export class NovaAgent {
  private readonly todoList = new TodoList();
  /**
   * A directory's own AGENTS.md, surfaced the first time a tool reaches it. Reads through
   * `this.workspace`, so it works on every backend — the files the agent is working on are the ones
   * whose rules should reach it, whether they live on this machine or in a sandbox.
   */
  private readonly nestedInstructions: NestedInstructionTracker | undefined;
  /**
   * Skills, hooks, plugins and MCP servers discovered from `.nova/`, also through `this.workspace`
   * and so also backend-independent. Lazily loaded and memoized on first turn rather than in the
   * constructor — construction stays synchronous, and a session that never sends a turn never pays
   * for discovery or spawns an MCP server it will never use.
   */
  private externalTooling: Promise<LocalExternalTooling | undefined> | null = null;
  private readonly workspace: NovaWorkspace;
  private readonly permissions: PermissionLedger;
  private readonly checkpoints: CheckpointStore;
  /**
   * Where tool results too large for the transcript are written.
   *
   * Through the workspace, so a sandboxed session's artifacts land in the sandbox where the
   * agent's own `read_file` can reach them — an artifact on a host the agent cannot see is a
   * handle to nothing.
   */
  private readonly artifacts: WorkspaceArtifactStore;
  private readonly budgets: NovaBudgets;
  private messages: AgentMessage[] = [];
  /** Memory already carried by this transcript; incremental recall prevents quadratic repetition. */
  private readonly recalledMemoryKeys = new Set<string>();
  /**
   * The request that opened this session, kept whole.
   *
   * Not read back off `messages` on demand, because compaction rewrites the front of the
   * transcript: after one summary the first user message is the constraints block, and after two
   * the original wording is gone entirely. It is the thing every later turn is still in service
   * of, so it is held here and restated at every compaction.
   */
  private openingObjective: string | null = null;
  private context: ProjectContext | null = null;
  /**
   * What is actually installed where commands run, probed once and reused.
   *
   * Per session rather than per turn, unlike `context`: an AGENTS.md can change between turns and
   * must be re-read, but a toolchain does not appear mid-session, and re-probing it would spend a
   * dozen process launches on every message the user sends.
   */
  private environment: Promise<EnvironmentReport> | null = null;
  private cancelled = false;
  /** The active exchange's cancellation reaches provider I/O and local process trees immediately. */
  private turnAbort: AbortController | null = null;
  private session: SessionRecord;
  private journal: EventJournal;
  private activeTurnId: string | null = null;
  private activeTransition: ((to: TurnStatus, durable?: boolean) => Promise<void>) | null = null;
  /** What `delegate_task` sub-runs have spent this turn — folded into the turn's own total once it finishes. See `createDelegateRunner`. */
  private delegatedRwf = 0;
  private delegatedUsage: ModelUsage = emptyModelUsage();
  private readonly defenderBrain: DefenderBrain;

  /** The environment report for this session, probed on first use and cached. Never throws: a session that cannot describe its environment still runs, just without the section. */
  private loadEnvironment(): Promise<EnvironmentReport | undefined> {
    this.environment ??= probeEnvironment(this.workspace);
    return this.environment.catch(() => undefined);
  }

  constructor(private readonly options: NovaAgentOptions) {
    // Model-derived first, caller-supplied last: a session runs against what its model can really
    // do, while an explicit budget from the caller still overrides everything — that is the whole
    // reason `--budget` and the embedder's own options exist.
    const capabilities = options.model.capabilities;
    const derived = capabilities
      ? {
        contextLimit: capabilities.contextWindow,
        maxOutputTokens: Math.min(capabilities.maxOutputTokens, DEFAULT_OUTPUT_CEILING),
        // Tool-result allowances scale with the window for the same reason the window does: 40,000
        // characters is a sixteenth of a 200K context and a sixtieth of a 1M one, and a fixed
        // number means a bigger model reads *less* of a large file than a smaller one. The shares
        // are chosen to reproduce today's 40,000 / 400,000 exactly at a 200K window, so nothing
        // changes for a model that really is that size.
        maxToolResultChars: Math.round(capabilities.contextWindow * 0.2),
        maxTotalToolResultChars: capabilities.contextWindow * 2,
      }
      : {};
    this.budgets = { ...DEFAULT_NOVA_BUDGETS, ...derived, ...options.budgets };
    this.workspace = options.workspace ?? new LocalWorkspace(options.root, options.limits);
    this.nestedInstructions = new NestedInstructionTracker(this.workspace);
    this.artifacts = new WorkspaceArtifactStore(this.workspace);
    this.defenderBrain = new DefenderBrain(path.join(options.root, ".nova", "security-brain"));
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
      mode: options.mode,
      recalledMemoryKeys: [],
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
          effect: request.tool.effect,
          capabilityId: request.tool.capabilityId,
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

  /**
   * A self-contained handoff record for rebuilding this session around another model or mode.
   *
   * Handoffs used to close the agent and then re-read this record from disk. That made a transient
   * read/integrity failure indistinguishable from an empty conversation: the replacement agent
   * silently started a new thread. The live agent is the authority for its current transcript, so
   * capture it before retirement and pass it directly to the replacement.
   */
  snapshot(): SessionRecord {
    return structuredClone(this.session);
  }

  /** Restores a previous session's transcript and standing approvals. */
  resume(record: SessionRecord): void {
    this.session = { ...record, mode: this.options.mode };
    this.messages = [...record.messages];
    this.recalledMemoryKeys.clear();
    for (const key of record.recalledMemoryKeys ?? []) this.recalledMemoryKeys.add(key);
    // A resumed session may already have been compacted, in which case the earliest surviving user
    // message is Nova's own constraints block or summary rather than anything the user typed.
    // Those are skipped by their headings; if nothing is left, the session title is the best
    // remaining record of what was asked.
    this.openingObjective =
      record.messages.find(
        (message) =>
          message.role === "user" &&
          !message.internal &&
          !message.content.startsWith(STANDING_CONSTRAINTS_HEADING) &&
          !message.content.startsWith("[Earlier conversation, summarized]"),
      )?.content ?? (record.title === "Untitled session" ? null : record.title);
    this.permissions.restore(record.approvals ?? {});
    this.journal = new EventJournal(this.options.root, record.id);
  }

  cancel(): void {
    this.cancelled = true;
    this.turnAbort?.abort();
  }

  /** Updates the amount this next exchange may spend; used by the CLI's session-wide cap. */
  setModelSpendLimit(remaining: number): void {
    if (!Number.isSafeInteger(remaining) || remaining < 0) throw new Error("remaining model spend must be a non-negative integer");
    this.budgets.maxRwf = remaining;
  }

  /** Where this agent is reading and writing — a directory, or a sandbox id. */
  /**
   * The limits this session is actually running under.
   *
   * Worth exposing rather than keeping private: they are no longer constants a reader can look up
   * in this file — they depend on which model the session opened with — and both the CLI's own
   * reporting and any embedder deciding how much to send need the same answer the runtime uses.
   */
  get budgetSnapshot(): Readonly<NovaBudgets> {
    return this.budgets;
  }

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
  diffPatch(): Promise<string> {
    return this.checkpoints.diffPatch();
  }

  diffStat(): Promise<string> {
    return this.checkpoints.diffStat();
  }

  /**
   * The project's files, root-relative — for a file browser, on whichever backend is in use.
   *
   * Goes through `this.workspace`, so a sandboxed session lists the sandbox's files rather than the
   * host's. Read-only and free: no model turn and no approval, the same as `scanSecrets`.
   */
  listFiles(pattern = "**/*"): Promise<string[]> {
    return this.workspace.glob(pattern);
  }

  /**
   * One file's contents, for looking at rather than for changing.
   *
   * The same guarantees as `listFiles`, and for the same reason: through `this.workspace`, so a
   * sandboxed session shows the sandbox's copy and not the host's — reading the local disk here
   * would show a file the agent is not working on, which is worse than showing nothing. Read-only,
   * no model turn, no approval, and the workspace's own root confinement and size limits apply, so
   * this cannot be pointed outside the project.
   */
  readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
    return this.workspace.readFile(path, options);
  }

  /** The deterministic secret scan, run directly against the workspace — for `/scan`. No model turn, no approval: same read-only guarantee as the `scan_secrets` tool it shares its logic with. */
  scanSecrets(include?: string): Promise<PlacedSecretFinding[]> {
    return scanWorkspaceForSecrets(this.workspace, include);
  }

  /** Releases the backend. For E2B that stops the sandbox; locally it does nothing. */
  async dispose(): Promise<void> {
    await this.relinquish();
    await this.workspace.dispose();
    // Kills any MCP server process this session actually started. A tooling load that never
    // happened (no turn was ever sent) is `null`, and disposing nothing is correct.
    await (await this.externalTooling)?.dispose();
    await this.defenderBrain.close();
  }

  private loadExternalTooling(): Promise<LocalExternalTooling | undefined> {
    // Every backend, not only local: discovery reads through the workspace, so a `.nova` directory
    // committed to a repository is found in an E2B or Docker session exactly as it is on this
    // machine. (`nestedInstructions` above is still local-only — it reads `node:fs` directly.)
    this.externalTooling ??= loadLocalExternalTooling(this.workspace);
    return this.externalTooling;
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

  /**
   * What this session can actually call, and which hook scripts would run — for `/tools`.
   *
   * Built by the same `createNovaTools` call a real turn uses, rather than a second list assembled
   * for display: a "what is loaded" answer that is computed differently from what actually loads is
   * the one kind of answer that is worse than none. Scoped to the mode's capabilities for the same
   * reason — plan mode genuinely cannot call the write tools, so listing them would be a lie.
   */
  async inspectTools(): Promise<{ tools: AgentTool[]; hooks: { preToolUse: string[]; postToolUse: string[] }; providerIds: string[] }> {
    const context = await collectProjectContext(this.options.root);
    const externalTooling = await this.loadExternalTooling();
    const delegate = this.createDelegateRunner(context, () => this.budgets.maxRwf);
    const tools = await createNovaTools({
      workspace: this.workspace,
      todos: this.todoList,
      search: this.options.search,
      onExpense: this.options.onExpense,
      instructions: this.nestedInstructions,
      externalToolProviders: externalTooling?.providers,
      hooks: externalTooling?.hooks,
      delegate: delegate.runner,
      // The *local* root, never the workspace: a fact learned during a remote sandbox session must
      // outlive that container, and `.nova/memory.md` inside a disposable sandbox does not.
      memoryRoot: this.options.root,
      defenderBrain: this.defenderBrain,
    });
    const capabilities = capabilitiesForMode(this.options.mode);
    return {
      tools: tools.filter((tool) => capabilities.includes(tool.capabilityId)),
      hooks: (await externalTooling?.hooks.list()) ?? { preToolUse: [], postToolUse: [] },
      providerIds: externalTooling?.providers.map((provider) => `${provider.kind}:${provider.id}`) ?? [],
    };
  }

  /** Token-based preflight using the actual system prompt, history and tool schemas for this mode. */
  async estimateNextTurn(objective: string): Promise<AgentCostPrediction> {
    const context = await collectProjectContext(this.options.root);
    const externalTooling = await this.loadExternalTooling();
    const delegate = this.createDelegateRunner(context, () => this.budgets.maxRwf);
    const tools = await createNovaTools({
      workspace: this.workspace,
      todos: this.todoList,
      search: this.options.search,
      onExpense: this.options.onExpense,
      instructions: this.nestedInstructions,
      externalToolProviders: externalTooling?.providers,
      hooks: externalTooling?.hooks,
      delegate: delegate.runner,
      // The *local* root, never the workspace: a fact learned during a remote sandbox session must
      // outlive that container, and `.nova/memory.md` inside a disposable sandbox does not.
      memoryRoot: this.options.root,
      defenderBrain: this.defenderBrain,
    });
    const capabilities = capabilitiesForMode(this.options.mode);
    const scoped = toolsForProfile(
      tools.filter((tool) => capabilities.includes(tool.capabilityId)),
      toolProfileForObjective(objective, this.options.mode),
    );
    delegate.setTools(scoped.filter((tool) => tool.name !== "delegate_task"));
    const systemPrompt = buildNovaSystemPrompt(context, this.options.mode, scoped.map((tool) => tool.name), this.workspace, await this.loadEnvironment());
    const toolSchemas = JSON.stringify(scoped.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })));
    const initialInputTokens = approximateInputTokens([
      systemPrompt,
      ...this.messages.filter((message) => message.role !== "system").flatMap(agentMessagePromptParts),
      objective,
      toolSchemas,
    ]).expectedInputTokens;
    return predictAgentUsage({ initialInputTokens, objective, mode: this.options.mode });
  }

  /**
   * Restores the last checkpoint — code, conversation, or both.
   *
   * The three scopes answer three different regrets: "the edit was wrong but the plan we discussed
   * to get there was fine" (code), "the model went down a conversational dead end but the files
   * are untouched or already fixed by hand" (conversation), and "start this turn over completely"
   * (both, the default and the only thing `/undo` did before this).
   *
   * A conversation restore is written back to the session file immediately, not left to catch up
   * on the next `send()` — someone who undoes and then closes Nova without sending another turn
   * must not find the untruncated transcript still on disk.
   */
  async undo(scope: RestoreScope = "both"): Promise<Checkpoint | undefined> {
    const checkpoint = this.checkpoints.latest();
    if (!checkpoint) return undefined;
    if (scope === "code" || scope === "both") {
      if (!(await this.checkpoints.restore(checkpoint.tree))) return undefined;
    }
    if (scope === "conversation" || scope === "both") {
      this.messages = this.messages.slice(0, checkpoint.messageCount);
      this.session = { ...this.session, messages: this.messages, updatedAt: Date.now() };
      await saveSession(this.session);
    }
    return checkpoint;
  }

  /**
   * Builds the closure `delegate_task` calls to run one bounded sub-agent.
   *
   * The sub-agent's own tool list is not known yet when this closure is created — it is the
   * outer tool list, once built, minus `delegate_task` itself. `setTools` is called once that list
   * exists; `execute` is only ever invoked later, during the run, by which point it always has. The
   * indirection is what keeps this to one `createNovaTools` call instead of two.
   *
   * Depth is bounded structurally, not by a counter: the sub-agent's tool set never includes
   * `delegate_task`, so it cannot spawn a further sub-agent no matter what it is asked to do.
   *
   * Approval, cancellation and mode are all inherited from the parent session — the same
   * `PermissionLedger`, so every effectful call inside the sub-agent is gated exactly as it would
   * be if the top-level agent had called it directly, and cancelling the parent turn stops it too.
   * What is not inherited is live event streaming: a sub-agent's own tool calls are not pushed to
   * `onEvent`, so the transcript shows `delegate_task` as one call with one final report, not a
   * nested play-by-play.
   */
  private createDelegateRunner(context: ProjectContext, remainingRwf: () => number): { runner: DelegateRunner; setTools: (tools: AgentTool[]) => void } {
    let subTools: AgentTool[] = [];
    const capabilities = capabilitiesForMode(this.options.mode);
    const runner: DelegateRunner = async (task: string): Promise<DelegateResult> => {
      const systemPrompt = buildNovaSystemPrompt(context, this.options.mode, subTools.map((tool) => tool.name), this.workspace, await this.loadEnvironment());
      // Never more than half of whatever is left of the turn's own budget on one delegation, so a
      // model that delegates several times in a row cannot spend the whole turn's budget on the
      // first one and leave nothing for the rest of its own work.
      const reservation = Math.max(0, Math.min(remainingRwf(), this.budgets.maxRwf / 2));
      const runtime = new BoundedAgentRuntime({
        model: this.options.model,
        tools: subTools,
        prices: this.options.prices,
        artifacts: this.artifacts,
        control: {
          heartbeat: async () => {},
          isCancellationRequested: async () => this.cancelled,
          isToolCallApproved: (call, tool) => this.permissions.decide(call, tool),
          persistEvent: async () => {},
        },
      });
      const result = await runtime.execute({
        taskId: `${this.session.id}_delegate`,
        runId: this.session.id,
        stepId: `delegate_${randomUUID()}`,
        objective: task,
        history: [],
        systemPrompt,
        allowedCapabilityIds: capabilities,
        maxIterations: Math.min(15, this.budgets.maxIterations),
        maxToolCalls: Math.min(40, this.budgets.maxToolCalls),
        maxToolCallsPerTurn: this.budgets.maxToolCallsPerTurn,
        maxToolResultChars: this.budgets.maxToolResultChars,
        maxTotalToolResultChars: this.budgets.maxTotalToolResultChars,
        maxOutputTokens: this.budgets.maxOutputTokens,
        // A delegated sub-task is the textbook cheap-effort case: it is bounded, self-contained and
        // reports back in prose. Lower effort also means fewer, more consolidated tool calls and
        // less preamble, which is most of what a sub-agent's cost actually is.
        effort: "low",
        modelReservationRwf: reservation,
        safetyIdentifier: `nova_cli_${this.session.id}_delegate`.slice(0, 64),
        signal: this.turnAbort?.signal,
      });
      this.delegatedRwf += result.actualModelRwf;
      this.delegatedUsage = addModelUsage(this.delegatedUsage, result.usage);
      return { report: result.summary, status: result.status, iterations: result.iterations, toolCallsExecuted: result.toolCallsExecuted };
    };
    return { runner, setTools: (tools) => { subTools = tools; } };
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
    const turnAbort = new AbortController();
    this.turnAbort = turnAbort;
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

      this.openingObjective ??= objective;

      // Repository instructions and cheap world-state signals are refreshed at every user turn.
      // A long-lived session must not keep following an AGENTS.md that changed three turns ago.
      this.context = await collectProjectContext(this.options.root);

      // `delegate_task` reserves against what is left of *this turn's* budget once compaction (below)
      // has taken its share — known only after this point, so the callback reads it through a
      // variable set once it is, rather than the closure capturing today's zero forever.
      this.delegatedRwf = 0;
      this.delegatedUsage = emptyModelUsage();
      let compactionActualRwf = 0;
      const delegate = this.createDelegateRunner(this.context, () => Math.max(0, this.budgets.maxRwf - compactionActualRwf - this.delegatedRwf));

      const externalTooling = await this.loadExternalTooling();
      const tools = await createNovaTools({
        workspace: this.workspace,
        todos: this.todoList,
        search: this.options.search,
        onExpense: this.options.onExpense,
        instructions: this.nestedInstructions,
        externalToolProviders: externalTooling?.providers,
        hooks: externalTooling?.hooks,
        delegate: delegate.runner,
        memoryRoot: this.options.root,
        defenderBrain: this.defenderBrain,
      });
      const capabilities = capabilitiesForMode(this.options.mode);
      const scoped = toolsForProfile(
        tools.filter((tool) => capabilities.includes(tool.capabilityId)),
        toolProfileForObjective(objective, this.options.mode),
      );
      delegate.setTools(scoped.filter((tool) => tool.name !== "delegate_task"));
      /**
       * Durable memory, recalled against this turn's objective and prepended to the prompt.
       *
       * Done here rather than in each front end, which is the whole point of the move: the CLI had
       * its own recall wiring and the desktop had none, so the same agent knew the user's
       * conventions in a terminal and had never heard of them in a window. One agent, one memory.
       *
       * Recall is lexical and bounded — it selects a few kilobytes at most — so a memory file that
       * grows for a year does not quietly become the largest thing in every request.
       */
      const memories = await loadMemories(this.options.root, process.env).catch(() => []);
      const recalled = memories.length > 0
        ? recallMemories(memories, objective, { exclude: this.recalledMemoryKeys }).entries
        : [];
      for (const entry of recalled) this.recalledMemoryKeys.add(recalledMemoryKey(entry));
      /**
       * The system prompt is the cached prefix, so nothing turn-specific may live in it.
       *
       * Recalled memory used to be appended here, and it is selected by lexical overlap with *this
       * turn's objective* — so a different question produced a different system block, and because
       * a prompt cache is a strict prefix match over tools → system → messages, one changed
       * sentence at the top invalidated the cache for the entire transcript beneath it. On a long
       * conversation that turned a 0.1x cache read into a 1.25x cache write, every single turn.
       *
       * The memory itself is just as useful attached to the turn that asked for it, where it costs
       * a cache miss on nothing but itself.
       */
      const systemPrompt = buildNovaSystemPrompt(this.context, this.options.mode, scoped.map((tool) => tool.name), this.workspace, await this.loadEnvironment());
      const memoryBlock = memoryPromptBlock(recalled);
      const turnObjective = memoryBlock ? `${memoryBlock}\n\n${objective}` : objective;

      // Snapshot before the agent can touch anything, so `/undo` returns to the state the user saw
      // when they typed. Taken per turn rather than per tool call: a turn is the unit a person
      // actually thinks in, and forty checkpoints for one request is a list nobody can navigate.
      // Checkpoints snapshot the local git tree, so they mean nothing for a remote sandbox: the
      // machine's files were never touched, and the sandbox is disposable by construction.
      let checkpoint: Checkpoint | undefined;
      if (this.options.mode !== "plan" && this.workspace.kind === "local") {
        // `this.messages.length` here, before this turn's own exchange is appended below, is
        // exactly the cut point a conversation-only or combined restore needs: "back to what the
        // user saw when they typed this turn's objective."
        checkpoint = await this.checkpoints.capture(titleFromObjective(objective), turnId, this.messages.length);
        if (checkpoint) this.options.onEvent?.({ type: "checkpoint", checkpoint });
      }

      const compaction = await this.compactIfNeeded(turnId, objective, turnAbort.signal);
      compactionActualRwf = compaction.actualRwf;
      const runtime = new BoundedAgentRuntime({
        model: this.options.model,
        tools: scoped,
        prices: this.options.prices,
        artifacts: this.artifacts,
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
        // Carries this turn's recalled memory with it, so the cached system prefix stays byte-stable.
        objective: turnObjective,
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
        signal: turnAbort.signal,
      });

      const combinedUsage = addModelUsage(compaction.usage, addModelUsage(result.usage, this.delegatedUsage));
      const combinedRwf = compaction.actualRwf + result.actualModelRwf + this.delegatedRwf;
      this.messages = result.messages;
      this.session = {
        ...this.session,
        title: this.session.messages.length === 0 ? titleFromObjective(objective) : this.session.title,
        messages: this.messages,
        recalledMemoryKeys: [...this.recalledMemoryKeys],
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
      if (this.turnAbort === turnAbort) this.turnAbort = null;
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
  private async compactIfNeeded(turnId: string, objective: string, signal?: AbortSignal): Promise<{ usage: ModelUsage; actualRwf: number }> {
    // Compaction happens between turns, which is already the cleanest boundary a session has: the
    // previous exchange concluded, no tool call is outstanding. `atSafeBoundary` still asks,
    // because "concluded" is not the same as "finished" — an agent that left an item in progress
    // on its own plan is mid-task no matter where the turn ended, and the detail behind that item
    // is exactly what a summary would drop.
    const boundary = atSafeBoundary(this.messages, { workInProgress: this.todoList.list().some((item) => item.status === "in_progress") })
      ? "safe"
      : "mid-task";
    const urgency = compactionUrgency(this.messages, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens });
    const plan = planCompaction(this.messages, { contextLimit: this.budgets.contextLimit, outputBudget: this.budgets.maxOutputTokens, boundary });
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
      // Summarizing is reading, not reasoning. Thinking tokens bill as output and share the output
      // budget, so paying for deep reasoning to compress a transcript spends money on the one call
      // in the session that produces nothing the user asked for. Providers whose model does not
      // take the setting ignore it.
      effort: "low",
      messages: [...plan.toSummarize, { role: "user", content: COMPACTION_INSTRUCTION }],
      tools: [],
      maxOutputTokens: maximumOutputTokens,
      safetyIdentifier: `nova_cli_${this.session.id}`.slice(0, 64),
      signal,
    });
    const actualRwf = priceActualModelUsage(turn.usage.inputTokens, turn.usage.outputTokens, this.options.prices);
    if (actualRwf > this.budgets.maxRwf) throw new Error("Compaction usage exceeds the approved model budget");
    if (!turn.content.trim()) return { usage: turn.usage, actualRwf };

    this.messages = buildCompactedMessages(turn.content, plan, this.standingConstraints(objective));
    this.options.onEvent?.({ type: "compaction", tokensBefore: 0, messagesBefore: before, messagesAfter: this.messages.length, urgency, boundary });
    await this.journal.append({ type: "compaction", turnId, messagesBefore: before, messagesAfter: this.messages.length, actualRwf });
    return { usage: turn.usage, actualRwf };
  }

  /**
   * The session's governing facts, read from live state at the moment of compaction.
   *
   * Every field here is fetched from the thing that actually enforces it — the permission ledger,
   * the configured mode, the agent's own plan — rather than from the transcript being summarized.
   * That is what makes the block incapable of drifting: it cannot preserve a stale approval,
   * because it never reads the old one.
   */
  private standingConstraints(objective: string): StandingConstraints {
    return {
      mode: this.options.mode,
      objective: this.openingObjective ?? objective,
      approvals: this.permissions.snapshot(),
      openTodos: this.todoList.list().filter((item) => item.status !== "done").map((item) => item.text),
    };
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
