import type { NovaSettings, ProviderId } from "./protocol.js";
import { CIRCUITNOTION_DEFAULT_BASE_URL, DEFAULT_MODELS } from "./protocol.js";

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
  if (settings.currency?.trim()) env.NOVA_CURRENCY = settings.currency.trim();
  if (settings.fxRwfPerUsd != null) env.NOVA_FX_RWF_PER_USD = String(settings.fxRwfPerUsd);
  return env;
}

export function defaultBaseUrl(provider: ProviderId): string {
  if (provider === "circuitnotion") return CIRCUITNOTION_DEFAULT_BASE_URL;
  if (provider === "openai") return "https://api.openai.com/v1";
  return "";
}
