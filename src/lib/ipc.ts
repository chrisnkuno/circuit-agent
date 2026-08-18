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

/**
 * Opens a project — into `tabId` when one is named, or into a new tab.
 *
 * Naming a tab is how "open a different folder in *this* tab" is said; omitting it is how a new
 * piece of work is started beside the others. Opening used to imply closing whatever was open,
 * which is exactly the behaviour tabs exist to undo.
 */
export async function openSession(root: string, mode: NovaMode, sandbox: boolean, upload: boolean, tabId?: string) {
  return await sidecarRequest<OpenedSession>({ type: "session.open", root, mode, sandbox, upload, ...(tabId ? { tabId } : {}) });
}

export type OpenedSession = {
  tabId: string;
  sessionId: string;
  root: string;
  mode: NovaMode;
  sandbox: boolean;
  workspace: string;
  model: string;
  provider: string;
  title: string;
};

/** One row per open tab, as the sidecar sees them — the truth the strip is drawn from. */
export type TabRow = {
  tabId: string;
  sessionId: string;
  title: string;
  root: string;
  mode: NovaMode;
  sandbox: boolean;
  model?: string;
  provider?: ProviderId;
  running: boolean;
  active: boolean;
};

export async function listTabs() {
  return await sidecarRequest<{ activeTabId: string | null; tabs: TabRow[] }>({ type: "tabs.list" });
}

/** Bookkeeping only: a tab that is not in front goes on working exactly as before. */
export async function activateTab(tabId: string) {
  return await sidecarRequest<{ activeTabId: string | null; tabs: TabRow[] }>({ type: "tabs.activate", tabId });
}

/** Ends one tab's session and releases what it held — its sandbox included — leaving the rest running. */
export async function closeTab(tabId: string) {
  return await sidecarRequest<{ closed: string; activeTabId: string | null; tabs: TabRow[] }>({ type: "tabs.close", tabId });
}

/**
 * Opens a session with no project folder, for chatting.
 *
 * Returns the scratch directory the sidecar chose, so the UI can say where files would land rather
 * than leaving "no project" as an invisible state with real consequences.
 */
export async function openScratchSession(mode: NovaMode, tabId?: string) {
  return await sidecarRequest<OpenedSession & { scratch: true }>({ type: "session.scratch", mode, ...(tabId ? { tabId } : {}) });
}

export async function listSessions(root: string) {
  return await sidecarRequest<Array<{ id: string; title: string; updatedAt: number }>>({
    type: "session.list",
    root,
  });
}

export async function resumeSession(root: string, sessionId: string, mode: NovaMode, sandbox: boolean, upload: boolean, tabId?: string) {
  return await sidecarRequest<OpenedSession & { title?: string; resumed: true }>({ type: "session.resume", root, sessionId, mode, sandbox, upload, ...(tabId ? { tabId } : {}) });
}

export async function sendTurn(objective: string, tabId?: string) {
  return await sidecarRequest<{ status: string; summary: string; tabId: string; sessionId: string }>({
    type: "turn.send",
    objective,
    ...(tabId ? { tabId } : {}),
  });
}

export async function setMode(mode: NovaMode, tabId?: string) {
  return await sidecarRequest<OpenedSession & { mode: NovaMode }>({ type: "mode.set", mode, ...(tabId ? { tabId } : {}) });
}

export async function setModel(model: string, provider?: ProviderId, tabId?: string) {
  return await sidecarRequest({ type: "model.set", model, provider, ...(tabId ? { tabId } : {}) });
}

export async function respondApproval(requestId: string, decision: PermissionDecision) {
  return await sidecarRequest({ type: "approval.respond", requestId, decision });
}

export async function undoTurn(tabId?: string) {
  return await sidecarRequest({ type: "undo", ...(tabId ? { tabId } : {}) });
}

/** Stops the turn in one tab. Work running in any other tab is left alone. */
export async function cancelTurn(tabId?: string) {
  return await sidecarRequest({ type: "cancel", ...(tabId ? { tabId } : {}) });
}

export async function getCost(tabId?: string) {
  return await sidecarRequest<{
    report: string;
    priced: boolean;
    displayTotal?: string;
    budgetFraction?: number;
    warning?: string;
    exhausted?: boolean;
  }>({ type: "cost.get", ...(tabId ? { tabId } : {}) });
}

export async function verifyCredentials(settings: NovaSettings) {
  return await sidecarRequest<{ ok: boolean; models?: number; note?: string; reason?: string; hint?: string }>({
    type: "providers.verify",
    settings,
  });
}

export async function getDiff(tabId?: string) {
  return await sidecarRequest<{ diff: string }>({ type: "diff.get", ...(tabId ? { tabId } : {}) });
}

export async function getTodos(tabId?: string) {
  return await sidecarRequest<{ todos: Array<{ id: string; content: string; status: string }> }>({ type: "todos.get", ...(tabId ? { tabId } : {}) });
}

export async function pullSandbox(dest?: string, tabId?: string) {
  return await sidecarRequest<{ dest: string }>({ type: "sandbox.pull", dest, ...(tabId ? { tabId } : {}) });
}

/**
 * The deterministic secret scan. Read-only and model-free, so it needs no approval and costs
 * nothing — the same scan `scan_secrets` runs, reached directly.
 */
export async function scanSecrets(include?: string, tabId?: string) {
  return await sidecarRequest<{ findings: PlacedSecretFinding[] }>({ type: "scan.secrets", ...(include ? { include } : {}), ...(tabId ? { tabId } : {}) });
}

/** The project's files, root-relative — whatever backend the session is on. */
export async function listFiles(pattern?: string, tabId?: string) {
  return await sidecarRequest<{ files: string[] }>({ type: "files.list", ...(pattern ? { pattern } : {}), ...(tabId ? { tabId } : {}) });
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
