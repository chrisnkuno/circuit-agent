import path from "node:path";
import { CostLedger, E2BWorkspace, LocalWorkspace, NovaAgent, describeProviders, downloadProject, fromUnits, formatMoney, listSessions, loadSession, resolveProvider, uploadProject, } from "@circuit-nova/nova-core";
import { createE2BProvider } from "@circuit-nova/nova-core/providers/factory";
import { DEFAULT_MODELS } from "./protocol.js";
import { settingsToEnvironment } from "./settings.js";
function tokenPricesToCatalog(prices, fxRwfPerUsd) {
    if (!prices) {
        return { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
    }
    const microsToMajor = (micros) => micros / 1_000_000;
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
    emit;
    settings = null;
    agent = null;
    workspace = null;
    ledger = null;
    mode = "build";
    root = null;
    sandbox = false;
    pendingApprovals = new Map();
    approvalSeq = 0;
    turnBusy = false;
    constructor(emit) {
        this.emit = emit;
    }
    async handle(request) {
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
                return await this.resumeSession(request.root, request.sessionId, request.mode ?? "build", !!request.sandbox, !!request.upload);
            case "turn.send":
                return await this.sendTurn(request.objective);
            case "mode.set":
                return await this.setMode(request.mode);
            case "model.set":
                return await this.setModel(request.provider, request.model);
            case "approval.respond":
                return this.respondApproval(request.requestId, request.decision);
            case "undo":
                return await this.undo();
            case "cancel":
                this.agent?.cancel();
                return { cancelled: true };
            case "cost.get":
                return this.costSnapshot();
            case "diff.get":
                return { diff: (await this.agent?.diffStat()) ?? "" };
            case "todos.get":
                return { todos: this.agent?.todos ?? [] };
            case "sandbox.pull":
                return await this.pullSandbox(request.dest);
            case "dispose":
                await this.disposeAgent();
                return { disposed: true };
            default: {
                const _exhaustive = request;
                throw new Error(`Unknown request: ${JSON.stringify(_exhaustive)}`);
            }
        }
    }
    requireSettings() {
        if (!this.settings?.apiKey.trim())
            throw new Error("Configure an API key in Settings first.");
        return this.settings;
    }
    describeProviders() {
        const settings = this.settings;
        if (!settings)
            return { providers: [], configured: false };
        const env = settingsToEnvironment(settings);
        return {
            providers: describeProviders(env),
            configured: true,
            active: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl },
        };
    }
    async resolveModel(settings: any, provider?: any, model?: any) {
        const next = {
            ...settings,
            provider: provider ?? settings.provider,
            model: model?.trim() || settings.model || DEFAULT_MODELS[provider ?? settings.provider],
        };
        const env = settingsToEnvironment(next);
        const resolved = resolveProvider(env, { provider: next.provider, model: next.model });
        if ("error" in resolved)
            throw new Error(resolved.error);
        return { next, resolved, env };
    }
    async createWorkspace(root, sandbox, upload, env) {
        if (!sandbox)
            return new LocalWorkspace(root);
        const provider = createE2BProvider(env);
        if (!provider)
            throw new Error("Sandbox mode needs E2B_API_KEY (set it in Settings).");
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
        if (upload)
            await uploadProject(workspace, root);
        return workspace;
    }
    async buildAgent(root, mode, sandbox, upload) {
        const settings = this.requireSettings();
        const { next, resolved, env } = await this.resolveModel(settings);
        this.settings = next;
        await this.disposeAgent();
        const workspace = await this.createWorkspace(root, sandbox, upload, env);
        this.workspace = workspace;
        const catalog = tokenPricesToCatalog(resolved.prices, settings.fxRwfPerUsd ?? 1320);
        const display = settings.currency?.trim() || "RWF";
        const rates = settings.fxRwfPerUsd && settings.fxRwfPerUsd > 0
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
        this.agent = new NovaAgent({
            root,
            model: resolved.provider,
            prices: catalog,
            mode,
            workspace,
            approve: (request: any) => this.promptApproval(request) as Promise<any>,
            onEvent: (event: any) => this.forwardNovaEvent(event),
            budgets: budget && settings.budget
                ? { maxRwf: Math.max(1, Math.round(settings.budget * (settings.fxRwfPerUsd ?? 1320))) }
                : undefined,
        });
        this.root = root;
        this.mode = mode;
        this.sandbox = sandbox;
        return {
            sessionId: this.agent.sessionId,
            root,
            mode,
            sandbox,
            workspace: this.agent.workspaceLabel,
            model: resolved.model,
            provider: resolved.spec.id,
        };
    }
    async openSession(root, mode, sandbox, upload) {
        return await this.buildAgent(path.resolve(root), mode, sandbox, upload);
    }
    async resumeSession(root, sessionId, mode, sandbox, upload) {
        const resolvedRoot = path.resolve(root);
        const record = await loadSession(resolvedRoot, sessionId);
        if (!record)
            throw new Error(`Session ${sessionId} not found.`);
        const opened = await this.buildAgent(resolvedRoot, mode, sandbox, upload);
        this.agent.resume(record);
        return { ...opened, sessionId: record.id, title: record.title, resumed: true };
    }
    async setMode(mode) {
        if (!this.agent || !this.root)
            throw new Error("Open a project session first.");
        const sessionId = this.agent.sessionId;
        const loaded = await loadSession(this.root, sessionId);
        const opened = await this.buildAgent(this.root, mode, this.sandbox, false);
        if (loaded)
            this.agent.resume(loaded);
        return { ...opened, mode };
    }
    async setModel(provider, model) {
        if (!this.settings)
            throw new Error("Configure Settings first.");
        const { next, resolved } = await this.resolveModel(this.settings, provider, model);
        this.settings = next;
        if (!this.agent || !this.root) {
            return { provider: resolved.spec.id, model: resolved.model };
        }
        const sessionId = this.agent.sessionId;
        const loaded = await loadSession(this.root, sessionId);
        const opened = await this.buildAgent(this.root, this.mode, this.sandbox, false);
        if (loaded)
            this.agent.resume(loaded);
        return { ...opened, provider: resolved.spec.id, model: resolved.model };
    }
    promptApproval(request) {
        const requestId = `apr_${++this.approvalSeq}`;
        return new Promise((resolve) => {
            this.pendingApprovals.set(requestId, { requestId, resolve });
            this.emit({
                type: "approval_needed",
                requestId,
                toolCallId: request.call.id,
                toolName: request.tool.name,
                summary: request.summary,
                actionDigest: request.actionDigest,
                scopeKey: request.scopeKey,
            });
        });
    }
    respondApproval(requestId, decision) {
        const pending = this.pendingApprovals.get(requestId);
        if (!pending)
            throw new Error(`Unknown approval request ${requestId}`);
        this.pendingApprovals.delete(requestId);
        pending.resolve(decision);
        return { accepted: true };
    }
    forwardNovaEvent(event) {
        if (event.type === "checkpoint") {
            this.emit({ type: "checkpoint", id: event.checkpoint.tree, label: event.checkpoint.label });
            return;
        }
        if (event.type !== "runtime")
            return;
        const runtime = event.event;
        if (runtime.type === "assistant_delta") {
            this.emit({ type: "assistant_delta", text: runtime.text });
        }
        else if (runtime.type === "tool_call") {
            this.emit({
                type: "tool_call",
                toolCallId: runtime.toolCallId,
                name: runtime.toolName,
            });
        }
        else if (runtime.type === "tool_result") {
            this.emit({
                type: "tool_result",
                toolCallId: runtime.toolCallId,
                name: runtime.toolName,
                ok: !runtime.isError,
                preview: runtime.content.slice(0, 400),
            });
        }
    }
    async sendTurn(objective) {
        if (!this.agent)
            throw new Error("Open a project session first.");
        if (this.turnBusy)
            throw new Error("A turn is already running.");
        if (this.ledger?.exhausted) {
            throw new Error("Session budget exhausted. Raise the budget in Settings or start a new session.");
        }
        this.turnBusy = true;
        this.emit({ type: "turn_status", status: "running" });
        const started = Date.now();
        try {
            const result = await this.agent.send(objective);
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
                        this.agent.setModelSpendLimit(remainingRwf);
                    }
                    else {
                        this.agent.setModelSpendLimit(0);
                    }
                }
            }
            this.emit({ type: "turn_status", status: result.status, summary: result.summary });
            return {
                status: result.status,
                summary: result.summary,
                sessionId: this.agent.sessionId,
                iterations: result.iterations,
                toolCallsExecuted: result.toolCallsExecuted,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.emit({ type: "error", message });
            this.emit({ type: "turn_status", status: "failed", summary: message });
            throw error;
        }
        finally {
            this.turnBusy = false;
        }
    }
    async undo() {
        if (!this.agent)
            throw new Error("Open a project session first.");
        const checkpoint = await this.agent.undo();
        return { undone: !!checkpoint, checkpoint };
    }
    costSnapshot() {
        if (!this.ledger)
            return { report: "No cost data yet.", priced: false };
        return {
            report: this.ledger.formatReport(),
            priced: this.ledger.priced,
            displayTotal: this.ledger.displayTotal ? formatMoney(this.ledger.displayTotal) : undefined,
            budgetFraction: this.ledger.budgetFraction,
            warning: this.ledger.budgetWarning(),
            exhausted: this.ledger.exhausted,
        };
    }
    async pullSandbox(dest) {
        if (!this.agent || !this.root || !this.workspace)
            throw new Error("Open a project session first.");
        if (this.workspace.kind !== "e2b")
            throw new Error("Current session is not a sandbox.");
        const target = path.resolve(dest?.trim() || path.join(this.root, "nova-pull"));
        await downloadProject(this.workspace, target);
        return { dest: target };
    }
    async disposeAgent() {
        for (const pending of this.pendingApprovals.values())
            pending.resolve("deny");
        this.pendingApprovals.clear();
        if (this.agent) {
            await this.agent.dispose();
            this.agent = null;
        }
        this.workspace = null;
        this.ledger = null;
    }
}
