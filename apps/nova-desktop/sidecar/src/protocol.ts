/** Shared IPC types between the React UI, Tauri shell, and Node sidecar. */

export type ProviderId = "circuitnotion" | "openai" | "anthropic";
export type NovaMode = "plan" | "build" | "auto";
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

export type IpcRequest =
  | { id: string; type: "ping" }
  | { id: string; type: "settings.set"; settings: NovaSettings }
  | { id: string; type: "providers.describe" }
  | { id: string; type: "providers.verify"; settings: NovaSettings }
  | { id: string; type: "session.open"; root: string; mode?: NovaMode; sandbox?: boolean; upload?: boolean }
  | { id: string; type: "session.list"; root: string }
  | { id: string; type: "session.resume"; root: string; sessionId: string; mode?: NovaMode; sandbox?: boolean; upload?: boolean }
  | { id: string; type: "turn.send"; objective: string }
  | { id: string; type: "mode.set"; mode: NovaMode }
  | { id: string; type: "model.set"; provider?: ProviderId; model: string }
  | { id: string; type: "approval.respond"; requestId: string; decision: PermissionDecision }
  | { id: string; type: "undo" }
  | { id: string; type: "cancel" }
  | { id: string; type: "cost.get" }
  | { id: string; type: "diff.get" }
  | { id: string; type: "todos.get" }
  | { id: string; type: "sandbox.pull"; dest?: string }
  | { id: string; type: "dispose" };

export type IpcResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
};

export type IpcEvent =
  | { type: "assistant_delta"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      name: string;
      summary?: string;
    }
  | {
      type: "tool_result";
      toolCallId: string;
      name: string;
      ok: boolean;
      preview?: string;
    }
  | {
      type: "approval_needed";
      requestId: string;
      toolCallId: string;
      toolName: string;
      summary: string;
      actionDigest: string;
      scopeKey: string;
    }
  | { type: "turn_status"; status: string; summary?: string }
  | { type: "cost"; report: string; displayTotal?: string; budgetFraction?: number }
  | { type: "checkpoint"; id: string; label?: string }
  | { type: "error"; message: string }
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
