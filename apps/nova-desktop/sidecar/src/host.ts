import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CostLedger,
  E2BWorkspace,
  LocalWorkspace,
  NovaAgent,
  NovaSessionDaemon,
  describeProviders,
  downloadProject,
  fromUnits,
  formatMoney,
  listSessions,
  loadSession,
  resolveProvider,
  uploadProject,
  type NovaEvent,
  type NovaDaemonClient,
  type DaemonNotification,
  type NovaMode,
  type NovaWorkspace,
  type PermissionDecision,
  type TokenPrices,
} from "@circuit-nova/nova-core";
import type { ModelPriceCatalog } from "@circuit-nova/nova-core/model-cost";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { createE2BProvider } from "@circuit-nova/nova-core/providers/factory";
import { addMemory, forgetMemory, loadMemories, memoryFile, type MemoryKind, type MemoryScope } from "@circuit-nova/nova-core/nova-cli/memory";
import { verifyCredentials } from "./verify.js";
import { TabRegistry } from "./tabs.js";
import type { IpcEvent, IpcRequest, NovaSettings, ProviderId } from "./protocol.js";
import { DEFAULT_MODELS } from "./protocol.js";
import { credentialsFor, settingsToEnvironment } from "./settings.js";

type Emit = (event: IpcEvent) => void;

function tokenPricesToCatalog(prices: TokenPrices | undefined, fxRwfPerUsd: number): ModelPriceCatalog {
  if (!prices) {
    return { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
  }
  const microsToMajor = (micros: number) => micros / 1_000_000;
  const inputMajor = microsToMajor(prices.inputPerMillion);
  const outputMajor = microsToMajor(prices.outputPerMillion);
  const cachedMajor = prices.cachedInputPerMillion != null ? microsToMajor(prices.cachedInputPerMillion) : undefined;
  if (prices.currency === "RWF") {
    return {
      inputRwfPerMillionTokens: Math.max(1, Math.round(inputMajor)),
      outputRwfPerMillionTokens: Math.max(1, Math.round(outputMajor)),
      cachedInputRwfPerMillionTokens: cachedMajor != null ? Math.max(0, Math.round(cachedMajor)) : undefined,
    };
  }
  const fx = fxRwfPerUsd > 0 ? fxRwfPerUsd : 1320;
  return {
    inputRwfPerMillionTokens: Math.max(1, Math.round(inputMajor * fx)),
    outputRwfPerMillionTokens: Math.max(1, Math.round(outputMajor * fx)),
    cachedInputRwfPerMillionTokens: cachedMajor != null ? Math.max(0, Math.round(cachedMajor * fx)) : undefined,
  };
}

/**
 * Everything one tab holds — the whole of what used to be the host's own fields.
 *
 * That is the shape of the change: the host had a client, a workspace, a ledger, a mode, a root and
 * a sandbox flag, and every request acted on them implicitly. All six were per-session all along;
 * they were singular only because there was nowhere to put a second set.
 *
 * The ledger being in here rather than shared is the part worth saying out loud: two tabs are two
 * pieces of work with two costs, and one shared ledger would report a refactor's spend against a
 * bug hunt. Anything that genuinely is global — the settings, the daemon — stays on the host.
 */
type TabSlot = {
  client: NovaDaemonClient;
  workspace: NovaWorkspace;
  ledger: CostLedger;
  mode: NovaMode;
  root: string;
  sandbox: boolean;
  title: string;
  model?: string;
  provider?: ProviderId;
  /** True while a turn is in flight here, which is what makes a background tab's spinner honest. */
  running: boolean;
  /**
   * Approvals this tab is waiting on, by request id.
   *
   * Kept per tab because that is the question the window asks — "does this tab need me?" — and
   * because an answer has to reach the client whose session parked it. A single window-wide map
   * would answer the first and lose the second.
   */
  pendingApprovals: Set<string>;
};

export class NovaHost {
  private settings: NovaSettings | null = null;
  private readonly daemon = new NovaSessionDaemon();
  private readonly tabs = new TabRegistry<TabSlot>();

  constructor(private readonly emit: Emit) {}

  /** The tab a request means, or a clear refusal when there is no session to mean. */
  private slot(tabId?: string): TabSlot {
    return this.tabs.resolve(tabId).payload;
  }

  /** Present-but-optional: for the paths that would rather answer "nothing yet" than throw. */
  private maybeSlot(tabId?: string): TabSlot | undefined {
    return this.tabs.find(tabId)?.payload;
  }

  /** How the window draws its strip: one row per tab, in the order they were opened. */
  private listTabs() {
    const activeId = this.tabs.activeId;
    return {
      activeTabId: activeId,
      tabs: this.tabs.list().map((entry) => ({
        tabId: entry.tabId,
        sessionId: entry.sessionId,
        title: entry.payload.title,
        root: entry.payload.root,
        mode: entry.payload.mode,
        sandbox: entry.payload.sandbox,
        model: entry.payload.model,
        provider: entry.payload.provider,
        running: entry.payload.running,
        active: entry.tabId === activeId,
      })),
    };
  }

  /**
   * Ends one tab, leaving the others running.
   *
   * The release is what actually stops the work: a client left connected keeps its session live in
   * the daemon, and a sandboxed tab keeps paying for a remote machine nobody is watching.
   */
  private async closeTab(tabId: string) {
    const { payload, nextActive } = this.tabs.close(tabId);
    payload.running = false;
    await payload.client.release(true);
    payload.client.disconnect();
    void nextActive; // `listTabs` reports the new front tab; naming it twice invites the two to disagree.
    return { closed: tabId, ...this.listTabs() };
  }

  async handle(request: IpcRequest): Promise<unknown> {
    switch (request.type) {
      case "ping":
        return { pong: true };
      case "settings.set":
        this.settings = request.settings;
        return this.describeProviders();
      case "providers.describe":
        return this.describeProviders();
      // Takes the settings in the request rather than the stored ones: this is asked from a form
      // the user is still editing, about values they have not committed yet.
      case "providers.verify":
        return await verifyCredentials(request.settings);
      case "session.open":
        return await this.openSession(request.root, request.mode ?? "build", !!request.sandbox, !!request.upload, request.tabId);
      case "session.scratch":
        return await this.openScratchSession(request.mode ?? "build", request.tabId);
      case "session.list":
        return await listSessions(request.root);
      case "tabs.list":
        return this.listTabs();
      case "tabs.activate":
        this.tabs.activate(request.tabId);
        return this.listTabs();
      case "tabs.close":
        return await this.closeTab(request.tabId);
      case "session.resume":
        return await this.resumeSession(
          request.root,
          request.sessionId,
          request.mode ?? "build",
          !!request.sandbox,
          !!request.upload,
          request.tabId,
        );
      case "memory.list":
        return await this.listMemories(request.tabId);
      case "memory.add":
        return await this.addMemoryEntry(request.scope, request.text, request.kind, request.tabId);
      case "memory.forget":
        return await this.forgetMemoryEntry(request.scope, request.index, request.tabId);
      case "turn.send":
        return await this.sendTurn(request.objective, request.id, request.tabId);
      case "mode.set":
        return await this.setMode(request.mode, request.tabId);
      case "model.set":
        return await this.setModel(request.provider, request.model, request.tabId);
      case "approval.respond":
        return this.respondApproval(request.requestId, request.decision);
      case "undo":
        return await this.undo(request.tabId);
      case "cancel":
        // Cancels only the tab it was asked about. A stop button that reached across tabs would end
        // work the user can see is running somewhere else on screen.
        this.maybeSlot(request.tabId)?.client.cancel();
        return { cancelled: true };
      case "cost.get":
        return this.costSnapshot(request.tabId);
      case "diff.get":
        return { diff: (await this.maybeSlot(request.tabId)?.client.diffStat()) ?? "" };
      case "todos.get":
        return { todos: this.maybeSlot(request.tabId)?.client.todos ?? [] };
      case "files.list":
        // Through the workspace, so a sandboxed session lists the sandbox's files and not this
        // machine's. Read-only and free, like the scan.
        return { files: (await this.maybeSlot(request.tabId)?.client.listFiles(request.pattern)) ?? [] };
      case "files.read":
        // Read-only and free, like `files.list` above, and through the workspace for the same
        // reason: a sandboxed session must show the file the agent is actually working on, which
        // is the sandbox's copy and not this machine's.
        return { file: await this.maybeSlot(request.tabId)?.client.readFile(request.path, request.limit ? { limit: request.limit } : {}) };
      case "scan.secrets":
        // Deterministic and read-only, so it runs without a model turn and without an approval —
        // the same guarantee the `scan_secrets` tool carries, reached directly.
        return { findings: (await this.maybeSlot(request.tabId)?.client.scanSecrets(request.include)) ?? [] };
      case "sandbox.pull":
        return await this.pullSandbox(request.dest, request.tabId);
      case "dispose":
        await this.disposeAgent();
        return { disposed: true };
      default: {
        const _exhaustive: never = request;
        throw new Error(`Unknown request: ${JSON.stringify(_exhaustive)}`);
      }
    }
  }

  private requireSettings(): NovaSettings {
    if (!this.settings?.apiKey.trim()) throw new Error("Configure an API key in Settings first.");
    return this.settings;
  }

  private describeProviders() {
    const settings = this.settings;
    if (!settings) return { providers: [], configured: false };
    const env = settingsToEnvironment(settings);
    return {
      providers: describeProviders(env),
      configured: true,
      active: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl },
    };
  }

  private async resolveModel(settings: NovaSettings, provider?: ProviderId, model?: string) {
    const chosen = provider ?? settings.provider;
    // The flat `apiKey`/`baseUrl` describe whichever provider is selected, so switching provider has
    // to move them too. Leaving them alone is how choosing an Anthropic model used to keep sending
    // the CircuitNotion key — to the CircuitNotion base URL, under Anthropic's name.
    const credentials = credentialsFor(settings, chosen);
    const next: NovaSettings = {
      ...settings,
      provider: chosen,
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      model: model?.trim() || (chosen === settings.provider ? settings.model : "") || DEFAULT_MODELS[chosen],
    };
    const env = settingsToEnvironment(next);
    const resolved = resolveProvider(env, { provider: next.provider, model: next.model });
    if ("error" in resolved) throw new Error(resolved.error);
    return { next, resolved, env };
  }

  private async createWorkspace(root: string, sandbox: boolean, upload: boolean, env: Record<string, string>) {
    if (!sandbox) return new LocalWorkspace(root);
    const provider = createE2BProvider(env);
    if (!provider) throw new Error("Sandbox mode needs E2B_API_KEY (set it in Settings).");
    const session = await provider.createSandbox({
      taskId: `nova-desktop-${Date.now()}`,
      template: "coding",
      maxRuntimeSeconds: 1_800,
    });
    const workspace = new E2BWorkspace({
      sandbox: provider,
      sandboxId: session.sandboxId,
      workspaceRoot: "/workspace/repo",
      onDispose: async (sandboxId) => {
        await provider.stopSandbox(sandboxId);
      },
    });
    if (upload) await uploadProject(workspace, root);
    return workspace;
  }

  /**
   * Builds a session and puts it in a tab — a new one, or in place of what a named tab held.
   *
   * The line this replaces was `await this.disposeAgent()`: opening anything used to begin by
   * destroying whatever was open, which is the entire reason the window could hold one piece of work.
   * Now only the named tab's own previous session is released, and only after the new one is built,
   * so a failure to open leaves the tab with the session it already had rather than with nothing.
   */
  private async buildAgent(root: string, mode: NovaMode, sandbox: boolean, upload: boolean, record?: SessionRecord, tabId?: string) {
    const settings = this.requireSettings();
    const { next, resolved, env } = await this.resolveModel(settings);
    this.settings = next;

    const workspace = await this.createWorkspace(root, sandbox, upload, env);
    const catalog = tokenPricesToCatalog(resolved.prices, settings.fxRwfPerUsd ?? 1320);
    const display = settings.currency?.trim() || "RWF";
    const rates =
      settings.fxRwfPerUsd && settings.fxRwfPerUsd > 0
        ? [
            {
              from: "USD",
              to: "RWF",
              rate: settings.fxRwfPerUsd,
              asOf: new Date().toISOString().slice(0, 10),
              source: "settings",
            },
          ]
        : [];
    const budget = settings.budget != null && settings.budget > 0 ? fromUnits(settings.budget, display) : undefined;
    const ledger = new CostLedger({ prices: resolved.prices, display, rates, budget });

    /**
     * Rebuilding the session a tab is already holding — a model or mode change — has to retire the
     * old one *first*.
     *
     * The daemon keys live sessions by id, and a resumed agent keeps the id of the record it
     * resumed. So asking it to open a record whose session is still live takes its "already open"
     * path: it returns the existing session and never calls the factory, which means the new model
     * or mode is silently not applied. Worse, the release that used to follow then disposed that
     * session — the one the tab had just been pointed at — so every later request answered "Session
     * is not active in this daemon" and the tab was dead until reopened.
     *
     * Retiring first costs the ordering this code otherwise protects (a tab holding nothing while a
     * sandbox boots), and that protection is still what happens for every other rebuild: this only
     * applies when the new session *is* the old one.
     */
    const priorEntry = tabId ? this.tabs.find(tabId) : undefined;
    const retiredFirst = record && priorEntry?.sessionId === record.id ? priorEntry.payload : undefined;
    if (retiredFirst) await this.retireSlot(retiredFirst);

    // One daemon client per tab, each with its own subscription. Two tabs sharing a client would
    // share its notification stream, and a `NovaDaemonClient` holds one active session anyway —
    // `sessionId` on it is a single value, so a second session in the same client would have
    // silently redirected every later request onto whichever opened last.
    const client = this.daemon.connect({
      id: `desktop_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      onNotification: (notification) => this.forwardDaemonNotification(notification),
    });
    const opened = await client.open(({ onEvent, approve }) => new NovaAgent({
      root,
      model: resolved.provider,
      prices: catalog,
      mode,
      workspace,
      approve,
      onEvent,
      budgets: {
        // Raised from the default: a run that takes several actions to finish one request was
        // aborting mid-way, which reads as the app giving up rather than as a cap being hit.
        maxToolCallsPerTurn: 16,
        ...(budget && settings.budget
          ? { maxRwf: Math.max(1, Math.round(settings.budget * (settings.fxRwfPerUsd ?? 1320))) }
          : {}),
      },
    }), record);
    const slot: TabSlot = {
      client,
      workspace,
      ledger,
      mode,
      root,
      sandbox,
      title: titleFor(root),
      model: resolved.model,
      // Narrowed to the ids the desktop's own settings can express: agent-core resolves a wider set
      // (Ollama and friends) than this window offers, and a tab records what it can round-trip.
      provider: (["circuitnotion", "openai", "anthropic"] as const).find((id) => id === resolved.spec.id),
      running: false,
      pendingApprovals: new Set<string>(),
    };

    // Into the tab that asked, or a new one. Replacing returns the session that was there, which is
    // released *after* the new one is live: releasing first would leave a tab holding nothing at all
    // for as long as a sandbox takes to start, and holding nothing if it failed to.
    const existing = tabId ? this.tabs.find(tabId) : undefined;
    const entry = existing
      ? { tabId: existing.tabId, previous: this.tabs.replace(existing.tabId, opened.sessionId, slot) }
      : { tabId: this.tabs.add(opened.sessionId, slot).tabId, previous: undefined };
    // Skipped when it was already retired above, so nothing is released twice.
    if (entry.previous && entry.previous !== retiredFirst) await this.retireSlot(entry.previous);

    return {
      tabId: entry.tabId,
      sessionId: opened.sessionId,
      root,
      mode,
      sandbox,
      workspace: opened.workspaceLabel,
      model: resolved.model,
      provider: resolved.spec.id,
      title: slot.title,
    };
  }

  /**
   * The root memory is filed against.
   *
   * Falls back to the scratch directory when no project is open, so a fact learned during a
   * scratch chat still lands somewhere real rather than being silently dropped — and lands in the
   * same place the next scratch chat will read it from.
   */
  private memoryRoot(tabId?: string): string {
    // The *tab's* project, not the window's: two tabs on two projects have two project memories, and
    // filing a fact learned in one against the other is a quiet way to corrupt both.
    return this.maybeSlot(tabId)?.root ?? path.join(os.homedir(), ".nova", "scratch");
  }

  private async listMemories(tabId?: string) {
    const root = this.memoryRoot(tabId);
    const entries = await loadMemories(root, process.env);
    return {
      entries,
      files: {
        project: memoryFile("project", root, process.env),
        user: memoryFile("user", root, process.env),
      },
    };
  }

  private async addMemoryEntry(scope: MemoryScope, text: string, kind?: string, tabId?: string) {
    const root = this.memoryRoot(tabId);
    const result = await addMemory(scope, text, root, process.env, { kind: (kind ?? "fact") as MemoryKind });
    return { file: result.file, changed: result.changed, entries: await loadMemories(root, process.env) };
  }

  private async forgetMemoryEntry(scope: MemoryScope, index: number, tabId?: string) {
    const root = this.memoryRoot(tabId);
    const result = await forgetMemory(scope, index, root, process.env);
    return { file: result.file, changed: result.changed, entries: await loadMemories(root, process.env) };
  }

  /** Ends a session a tab is no longer holding, releasing its agent and its workspace with it. */
  private async retireSlot(slot: TabSlot): Promise<void> {
    slot.running = false;
    await slot.client.release(true).catch(() => undefined);
    slot.client.disconnect();
  }

  private async openSession(root: string, mode: NovaMode, sandbox: boolean, upload: boolean, tabId?: string) {
    return await this.buildAgent(path.resolve(root), mode, sandbox, upload, undefined, tabId);
  }

  /**
   * A session with nowhere in particular to work.
   *
   * Chatting is not the same act as working on a project, and requiring a project folder before the
   * first question could be asked made the app refuse the thing people open it to do — "how do I
   * write this migration" needs no repository. But `NovaAgent` genuinely needs a root: it keeps
   * checkpoints, session transcripts and a workspace there, and a null root would mean teaching all
   * three to handle a case that only exists to avoid asking a question.
   *
   * So the answer is a real directory rather than no directory — a scratch folder under `.nova`,
   * created on demand. Every tool works normally, files land somewhere findable, and opening a
   * project later is an ordinary session switch rather than a change of mode.
   */
  private async openScratchSession(mode: NovaMode, tabId?: string) {
    const scratch = path.join(os.homedir(), ".nova", "scratch");
    await fs.mkdir(scratch, { recursive: true });
    // Never sandboxed: a scratch session is a conversation, and paying for a remote sandbox to hold
    // a directory nobody asked for is a cost with no matching benefit.
    return { ...(await this.buildAgent(scratch, mode, false, false, undefined, tabId)), scratch: true };
  }

  private async resumeSession(root: string, sessionId: string, mode: NovaMode, sandbox: boolean, upload: boolean, tabId?: string) {
    const resolvedRoot = path.resolve(root);
    const record = await loadSession(resolvedRoot, sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found.`);
    const opened = await this.buildAgent(resolvedRoot, mode, sandbox, upload, record, tabId);
    return { ...opened, title: record.title, resumed: true };
  }

  /**
   * Switching mode rebuilds the agent, in place, in its own tab.
   *
   * Rebuilt because mode is baked into the agent's permission posture at construction; in place
   * because the tab is the thing the user is looking at, and a mode switch that opened a tenth tab
   * would be a surprising way to answer "make this one read-only".
   */
  private async setMode(mode: NovaMode, tabId?: string) {
    const entry = this.tabs.resolve(tabId);
    const slot = entry.payload;
    const loaded = await loadSession(slot.root, entry.sessionId);
    const opened = await this.buildAgent(slot.root, mode, slot.sandbox, false, loaded ?? undefined, entry.tabId);
    return { ...opened, mode };
  }

  private async setModel(provider: ProviderId | undefined, model: string, tabId?: string) {
    if (!this.settings) throw new Error("Configure Settings first.");
    const { next, resolved } = await this.resolveModel(this.settings, provider, model);
    this.settings = next;
    const entry = this.tabs.find(tabId);
    // No session open yet is not a failure here: the choice is settings, and it applies to the next
    // session opened. Only a tab that exists gets rebuilt onto the new model.
    if (!entry) return { provider: resolved.spec.id, model: resolved.model };
    const slot = entry.payload;
    const loaded = await loadSession(slot.root, entry.sessionId);
    const opened = await this.buildAgent(slot.root, slot.mode, slot.sandbox, false, loaded ?? undefined, entry.tabId);
    return { ...opened, provider: resolved.spec.id, model: resolved.model };
  }

  /**
   * Answers an approval.
   *
   * The request id is looked up across *every* tab rather than routed through the active one,
   * because the tab a decision belongs to is not necessarily the tab in front: a background tab can
   * park an approval, and the person answering it may well have moved on before they do. The daemon
   * still binds the decision to that request's own action digest, so a stale id authorises nothing.
   */
  private respondApproval(requestId: string, decision: PermissionDecision) {
    const owner = this.tabs.list().find((entry) => entry.payload.pendingApprovals.has(requestId));
    const client = owner?.payload.client ?? this.maybeSlot()?.client;
    if (!client) throw new Error("Open a project session first.");
    client.decideApproval(requestId, decision);
    owner?.payload.pendingApprovals.delete(requestId);
    return { accepted: true };
  }

  /**
   * Every session event, stamped with the tab it belongs to.
   *
   * The stamp comes from the daemon's own `sessionId`, not from whichever tab happens to be in
   * front. That distinction is the whole of correct routing: with two turns streaming at once, "the
   * active tab" is the wrong answer roughly half the time, and being wrong here means one tab's
   * answer appearing in another tab's transcript with nothing to indicate it.
   */
  private forwardDaemonNotification(notification: DaemonNotification) {
    const entry = this.tabs.bySession(notification.sessionId);
    // An event from a session that has already been closed has nowhere to go. Dropping it is right:
    // filing it under some other tab would be inventing a place for it.
    if (!entry) return;
    const tag = { tabId: entry.tabId, sessionId: notification.sessionId };
    if (notification.type === "agent_event") {
      this.forwardNovaEvent(notification.event, tag);
    } else if (notification.type === "approval_requested") {
      entry.payload.pendingApprovals.add(notification.request.id);
      this.emit({
        ...tag,
        type: "approval_needed",
        requestId: notification.request.id,
        toolCallId: notification.request.toolCallId,
        toolName: notification.request.toolName,
        summary: notification.request.summary,
        actionDigest: notification.request.actionDigest,
        scopeKey: notification.request.scopeKey,
      });
    }
  }

  private forwardNovaEvent(event: NovaEvent, tag: { tabId: string; sessionId: string }) {
    if (event.type === "checkpoint") {
      this.emit({ ...tag, type: "checkpoint", id: event.checkpoint.tree, label: event.checkpoint.label });
      return;
    }
    if (event.type !== "runtime") return;
    const runtime = event.event;
    if (runtime.type === "assistant_delta") {
      this.emit({ ...tag, type: "assistant_delta", text: runtime.text });
    } else if (runtime.type === "tool_call") {
      this.emit({
        ...tag,
        type: "tool_call",
        toolCallId: runtime.toolCallId,
        name: runtime.toolName,
      });
    } else if (runtime.type === "tool_result") {
      this.emit({
        ...tag,
        type: "tool_result",
        toolCallId: runtime.toolCallId,
        name: runtime.toolName,
        ok: !runtime.isError,
        preview: runtime.content.slice(0, 400),
      });
    }
  }

  /**
   * Runs a turn in one tab.
   *
   * Nothing here awaits any other tab: `NovaSessionDaemon` serialises turns *per session* (each live
   * session has its own `tail` promise), so two tabs sending at once genuinely run at once. That is
   * what makes these tabs parallel rather than merely separate, and it is a property of the daemon
   * this file inherited rather than one it had to build.
   */
  private async sendTurn(objective: string, commandId: string, tabId?: string) {
    const entry = this.tabs.resolve(tabId);
    const slot = entry.payload;
    const tag = { tabId: entry.tabId, sessionId: entry.sessionId };
    if (slot.ledger.exhausted) {
      throw new Error("Session budget exhausted. Raise the budget in Settings or start a new session.");
    }
    slot.running = true;
    this.emit({ ...tag, type: "turn_status", status: "running" });
    const started = Date.now();
    try {
      const result = await slot.client.send(objective, commandId);
      {
        const turn = slot.ledger.record({
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCallsExecuted,
          elapsedMs: Date.now() - started,
        });
        this.emit({
          ...tag,
          type: "cost",
          report: slot.ledger.formatTurn(turn),
          displayTotal: slot.ledger.displayTotal ? formatMoney(slot.ledger.displayTotal) : undefined,
          budgetFraction: slot.ledger.budgetFraction,
        });
        // The cap is this tab's remaining budget, held against this tab's own client. Sharing one
        // limit across tabs would let a cheap tab's spend cut short an expensive tab's turn.
        if (slot.ledger.displayTotal && this.settings?.budget) {
          const remainingMajor = this.settings.budget - slot.ledger.displayTotal.micros / 1_000_000;
          if (remainingMajor > 0) {
            const remainingRwf = Math.max(1, Math.round(remainingMajor * (this.settings.fxRwfPerUsd ?? 1320)));
            slot.client.setModelSpendLimit(remainingRwf);
          } else {
            slot.client.setModelSpendLimit(0);
          }
        }
      }
      this.emit({ ...tag, type: "turn_status", status: result.status, summary: result.summary });
      return {
        status: result.status,
        summary: result.summary,
        tabId: entry.tabId,
        sessionId: entry.sessionId,
        iterations: result.iterations,
        toolCallsExecuted: result.toolCallsExecuted,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ ...tag, type: "error", message });
      this.emit({ ...tag, type: "turn_status", status: "failed", summary: message });
      throw error;
    } finally {
      // In `finally` so a thrown turn cannot leave a tab claiming to be busy for the rest of the
      // session — a spinner that never stops is indistinguishable from work that never finishes.
      slot.running = false;
    }
  }

  private async undo(tabId?: string) {
    const checkpoint = await this.slot(tabId).client.undo();
    return { undone: !!checkpoint, checkpoint };
  }

  private costSnapshot(tabId?: string) {
    const slot = this.maybeSlot(tabId);
    if (!slot) return { report: "No cost data yet.", priced: false };
    return {
      report: slot.ledger.formatReport(),
      priced: slot.ledger.priced,
      displayTotal: slot.ledger.displayTotal ? formatMoney(slot.ledger.displayTotal) : undefined,
      budgetFraction: slot.ledger.budgetFraction,
      warning: slot.ledger.budgetWarning(),
      exhausted: slot.ledger.exhausted,
      /**
       * Per turn, for the charts.
       *
       * The ledger has always kept this; the window only ever asked for the formatted paragraph,
       * so "which turn cost that much" — the one question a running total cannot answer — had no
       * answer here. Money is sent as a number plus its currency rather than pre-formatted, because
       * a chart has to compare values and cannot compare "RWF 1,610".
       */
      turns: slot.ledger.history.map((turn) => ({
        turnNumber: turn.turnNumber,
        cost: turn.cost ? { micros: turn.cost.micros, currency: turn.cost.currency } : undefined,
        display: turn.cost ? formatMoney(turn.cost) : undefined,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
        cachedInputTokens: turn.usage.cachedInputTokens,
        toolCalls: turn.toolCalls,
        iterations: turn.iterations,
        elapsedMs: turn.elapsedMs,
      })),
    };
  }

  private async pullSandbox(dest?: string, tabId?: string) {
    const slot = this.slot(tabId);
    if (slot.workspace.kind !== "e2b") throw new Error("Current session is not a sandbox.");
    const target = path.resolve(dest?.trim() || path.join(slot.root, "nova-pull"));
    await downloadProject(slot.workspace, target);
    return { dest: target };
  }

  /** Shutdown: every tab, not just the one in front — each holds a live session of its own. */
  private async disposeAgent() {
    for (const slot of this.tabs.drain()) {
      slot.running = false;
      await slot.client.release(true).catch(() => undefined);
      slot.client.disconnect();
    }
  }
}

/**
 * A tab's name: the folder it works in.
 *
 * The last path segment, because that is the part people recognise and the part that differs — a
 * strip reading `circuit-agent`, `nova-docs`, `scratch` says what each tab is for, while one reading
 * three truncated absolute paths that share a prefix says nothing at all.
 */
function titleFor(root: string): string {
  return path.basename(root) || root;
}
