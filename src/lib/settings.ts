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
  /**
   * The active provider's key, and the one every earlier version stored.
   *
   * Kept as the single source for the provider in `provider`, so settings written by an older build
   * keep working untouched; `credentials` is where the *other* providers' keys live.
   */
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * What each provider's key and base URL are, so switching provider does not send one provider's
   * credentials to another.
   *
   * The window held exactly one key and one base URL while offering three providers to switch
   * between. Choosing an Anthropic model with a CircuitNotion key configured did not fail at the
   * moment of choosing — the switch only checks that *a* key is present — it failed on the next
   * turn, and until then the base URL still pointed at CircuitNotion, so Anthropic requests were
   * addressed to a host that had never heard of them.
   */
  credentials?: Partial<Record<ProviderId, { apiKey?: string; baseUrl?: string }>>;
  e2bApiKey?: string;
  relaySecret?: string;
  budget?: number;
  currency?: string;
  fxRwfPerUsd?: number;
  modelInputPerMillion?: number;
  modelOutputPerMillion?: number;
  /**
   * Circuit Pay, so the cost panel can show a balance and a runway rather than a session total
   * alone. Mirrors the sidecar's `NovaSettings`, and reaches the engine as the same
   * `NOVA_BILLING_URL` / `NOVA_BILLING_KEY` the CLI reads — one account, configured once.
   */
  billingUrl?: string;
  billingKey?: string;
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

/**
 * The key and base URL for one provider — the window's copy of the sidecar's `credentialsFor`.
 *
 * Deliberately duplicated rather than imported: `src/lib/settings.ts` and `sidecar/src/protocol.ts`
 * are parallel files by design (the window cannot import from the sidecar's build), and this rule
 * is short enough that a copy is safer than a shared module neither side owns. Both are tested.
 */
export function credentialsFor(settings: NovaSettings, provider: ProviderId): { apiKey: string; baseUrl: string } {
  const stored = settings.credentials?.[provider];
  const selected = provider === settings.provider;
  return {
    apiKey: (stored?.apiKey ?? (selected ? settings.apiKey : "")).trim(),
    baseUrl: (stored?.baseUrl ?? (selected ? settings.baseUrl : "")).trim(),
  };
}

/** Whether a provider can be used at all — what the model picker needs in order to be honest. */
export function providerIsConfigured(settings: NovaSettings, provider: ProviderId): boolean {
  return credentialsFor(settings, provider).apiKey.length > 0;
}

/**
 * Settings with `provider`'s credentials promoted to the flat fields, and the previous provider's
 * preserved in `credentials`.
 *
 * This is what "switch provider" means in one place: the flat pair always describes the selected
 * provider, so nothing downstream has to remember that rule.
 */
export function withProvider(settings: NovaSettings, provider: ProviderId, model: string): NovaSettings {
  const previous = settings.provider;
  const credentials = {
    ...settings.credentials,
    [previous]: { apiKey: settings.apiKey, baseUrl: settings.baseUrl },
  };
  const next = credentialsFor({ ...settings, credentials }, provider);
  return {
    ...settings,
    credentials,
    provider,
    model,
    apiKey: next.apiKey,
    baseUrl: next.baseUrl || defaultBaseUrl(provider),
  };
}
