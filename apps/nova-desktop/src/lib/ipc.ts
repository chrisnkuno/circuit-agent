import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import type { PlacedSecretFinding } from "./scan";
import type { IpcEvent, NovaMode, NovaSettings, PermissionDecision, ProviderId } from "./settings";

type RequestPayload = Record<string, unknown> & { type: string };

let seq = 0;

export async function ensureSidecar(): Promise<void> {
  await invoke("sidecar_start");
}

export async function sidecarRequest<T = unknown>(payload: RequestPayload): Promise<T> {
  const id = `req_${++seq}_${Date.now()}`;
  return await invoke<T>("sidecar_request", { request: { id, ...payload } });
}

export async function setSettings(settings: NovaSettings) {
  return await sidecarRequest({ type: "settings.set", settings });
}

export async function openSession(root: string, mode: NovaMode, sandbox: boolean, upload: boolean) {
  return await sidecarRequest<{
    sessionId: string;
    root: string;
    mode: NovaMode;
    sandbox: boolean;
    workspace: string;
    model: string;
    provider: string;
  }>({ type: "session.open", root, mode, sandbox, upload });
}

/**
 * Opens a session with no project folder, for chatting.
 *
 * Returns the scratch directory the sidecar chose, so the UI can say where files would land rather
 * than leaving "no project" as an invisible state with real consequences.
 */
export async function openScratchSession(mode: NovaMode) {
  return await sidecarRequest<{
    sessionId: string;
    root: string;
    provider?: string;
    model?: string;
    workspace: string;
    scratch: true;
  }>({ type: "session.scratch", mode });
}

export async function listSessions(root: string) {
  return await sidecarRequest<Array<{ id: string; title: string; updatedAt: number }>>({
    type: "session.list",
    root,
  });
}

export async function resumeSession(root: string, sessionId: string, mode: NovaMode, sandbox: boolean, upload: boolean) {
  return await sidecarRequest({ type: "session.resume", root, sessionId, mode, sandbox, upload });
}

export async function sendTurn(objective: string) {
  return await sidecarRequest<{ status: string; summary: string; sessionId: string }>({
    type: "turn.send",
    objective,
  });
}

export async function setMode(mode: NovaMode) {
  return await sidecarRequest({ type: "mode.set", mode });
}

export async function setModel(model: string, provider?: ProviderId) {
  return await sidecarRequest({ type: "model.set", model, provider });
}

export async function respondApproval(requestId: string, decision: PermissionDecision) {
  return await sidecarRequest({ type: "approval.respond", requestId, decision });
}

export async function undoTurn() {
  return await sidecarRequest({ type: "undo" });
}

export async function cancelTurn() {
  return await sidecarRequest({ type: "cancel" });
}

export async function getCost() {
  return await sidecarRequest<{
    report: string;
    priced: boolean;
    displayTotal?: string;
    budgetFraction?: number;
    warning?: string;
    exhausted?: boolean;
  }>({ type: "cost.get" });
}

export async function verifyCredentials(settings: NovaSettings) {
  return await sidecarRequest<{ ok: boolean; models?: number; note?: string; reason?: string; hint?: string }>({
    type: "providers.verify",
    settings,
  });
}

export async function getDiff() {
  return await sidecarRequest<{ diff: string }>({ type: "diff.get" });
}

export async function getTodos() {
  return await sidecarRequest<{ todos: Array<{ id: string; content: string; status: string }> }>({ type: "todos.get" });
}

export async function pullSandbox(dest?: string) {
  return await sidecarRequest<{ dest: string }>({ type: "sandbox.pull", dest });
}

/**
 * The deterministic secret scan. Read-only and model-free, so it needs no approval and costs
 * nothing — the same scan `scan_secrets` runs, reached directly.
 */
export async function scanSecrets(include?: string) {
  return await sidecarRequest<{ findings: PlacedSecretFinding[] }>({ type: "scan.secrets", ...(include ? { include } : {}) });
}

/** The project's files, root-relative — whatever backend the session is on. */
export async function listFiles(pattern?: string) {
  return await sidecarRequest<{ files: string[] }>({ type: "files.list", ...(pattern ? { pattern } : {}) });
}

export async function onSidecarEvent(handler: (event: IpcEvent) => void): Promise<UnlistenFn> {
  return await listen<IpcEvent>("sidecar-event", (event) => handler(event.payload));
}

/**
 * Fires when the engine process dies — crashed, killed, or exited on its own.
 *
 * Separate from `sidecar-event`, which carries things the *session* produced. This says there is
 * no session any more, which the UI has to treat differently: any turn in flight is over, and the
 * next request will start a fresh process rather than continue the old one.
 */
export async function onSidecarExit(handler: () => void): Promise<UnlistenFn> {
  return await listen("sidecar-exited", () => handler());
}

/** Non-blocking folder picker via the dialog plugin (safe on Linux/GTK). */
export async function pickFolder(): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: "Open project folder",
  });
  if (typeof selected === "string" && selected.trim()) return selected;
  return null;
}

export async function loadPersistedSettings(): Promise<NovaSettings | null> {
  return await invoke<NovaSettings | null>("load_settings");
}

/**
 * Where the window was last working: the project, the mode, and the projects before that.
 *
 * Kept apart from settings because they are different kinds of thing — settings are configuration
 * worth copying between machines, this is per-machine state about paths that may not exist
 * anywhere else.
 */
export type WorkspaceState = {
  lastRoot?: string;
  mode?: NovaMode;
  sandbox?: boolean;
  recentRoots?: string[];
};

export async function loadWorkspaceState(): Promise<WorkspaceState | null> {
  return await invoke<WorkspaceState | null>("load_workspace");
}

export async function saveWorkspaceState(workspace: WorkspaceState): Promise<void> {
  await invoke("save_workspace", { workspace });
}

export async function savePersistedSettings(settings: NovaSettings): Promise<void> {
  await invoke("save_settings", { settings });
}
