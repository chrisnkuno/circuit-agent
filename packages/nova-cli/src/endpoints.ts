import type { ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";
import { CIRCUITNOTION_DEFAULT_BASE_URL } from "@circuit-nova/nova-core/providers/circuitnotion-http";

/**
 * The network endpoints Nova depends on, in one place.
 *
 * The CLI has exactly three network dependencies: the model API that does the work (required),
 * the daily FX-rate lookup that prices it in local currency (optional, skipped by NOVA_FX_OFFLINE
 * or a configured rate), and the npm registry that self-update checks (optional, only reached on
 * `nova update`). Keeping them here means the connectivity doctor, the FX lookup and the update
 * check all agree on what to call — a doctor that says an endpoint is fine while the same lookup
 * times out would be its own kind of unprofessional.
 */

export const FX_ENDPOINTS = [
  "https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies",
  "https://latest.currency-api.pages.dev/v1/currencies",
] as const;

export const DEFAULT_UPDATE_REGISTRY = "https://registry.npmjs.org";

export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderEndpoint = {
  id: ProviderId;
  /** Human label, e.g. "OpenAI". */
  label: string;
  baseUrl: string;
  /** Credentials for this provider are present, so the CLI can actually use it. */
  configured: boolean;
};

export function providerBaseUrl(environment: ProviderEnvironment, provider: ProviderId): string {
  switch (provider) {
    case "circuitnotion":
      return environment.CIRCUITNOTION_BASE_URL?.trim() || CIRCUITNOTION_DEFAULT_BASE_URL;
    case "openai":
      return environment.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1";
    case "anthropic":
      return environment.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
    case "ollama":
      return environment.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1";
  }
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  circuitnotion: "CircuitNotion",
  openai: "OpenAI",
  anthropic: "Anthropic",
  ollama: "Ollama (local)",
};

/** Empty for a provider that needs no key at all — `providerEndpoints` reads that as always configured. */
const PROVIDER_KEYS: Record<ProviderId, string> = {
  circuitnotion: "CIRCUITNOTION_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  ollama: "",
};

/** Every model provider's API endpoint, with the base-URL override applied when set. */
export function providerEndpoints(environment: ProviderEnvironment): ProviderEndpoint[] {
  return (["circuitnotion", "openai", "anthropic", "ollama"] as const).map((id) => ({
    id,
    label: PROVIDER_LABELS[id],
    baseUrl: providerBaseUrl(environment, id),
    configured: PROVIDER_KEYS[id] === "" ? true : Boolean(environment[PROVIDER_KEYS[id]]?.trim()),
  }));
}

/** The host part of a URL, for error messages that should name what failed. */
export function hostOf(url: string | URL): string {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
}
