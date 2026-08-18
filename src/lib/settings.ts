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
 * Which tab an event belongs to — see the sidecar's `TabTagged`, of which this is the mirror.
 *
 * Optional in the type and present in practice on everything a session produces. The window routes
 * on `tabId`: with two turns streaming at once there is no other way to tell whose token this is,
 * and "assume the tab in front" is wrong about half the time.
 */
export type TabTagged = { tabId?: string; sessionId?: string };

export type IpcEvent =
  | ({ type: "assistant_delta"; text: string } & TabTagged)
  | ({ type: "tool_call"; toolCallId: string; name: string; summary?: string } & TabTagged)
  | ({ type: "tool_result"; toolCallId: string; name: string; ok: boolean; preview?: string } & TabTagged)
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

export function defaultBaseUrl(provider: ProviderId): string {
  if (provider === "circuitnotion") return CIRCUITNOTION_DEFAULT_BASE_URL;
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}
