import { randomUUID } from "node:crypto";
import type { AgentRuntimeResult } from "../agent-runtime";
import type { NovaAgent, NovaEvent, NovaTurnResult, RestoreScope } from "./agent";
import type { NovaWorkspace } from "./backends";
import type { AgentCostPrediction } from "./cost";
import type { Checkpoint } from "./checkpoints";
import type { ApprovalPrompt, ApprovalRequest, PermissionDecision } from "./permissions";
import type { SafetyAssessment } from "./safety";
import type { SessionRecord } from "./session";
import type { PlacedSecretFinding, TodoItem } from "./tools";
import type { ReadResult } from "./workspace";

/** Protocol version for the app-server commands and notifications, independent of journal schema. */
export const NOVA_DAEMON_PROTOCOL_VERSION = 1 as const;

export type DaemonApprovalRequest = {
  id: string;
  sessionId: string;
  summary: string;
  actionDigest: string;
  scopeKey: string;
  policyVersion: string;
  toolCallId: string;
  toolName: string;
  effect: ApprovalRequest["tool"]["effect"];
  capabilityId: string;
  /**
   * Why auto mode did not silently approve this, when it didn't.
   *
   * Carried through so a client's approval UI can show the same "sensitive action" warning the
   * in-process prompt already does — dropping it here would be a client rebuilt on the daemon
   * silently losing a safety signal the original terminal prompt always showed.
   */
  safety: SafetyAssessment;
  /**
   * Exactly what a pending `write_file`/`edit_file` would change, so a client can show the real
   * diff before answering rather than just the one-line summary. Scoped to these two tools only —
   * not a raw copy of `call.arguments` — the same reason `safety` above is a purpose-built field
   * rather than the whole `ApprovalRequest` forwarded wholesale: this boundary is a stable, minimal
   * contract, not a leak of whatever shape an internal type happens to have this month.
   */
  preview?: { toolName: "write_file"; path: string; content: string } | { toolName: "edit_file"; path: string; oldText: string; newText: string };
};

/** Reads `preview` straight off the call's own arguments — no workspace access needed either way. */
function previewFor(request: ApprovalRequest): DaemonApprovalRequest["preview"] {
  const args = (request.call.arguments ?? {}) as Record<string, unknown>;
  const path = typeof args.path === "string" ? args.path : undefined;
  if (!path) return undefined;
  if (request.tool.name === "write_file" && typeof args.content === "string") {
    return { toolName: "write_file", path, content: args.content };
  }
  if (request.tool.name === "edit_file" && typeof args.oldText === "string" && typeof args.newText === "string") {
    return { toolName: "edit_file", path, oldText: args.oldText, newText: args.newText };
  }
  return undefined;
}

export type DaemonNotification =
  | { protocolVersion: 1; type: "session_opened"; sessionId: string; resumed: boolean }
  | { protocolVersion: 1; type: "agent_event"; sessionId: string; event: NovaEvent }
  | { protocolVersion: 1; type: "approval_requested"; sessionId: string; request: DaemonApprovalRequest }
  | { protocolVersion: 1; type: "turn_started"; sessionId: string; commandId: string; objective: string }
  | { protocolVersion: 1; type: "turn_finished"; sessionId: string; commandId: string; status: AgentRuntimeResult["status"] }
  | { protocolVersion: 1; type: "turn_failed"; sessionId: string; commandId: string; message: string };

type DaemonNotificationBody = DaemonNotification extends infer Notification
  ? Notification extends { protocolVersion: 1 }
    ? Omit<Notification, "protocolVersion">
    : never
  : never;

export type DaemonAgentFactoryContext = {
  onEvent: (event: NovaEvent) => void;
  approve: ApprovalPrompt;
};

export type DaemonAgentFactory = (context: DaemonAgentFactoryContext) => NovaAgent | Promise<NovaAgent>;

type ClientState = {
  notify: (notification: DaemonNotification) => void;
  approve?: (request: DaemonApprovalRequest) => PermissionDecision | Promise<PermissionDecision>;
};

type LiveSession = {
  agent: NovaAgent;
  subscribers: Set<string>;
  tail: Promise<void>;
  commands: Map<string, Promise<NovaTurnResult>>;
};

function assertSafeId(id: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(id)) throw new Error(`${label} contains unsafe characters`);
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The hub behind Nova's clients.
 *
 * It is deliberately transport-free: stdio JSONL, a local socket and an in-process test client all
 * call the same state machine. Only this object holds live NovaAgent instances. Client disconnects
 * remove subscriptions, not sessions, so a desktop window or IDE can reconnect without ending work.
 */
export class NovaSessionDaemon {
  private readonly clients = new Map<string, ClientState>();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly pendingApprovals = new Map<string, {
    sessionId: string;
    resolve: (decision: PermissionDecision) => void;
  }>();

  connect(options: {
    id?: string;
    onNotification?: ClientState["notify"];
    approve?: ClientState["approve"];
  } = {}): NovaDaemonClient {
    const id = options.id ?? `client_${randomUUID()}`;
    assertSafeId(id, "Client id");
    if (this.clients.has(id)) throw new Error(`Daemon client already connected: ${id}`);
    this.clients.set(id, { notify: options.onNotification ?? (() => undefined), approve: options.approve });
    return new NovaDaemonClient(this, id);
  }

  private publish(sessionId: string, notification: DaemonNotificationBody): void {
    const live = this.sessions.get(sessionId);
    if (!live) return;
    const complete = { protocolVersion: NOVA_DAEMON_PROTOCOL_VERSION, ...notification } as DaemonNotification;
    for (const clientId of live.subscribers) this.clients.get(clientId)?.notify(complete);
  }

  private async requestApproval(sessionId: string, request: ApprovalRequest): Promise<PermissionDecision> {
    const publicRequest: DaemonApprovalRequest = {
      id: `approval_${randomUUID()}`,
      sessionId,
      summary: request.summary,
      actionDigest: request.actionDigest,
      scopeKey: request.scopeKey,
      policyVersion: request.policyVersion,
      toolCallId: request.call.id,
      toolName: request.tool.name,
      effect: request.tool.effect,
      capabilityId: request.tool.capabilityId,
      safety: request.safety,
      preview: previewFor(request),
    };
    const live = this.requireSession(sessionId);
    for (const clientId of live.subscribers) {
      const handler = this.clients.get(clientId)?.approve;
      if (handler) return await handler(publicRequest);
    }
    this.publish(sessionId, { type: "approval_requested", sessionId, request: publicRequest });
    return await new Promise<PermissionDecision>((resolve) => {
      this.pendingApprovals.set(publicRequest.id, { sessionId, resolve });
    });
  }

  async open(clientId: string, factory: DaemonAgentFactory, record?: SessionRecord): Promise<DaemonSessionInfo> {
    this.requireClient(clientId);
    if (record) {
      const active = this.sessions.get(record.id);
      if (active) {
        active.subscribers.add(clientId);
        return this.info(active, true);
      }
    }

    let sessionId = record?.id ?? "session_pending";
    const agent = await factory({
      onEvent: (event) => this.publish(sessionId, { type: "agent_event", sessionId, event }),
      approve: (request) => this.requestApproval(sessionId, request),
    });
    if (record) agent.resume(record);
    sessionId = agent.sessionId;
    const live: LiveSession = {
      agent,
      subscribers: new Set([clientId]),
      tail: Promise.resolve(),
      commands: new Map(),
    };
    this.sessions.set(sessionId, live);
    const info = this.info(live, Boolean(record));
    this.publish(sessionId, { type: "session_opened", sessionId, resumed: info.resumed });
    return info;
  }

  attach(clientId: string, sessionId: string): DaemonSessionInfo {
    this.requireClient(clientId);
    const live = this.requireSession(sessionId);
    live.subscribers.add(clientId);
    return this.info(live, true);
  }

  private info(live: LiveSession, resumed: boolean): DaemonSessionInfo {
    return {
      sessionId: live.agent.sessionId,
      workspaceLabel: live.agent.workspaceLabel,
      workspaceKind: live.agent.workspaceKind,
      resumed,
    };
  }

  private requireClient(clientId: string): ClientState {
    const client = this.clients.get(clientId);
    if (!client) throw new Error("Daemon client is not connected");
    return client;
  }

  private requireSession(sessionId: string): LiveSession {
    assertSafeId(sessionId, "Session id");
    const live = this.sessions.get(sessionId);
    if (!live) throw new Error(`Session is not active in this daemon: ${sessionId}`);
    return live;
  }

  private requireAttached(clientId: string, sessionId: string): LiveSession {
    this.requireClient(clientId);
    const live = this.requireSession(sessionId);
    if (!live.subscribers.has(clientId)) throw new Error("Client is not attached to this session");
    return live;
  }

  send(clientId: string, sessionId: string, objective: string, commandId: string): Promise<NovaTurnResult> {
    const live = this.requireAttached(clientId, sessionId);
    assertSafeId(commandId, "Command id");
    const existing = live.commands.get(commandId);
    if (existing) return existing;

    let resolve!: (result: NovaTurnResult) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<NovaTurnResult>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
    live.commands.set(commandId, result);
    const run = async () => {
      this.publish(sessionId, { type: "turn_started", sessionId, commandId, objective });
      try {
        const turn = await live.agent.send(objective);
        this.publish(sessionId, { type: "turn_finished", sessionId, commandId, status: turn.status });
        resolve(turn);
      } catch (error) {
        this.publish(sessionId, { type: "turn_failed", sessionId, commandId, message: messageFor(error) });
        reject(error);
      }
    };
    live.tail = live.tail.then(run, run);
    if (live.commands.size > 256) live.commands.delete(live.commands.keys().next().value as string);
    return result;
  }

  decideApproval(clientId: string, approvalId: string, decision: PermissionDecision): void {
    this.requireClient(clientId);
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) throw new Error(`Approval is not pending: ${approvalId}`);
    this.requireAttached(clientId, pending.sessionId);
    this.pendingApprovals.delete(approvalId);
    pending.resolve(decision);
  }

  cancel(clientId: string, sessionId: string): void { this.requireAttached(clientId, sessionId).agent.cancel(); }
  estimate(clientId: string, sessionId: string, objective: string): Promise<AgentCostPrediction> { return this.requireAttached(clientId, sessionId).agent.estimateNextTurn(objective); }
  setModelSpendLimit(clientId: string, sessionId: string, remaining: number): void { this.requireAttached(clientId, sessionId).agent.setModelSpendLimit(remaining); }
  todos(clientId: string, sessionId: string): TodoItem[] { return this.requireAttached(clientId, sessionId).agent.todos; }
  diffStat(clientId: string, sessionId: string): Promise<string> { return this.requireAttached(clientId, sessionId).agent.diffStat(); }
  diffPatch(clientId: string, sessionId: string): Promise<string> { return this.requireAttached(clientId, sessionId).agent.diffPatch(); }
  scanSecrets(clientId: string, sessionId: string, include?: string): Promise<PlacedSecretFinding[]> { return this.requireAttached(clientId, sessionId).agent.scanSecrets(include); }
  listFiles(clientId: string, sessionId: string, pattern?: string): Promise<string[]> { return this.requireAttached(clientId, sessionId).agent.listFiles(pattern); }
  readFile(clientId: string, sessionId: string, file: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> { return this.requireAttached(clientId, sessionId).agent.readFile(file, options); }
  undo(clientId: string, sessionId: string, scope?: RestoreScope): Promise<Checkpoint | undefined> { return this.requireAttached(clientId, sessionId).agent.undo(scope); }
  inspectTools(clientId: string, sessionId: string): ReturnType<NovaAgent["inspectTools"]> { return this.requireAttached(clientId, sessionId).agent.inspectTools(); }

  async release(clientId: string, sessionId: string, dispose = false): Promise<void> {
    const live = this.requireAttached(clientId, sessionId);
    live.subscribers.delete(clientId);
    if (!dispose) return;
    await live.tail.catch(() => undefined);
    for (const [id, pending] of this.pendingApprovals) {
      if (pending.sessionId === sessionId) { this.pendingApprovals.delete(id); pending.resolve("deny"); }
    }
    await live.agent.dispose();
    this.sessions.delete(sessionId);
  }

  /** Retires an agent for a mode/model handoff and returns the exact conversation to transfer. */
  async relinquish(clientId: string, sessionId: string): Promise<SessionRecord> {
    const live = this.requireAttached(clientId, sessionId);
    if (live.subscribers.size > 1) throw new Error("Cannot replace a session while another client is attached");
    await live.tail.catch(() => undefined);
    const record = live.agent.snapshot();
    await live.agent.relinquish();
    this.sessions.delete(sessionId);
    return record;
  }

  disconnect(clientId: string): void {
    this.clients.delete(clientId);
    for (const live of this.sessions.values()) live.subscribers.delete(clientId);
  }

  async shutdown(): Promise<void> {
    const liveSessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const pending of this.pendingApprovals.values()) pending.resolve("deny");
    this.pendingApprovals.clear();
    await Promise.all(liveSessions.map(async (live) => {
      await live.tail.catch(() => undefined);
      await live.agent.dispose().catch(() => undefined);
    }));
    this.clients.clear();
  }
}

export type DaemonSessionInfo = {
  sessionId: string;
  workspaceLabel: string;
  workspaceKind: NovaWorkspace["kind"];
  resumed: boolean;
};

/** Opaque client spoke. It owns no runtime or persisted session state. */
export class NovaDaemonClient {
  private activeSession: string | null = null;
  private info: DaemonSessionInfo | null = null;

  constructor(private readonly daemon: NovaSessionDaemon, readonly id: string) {}
  get sessionId(): string {
    if (!this.activeSession) throw new Error("Client has no open session");
    return this.activeSession;
  }
  get workspaceLabel(): string { return this.info?.workspaceLabel ?? ""; }
  get workspaceKind(): NovaWorkspace["kind"] { return this.info?.workspaceKind ?? "local"; }
  get todos(): TodoItem[] { return this.daemon.todos(this.id, this.sessionId); }
  async open(factory: DaemonAgentFactory, record?: SessionRecord): Promise<DaemonSessionInfo> {
    const info = await this.daemon.open(this.id, factory, record);
    this.activeSession = info.sessionId;
    this.info = info;
    return info;
  }
  attach(sessionId: string): DaemonSessionInfo {
    const info = this.daemon.attach(this.id, sessionId);
    this.activeSession = sessionId;
    this.info = info;
    return info;
  }
  send(objective: string, commandId = `turn_${randomUUID()}`): Promise<NovaTurnResult> { return this.daemon.send(this.id, this.sessionId, objective, commandId); }
  cancel(): void { this.daemon.cancel(this.id, this.sessionId); }
  estimate(objective: string): Promise<AgentCostPrediction> { return this.daemon.estimate(this.id, this.sessionId, objective); }
  setModelSpendLimit(remaining: number): void { this.daemon.setModelSpendLimit(this.id, this.sessionId, remaining); }
  diffStat(): Promise<string> { return this.daemon.diffStat(this.id, this.sessionId); }
  diffPatch(): Promise<string> { return this.daemon.diffPatch(this.id, this.sessionId); }
  scanSecrets(include?: string): Promise<PlacedSecretFinding[]> { return this.daemon.scanSecrets(this.id, this.sessionId, include); }
  listFiles(pattern?: string): Promise<string[]> { return this.daemon.listFiles(this.id, this.sessionId, pattern); }
  readFile(file: string, options?: { offset?: number; limit?: number }): Promise<ReadResult> { return this.daemon.readFile(this.id, this.sessionId, file, options); }
  undo(scope?: RestoreScope): Promise<Checkpoint | undefined> { return this.daemon.undo(this.id, this.sessionId, scope); }
  inspectTools(): ReturnType<NovaAgent["inspectTools"]> { return this.daemon.inspectTools(this.id, this.sessionId); }
  decideApproval(id: string, decision: PermissionDecision): void { this.daemon.decideApproval(this.id, id, decision); }
  async release(dispose = false): Promise<void> {
    if (this.activeSession) await this.daemon.release(this.id, this.activeSession, dispose);
    this.activeSession = null;
    this.info = null;
  }
  async relinquish(): Promise<SessionRecord | undefined> {
    const record = this.activeSession ? await this.daemon.relinquish(this.id, this.activeSession) : undefined;
    this.activeSession = null;
    this.info = null;
    this.daemon.disconnect(this.id);
    return record;
  }
  async dispose(): Promise<void> {
    await this.release(true);
    this.daemon.disconnect(this.id);
  }
  disconnect(): void { this.daemon.disconnect(this.id); this.activeSession = null; }
}
