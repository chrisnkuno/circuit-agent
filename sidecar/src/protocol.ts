/** Shared IPC types between the React UI, Tauri shell, and Node sidecar. */

export type ProviderId = "circuitnotion" | "openai" | "anthropic";
/**
 * Re-exported from agent-core rather than restated, because a second copy of this union is a copy
 * that drifts: `defender` shipped in the CLI and this file kept saying there were three modes, so
 * the desktop could not offer a mode the engine underneath it had supported for weeks.
 */
import type { NovaMode } from "@circuit-nova/nova-core/nova-cli/permissions";

export type { NovaMode };
export type PermissionDecision = "allow" | "allow_always" | "deny" | "deny_always";

export const CIRCUITNOTION_DEFAULT_BASE_URL = "https://api.circuitnotion.com/v1";
export const DEFAULT_MODELS: Record<ProviderId, string> = {
  circuitnotion: "gpt-5.6-luna",
  openai: "gpt-5.6-terra",
  anthropic: "claude-opus-5",
};

export type NovaSettings = {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  e2bApiKey?: string;
  relaySecret?: string;
  budget?: number;
  currency?: string;
  fxRwfPerUsd?: number;
  modelInputPerMillion?: number;
  modelOutputPerMillion?: number;
};

/**
 * Which tab a request is about.
 *
 * Optional on every request that carries it, and that is the whole compatibility story: a request
 * that names no tab means "the one in front", which is what every request meant back when there was
 * only ever one. Nothing that already worked has to start naming a tab to go on working.
 */
export type TabScoped = { tabId?: string };

export type IpcRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "settings.set"; settings: NovaSettings }
  | { id: string; type: "providers.describe" }
  | { id: string; type: "providers.verify"; settings: NovaSettings }
  /**
   * Opens a project.
   *
   * Into the named tab when `tabId` is given — replacing what was there, which is what "open a
   * different folder in this tab" means — and into a new tab otherwise. Opening no longer implies
   * closing: that it did was the single reason the app could only hold one piece of work at a time.
   */
  | ({ id: string; type: "session.open"; root: string; mode?: NovaMode; sandbox?: boolean; upload?: boolean } & TabScoped)
  /** A session with no project folder, for chatting. See `openScratchSession`. */
  | ({ id: string; type: "session.scratch"; mode?: NovaMode } & TabScoped)
  | { id: string; type: "session.list"; root: string }
  | ({ id: string; type: "session.resume"; root: string; sessionId: string; mode?: NovaMode; sandbox?: boolean; upload?: boolean } & TabScoped)
  /** The tabs this window has open, and which one is in front. */
  | { id: string; type: "tabs.list" }
  /** Brings a tab to the front. Only bookkeeping — a background tab goes on working either way. */
  | { id: string; type: "tabs.activate"; tabId: string }
  /** Ends one tab's session and releases what it was holding, leaving every other tab running. */
  | { id: string; type: "tabs.close"; tabId: string }
  | ({ id: string; type: "turn.send"; objective: string } & TabScoped)
  /** Durable memory, shared with the CLI — the same files, not a desktop-only copy. */
  | ({ id: string; type: "memory.list" } & TabScoped)
  | ({ id: string; type: "memory.add"; scope: "project" | "user"; text: string; kind?: string } & TabScoped)
  | ({ id: string; type: "memory.forget"; scope: "project" | "user"; index: number } & TabScoped)
  | ({ id: string; type: "mode.set"; mode: NovaMode } & TabScoped)
  | ({ id: string; type: "model.set"; provider?: ProviderId; model: string } & TabScoped)
  /**
   * Answers an approval.
   *
   * Deliberately *not* tab-scoped: the request id already names one pending approval in one session,
   * and the daemon binds a decision to that request's action digest. Letting a caller also name a tab
   * would invite the two to disagree, and "which of these did I just authorise" is the last question
   * in this protocol that should have an ambiguous answer.
   */
  | { id: string; type: "approval.respond"; requestId: string; decision: PermissionDecision }
  | ({ id: string; type: "undo" } & TabScoped)
  | ({ id: string; type: "cancel" } & TabScoped)
  | ({ id: string; type: "cost.get" } & TabScoped)
  | ({ id: string; type: "diff.get" } & TabScoped)
  | ({ id: string; type: "todos.get" } & TabScoped)
  | ({ id: string; type: "scan.secrets"; include?: string } & TabScoped)
  | ({ id: string; type: "files.list"; pattern?: string } & TabScoped)
  | ({ id: string; type: "sandbox.pull"; dest?: string } & TabScoped)
  | { id: string; type: "dispose" };

export type IpcResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/**
 * Where an event came from.
 *
 * Every event a *session* produces carries this, and it is not optional in practice even though the
 * type allows it: with two turns streaming at once, an untagged delta is a token with no transcript
 * to belong to, and the receiver's only options are to guess or to drop it. The daemon already tags
 * its notifications with a session id, so the tab is known at the source rather than inferred at the
 * destination — which is the difference between routing and guessing.
 *
 * It stays optional so that the events which genuinely belong to no session — `ready`, and a boot
 * failure with no tab to report against — do not have to invent one.
 */
export type TabTagged = { tabId?: string; sessionId?: string };

export type IpcEvent =
  | ({ type: "assistant_delta"; text: string } & TabTagged)
  | ({
      type: "tool_call";
      toolCallId: string;
      name: string;
      summary?: string;
    } & TabTagged)
  | ({
      type: "tool_result";
      toolCallId: string;
      name: string;
      ok: boolean;
      preview?: string;
    } & TabTagged)
  | ({
      type: "approval_needed";
      requestId: string;
      toolCallId: string;
      toolName: string;
      summary: string;
      actionDigest: string;
      scopeKey: string;
    } & TabTagged)
  | ({ type: "turn_status"; status: string; summary?: string } & TabTagged)
  | ({ type: "cost"; report: string; displayTotal?: string; budgetFraction?: number } & TabTagged)
  | ({ type: "checkpoint"; id: string; label?: string } & TabTagged)
  | ({ type: "error"; message: string } & TabTagged)
  | { type: "ready" };

export function defaultSettings(): NovaSettings {
  return {
    provider: "circuitnotion",
    apiKey: "",
    baseUrl: CIRCUITNOTION_DEFAULT_BASE_URL,
    model: DEFAULT_MODELS.circuitnotion,
    currency: "RWF",
    fxRwfPerUsd: 1320,
  };
}
