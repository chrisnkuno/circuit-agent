import type { NovaSettings, ProviderId } from "./protocol.js";
import { CIRCUITNOTION_DEFAULT_BASE_URL, DEFAULT_MODELS } from "./protocol.js";

/** Build the environment object `resolveProvider` expects from UI settings. */
export function settingsToEnvironment(settings: NovaSettings): Record<string, string> {
  const env: Record<string, string> = {};
  const provider = settings.provider;
  const model = settings.model.trim() || DEFAULT_MODELS[provider];
  const baseUrl = settings.baseUrl.trim() || defaultBaseUrl(provider);

  if (provider === "circuitnotion") {
    env.CIRCUITNOTION_API_KEY = settings.apiKey.trim();
    env.CIRCUITNOTION_BASE_URL = baseUrl;
    env.CIRCUITNOTION_MODEL = model;
    if (settings.relaySecret?.trim()) env.CIRCUITNOTION_RELAY_SECRET = settings.relaySecret.trim();
  } else if (provider === "openai") {
    env.OPENAI_API_KEY = settings.apiKey.trim();
    env.OPENAI_BASE_URL = baseUrl;
    env.OPENAI_MODEL = model;
  } else {
    env.ANTHROPIC_API_KEY = settings.apiKey.trim();
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
