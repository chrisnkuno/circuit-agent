import type { NovaSettings, ProviderId } from "./protocol.js";
import { CIRCUITNOTION_DEFAULT_BASE_URL, DEFAULT_MODELS } from "./protocol.js";
import { buildCircuitNotionHeaders } from "@circuit-nova/nova-core/providers/circuitnotion";

/**
 * The key and base URL to use for one provider.
 *
 * `credentials` first, then the flat `apiKey`/`baseUrl` — which belong to whichever provider is
 * selected, and are all an older build ever stored. Reading them as a fallback is what lets
 * existing settings keep working, but only for the *selected* provider: treating them as a key for
 * every provider is precisely the bug this exists to fix, because it would go on sending one
 * provider's key to another under a new name.
 */
export function credentialsFor(settings: NovaSettings, provider: ProviderId): { apiKey: string; baseUrl: string } {
  const stored = settings.credentials?.[provider];
  const selected = provider === settings.provider;
  const apiKey = (stored?.apiKey ?? (selected ? settings.apiKey : "")).trim();
  const baseUrl = (stored?.baseUrl ?? (selected ? settings.baseUrl : "")).trim() || defaultBaseUrl(provider);
  return { apiKey, baseUrl };
}

/** Whether a provider can be used at all — the question the model picker needs answered. */
export function providerIsConfigured(settings: NovaSettings, provider: ProviderId): boolean {
  return credentialsFor(settings, provider).apiKey.length > 0;
}

/** Build the environment object `resolveProvider` expects from UI settings. */
export function settingsToEnvironment(settings: NovaSettings): Record<string, string> {
  const env: Record<string, string> = {};
  const provider = settings.provider;
  const model = settings.model.trim() || DEFAULT_MODELS[provider];
  const { apiKey, baseUrl } = credentialsFor(settings, provider);

  if (provider === "circuitnotion") {
    env.CIRCUITNOTION_API_KEY = apiKey;
    env.CIRCUITNOTION_BASE_URL = baseUrl;
    env.CIRCUITNOTION_MODEL = model;
    if (settings.relaySecret?.trim()) env.CIRCUITNOTION_RELAY_SECRET = settings.relaySecret.trim();
  } else if (provider === "openai") {
    env.OPENAI_API_KEY = apiKey;
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_MODEL = model;
  } else {
    env.ANTHROPIC_API_KEY = apiKey;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    env.ANTHROPIC_MODEL = model;
  }

  if (settings.e2bApiKey?.trim()) env.E2B_API_KEY = settings.e2bApiKey.trim();
  if (settings.modelInputPerMillion != null) env.MODEL_INPUT_PER_MILLION = String(settings.modelInputPerMillion);
  if (settings.modelOutputPerMillion != null) env.MODEL_OUTPUT_PER_MILLION = String(settings.modelOutputPerMillion);
  // The same variable names the CLI reads, so one account needs configuring once. Absent unless
  // filled in, which is what lets `billingFromEnvironment` return null instead of half-working.
  if (settings.billingUrl?.trim()) env.NOVA_BILLING_URL = settings.billingUrl.trim();
  if (settings.billingKey?.trim()) env.NOVA_BILLING_KEY = settings.billingKey.trim();
  if (settings.currency?.trim()) env.NOVA_CURRENCY = settings.currency.trim();
  if (settings.fxRwfPerUsd != null) env.NOVA_FX_RWF_PER_USD = String(settings.fxRwfPerUsd);
  return env;
}

/**
 * An environment naming *every* provider the user has a key for, not just the selected one.
 *
 * `settingsToEnvironment` deliberately describes one provider, because that is what running a turn
 * needs and mixing them is how one provider's key used to be sent to another. Asking each provider
 * what models it has is the opposite question: the model picker offers all three, and a provider
 * left out of the environment is one that silently shows only the models this build was compiled
 * knowing about. Built from `credentialsFor`, so a key still only ever appears under its own
 * provider's variable.
 */
export function settingsToCatalogEnvironment(
  settings: NovaSettings,
  processEnvironment: Record<string, string | undefined> = process.env,
): Record<string, string> {
  // Where Nova keeps its configuration, carried through from the real environment. The fetched
  // model list is cached there and is deliberately shared with the CLI — same key, same answer,
  // one six-hour fetch between them. Built from settings alone, this environment would name no
  // config directory at all, and `novaConfigDirectory` would fall back to the home directory:
  // the desktop would then quietly keep a second cache, and no test could point either at a
  // temporary one, which is how a suite ends up writing stub models into a developer's real cache.
  const env: Record<string, string> = {};
  for (const name of ["NOVA_CONFIG_DIR", "XDG_CONFIG_HOME", "APPDATA"]) {
    const value = processEnvironment[name]?.trim();
    if (value) env[name] = value;
  }
  for (const provider of ["anthropic", "openai", "circuitnotion"] as const) {
    const { apiKey, baseUrl } = credentialsFor(settings, provider);
    if (!apiKey) continue;
    if (provider === "anthropic") {
      env.ANTHROPIC_API_KEY = apiKey;
      if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    } else if (provider === "openai") {
      env.OPENAI_API_KEY = apiKey;
      if (baseUrl) env.OPENAI_BASE_URL = baseUrl;
    } else {
      env.CIRCUITNOTION_API_KEY = apiKey;
      if (baseUrl) env.CIRCUITNOTION_BASE_URL = baseUrl;
    }
  }
  return env;
}

export function defaultBaseUrl(provider: ProviderId): string {
  if (provider === "circuitnotion") return CIRCUITNOTION_DEFAULT_BASE_URL;
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}

/**
 * Validate an API key by making a lightweight request to the provider's models endpoint.
 * Returns a human-readable error message if validation fails, or undefined if the key is valid.
 */
export async function validateApiKey(settings: NovaSettings): Promise<string | undefined> {
  const apiKey = settings.apiKey.trim();
  if (!apiKey) return "API key is required.";

  const baseUrl = settings.baseUrl.trim() || defaultBaseUrl(settings.provider);
  if (!baseUrl) return undefined; // no base URL to validate against

  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
  };
  if (settings.provider === "circuitnotion" && settings.relaySecret?.trim()) {
    const relayHeaders = buildCircuitNotionHeaders(settings.relaySecret.trim());
    Object.assign(headers, relayHeaders);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (response.status === 401 || response.status === 403) {
      const body = await response.text().catch(() => "");
      let detail = "invalid API key";
      try {
        const json = JSON.parse(body);
        detail = json.error?.message || json.message || detail;
      } catch {
        // non-JSON error body — use raw text if short enough
        if (body.length < 200) detail = body;
      }
      return `${settings.provider} authentication failed: ${detail}`;
    }

    if (!response.ok) {
      return `${settings.provider} API returned status ${response.status}. Check your base URL (${baseUrl}).`;
    }

    return undefined; // valid
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return `${settings.provider} API did not respond within 8 seconds. Check your base URL and network connection.`;
    }
    // Network/DNS errors — don't block saving, just warn
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
