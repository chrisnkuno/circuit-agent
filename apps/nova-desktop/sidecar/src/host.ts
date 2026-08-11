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
import type { IpcEvent, IpcRequest, NovaSettings, ProviderId } from "./protocol.js";
import { DEFAULT_MODELS } from "./protocol.js";
import { settingsToEnvironment } from "./settings.js";

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

export class NovaHost {
  private settings: NovaSettings | null = null;
  private readonly daemon = new NovaSessionDaemon();
  private client: NovaDaemonClient | null = null;
  private workspace: NovaWorkspace | null = null;
  private ledger: CostLedger | null = null;
  private mode: NovaMode = "build";
  private root: string | null = null;
  private sandbox = false;

  constructor(private readonly emit: Emit) {}

  async handle(request: IpcRequest): Promise<unknown> {
    switch (request.type) {
      case "ping":
        return { pong: true };
      case "settings.set":
        this.settings = request.settings;
        return this.describeProviders();
      case "providers.describe":
        return this.describeProviders();
      case "session.open":
        return await this.openSession(request.root, request.mode ?? "build", !!request.sandbox, !!request.upload);
      case "session.list":
        return await listSessions(request.root);
      case "session.resume":
        return await this.resumeSession(
          request.root,
          request.sessionId,
          request.mode ?? "build",
          !!request.sandbox,
          !!request.upload,
        );
      case "turn.send":
        return await this.sendTurn(request.objective, request.id);
      case "mode.set":
        return await this.setMode(request.mode);
      case "model.set":
        return await this.setModel(request.provider, request.model);
      case "approval.respond":
        return this.respondApproval(request.requestId, request.decision);
      case "undo":
        return await this.undo();
      case "cancel":
        this.client?.cancel();
        return { cancelled: true };
      case "cost.get":
        return this.costSnapshot();
      case "diff.get":
        return { diff: (await this.client?.diffStat()) ?? "" };
      case "todos.get":
        return { todos: this.client?.todos ?? [] };
      case "sandbox.pull":
        return await this.pullSandbox(request.dest);
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
    const next: NovaSettings = {
      ...settings,
      provider: provider ?? settings.provider,
      model: model?.trim() || settings.model || DEFAULT_MODELS[provider ?? settings.provider],
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

  private async buildAgent(root: string, mode: NovaMode, sandbox: boolean, upload: boolean, record?: SessionRecord) {
    const settings = this.requireSettings();
    const { next, resolved, env } = await this.resolveModel(settings);
    this.settings = next;
    await this.disposeAgent();

    const workspace = await this.createWorkspace(root, sandbox, upload, env);
    this.workspace = workspace;
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
    this.ledger = new CostLedger({ prices: resolved.prices, display, rates, budget });

    this.client = this.daemon.connect({
      id: `desktop_${Date.now()}`,
      onNotification: (notification) => this.forwardDaemonNotification(notification),
    });
    const opened = await this.client.open(({ onEvent, approve }) => new NovaAgent({
      root,
      model: resolved.provider,
      prices: catalog,
      mode,
      workspace,
      approve,
      onEvent,
      budgets: budget && settings.budget
        ? { maxRwf: Math.max(1, Math.round(settings.budget * (settings.fxRwfPerUsd ?? 1320))) }
        : undefined,
    }), record);
    this.root = root;
    this.mode = mode;
    this.sandbox = sandbox;
    return {
      sessionId: opened.sessionId,
      root,
      mode,
      sandbox,
      workspace: opened.workspaceLabel,
      model: resolved.model,
      provider: resolved.spec.id,
    };
  }

  private async openSession(root: string, mode: NovaMode, sandbox: boolean, upload: boolean) {
    return await this.buildAgent(path.resolve(root), mode, sandbox, upload);
  }

  private async resumeSession(root: string, sessionId: string, mode: NovaMode, sandbox: boolean, upload: boolean) {
    const resolvedRoot = path.resolve(root);
    const record = await loadSession(resolvedRoot, sessionId);
    if (!record) throw new Error(`Session ${sessionId} not found.`);
    const opened = await this.buildAgent(resolvedRoot, mode, sandbox, upload, record);
    return { ...opened, title: record.title, resumed: true };
  }

  private async setMode(mode: NovaMode) {
    if (!this.client || !this.root) throw new Error("Open a project session first.");
    const sessionId = this.client.sessionId;
    const loaded = await loadSession(this.root, sessionId);
    const opened = await this.buildAgent(this.root, mode, this.sandbox, false, loaded ?? undefined);
    return { ...opened, mode };
  }

  private async setModel(provider: ProviderId | undefined, model: string) {
    if (!this.settings) throw new Error("Configure Settings first.");
    const { next, resolved } = await this.resolveModel(this.settings, provider, model);
    this.settings = next;
    if (!this.client || !this.root) {
      return { provider: resolved.spec.id, model: resolved.model };
    }
    const sessionId = this.client.sessionId;
    const loaded = await loadSession(this.root, sessionId);
    const opened = await this.buildAgent(this.root, this.mode, this.sandbox, false, loaded ?? undefined);
    return { ...opened, provider: resolved.spec.id, model: resolved.model };
  }

  private respondApproval(requestId: string, decision: PermissionDecision) {
    if (!this.client) throw new Error("Open a project session first.");
    this.client.decideApproval(requestId, decision);
    return { accepted: true };
  }

  private forwardDaemonNotification(notification: DaemonNotification) {
    if (notification.type === "agent_event") {
      this.forwardNovaEvent(notification.event);
    } else if (notification.type === "approval_requested") {
      this.emit({
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

  private forwardNovaEvent(event: NovaEvent) {
    if (event.type === "checkpoint") {
      this.emit({ type: "checkpoint", id: event.checkpoint.tree, label: event.checkpoint.label });
      return;
    }
    if (event.type !== "runtime") return;
    const runtime = event.event;
    if (runtime.type === "assistant_delta") {
      this.emit({ type: "assistant_delta", text: runtime.text });
    } else if (runtime.type === "tool_call") {
      this.emit({
        type: "tool_call",
        toolCallId: runtime.toolCallId,
        name: runtime.toolName,
      });
    } else if (runtime.type === "tool_result") {
      this.emit({
        type: "tool_result",
        toolCallId: runtime.toolCallId,
        name: runtime.toolName,
        ok: !runtime.isError,
        preview: runtime.content.slice(0, 400),
      });
    }
  }

  private async sendTurn(objective: string, commandId: string) {
    if (!this.client) throw new Error("Open a project session first.");
    if (this.ledger?.exhausted) {
      throw new Error("Session budget exhausted. Raise the budget in Settings or start a new session.");
    }
    this.emit({ type: "turn_status", status: "running" });
    const started = Date.now();
    try {
      const result = await this.client.send(objective, commandId);
      if (this.ledger) {
        const turn = this.ledger.record({
          usage: result.usage,
          iterations: result.iterations,
          toolCalls: result.toolCallsExecuted,
          elapsedMs: Date.now() - started,
        });
        this.emit({
          type: "cost",
          report: this.ledger.formatTurn(turn),
          displayTotal: this.ledger.displayTotal ? formatMoney(this.ledger.displayTotal) : undefined,
          budgetFraction: this.ledger.budgetFraction,
        });
        if (this.ledger.displayTotal && this.settings?.budget) {
          const remainingMajor = this.settings.budget - this.ledger.displayTotal.micros / 1_000_000;
          if (remainingMajor > 0) {
            const remainingRwf = Math.max(1, Math.round(remainingMajor * (this.settings.fxRwfPerUsd ?? 1320)));
            this.client.setModelSpendLimit(remainingRwf);
          } else {
            this.client.setModelSpendLimit(0);
          }
        }
      }
      this.emit({ type: "turn_status", status: result.status, summary: result.summary });
      return {
        status: result.status,
        summary: result.summary,
        sessionId: this.client.sessionId,
        iterations: result.iterations,
        toolCallsExecuted: result.toolCallsExecuted,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.emit({ type: "error", message });
      this.emit({ type: "turn_status", status: "failed", summary: message });
      throw error;
    }
  }

  private async undo() {
    if (!this.client) throw new Error("Open a project session first.");
    const checkpoint = await this.client.undo();
    return { undone: !!checkpoint, checkpoint };
  }

  private costSnapshot() {
    if (!this.ledger) return { report: "No cost data yet.", priced: false };
    return {
      report: this.ledger.formatReport(),
      priced: this.ledger.priced,
      displayTotal: this.ledger.displayTotal ? formatMoney(this.ledger.displayTotal) : undefined,
      budgetFraction: this.ledger.budgetFraction,
      warning: this.ledger.budgetWarning(),
      exhausted: this.ledger.exhausted,
    };
  }

  private async pullSandbox(dest?: string) {
    if (!this.client || !this.root || !this.workspace) throw new Error("Open a project session first.");
    if (this.workspace.kind !== "e2b") throw new Error("Current session is not a sandbox.");
    const target = path.resolve(dest?.trim() || path.join(this.root, "nova-pull"));
    await downloadProject(this.workspace, target);
    return { dest: target };
  }

  private async disposeAgent() {
    if (this.client) {
      await this.client.release(true);
      this.client.disconnect();
      this.client = null;
    }
    this.workspace = null;
    this.ledger = null;
  }
}
