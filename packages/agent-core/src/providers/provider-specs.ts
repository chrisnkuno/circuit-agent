/**
 * What each provider *is*, separated from what it takes to talk to one.
 *
 * The two halves of a provider have very different weights. Its identity — an id, a label, the
 * variables it needs, the model it defaults to, what the catalog says its models cost — is a few
 * hundred bytes of data. Its `create` is a constructor for a vendor SDK, and importing that
 * reaches `@anthropic-ai/sdk` and `openai` and everything under them.
 *
 * Anything that only wants to *name* providers — a model menu, a settings form, a price column —
 * was paying the second cost to get the first. In the desktop renderer that meant shipping both
 * SDKs to a browser that never calls either, because every request goes through the sidecar.
 * Roughly three quarters of a megabyte to render the word "Anthropic" beside a price.
 *
 * So identity lives here, with no import that reaches a network client, and `agent-matrix.ts`
 * attaches `create` on top. Callers that construct providers see no difference — it re-exports
 * all of this — and callers that only describe them can import from here and pay for data alone.
 */

import { tokenPrices, type TokenPrices } from "../money";
import { selectPrice, tokenPricesFor } from "../pricing";
import { PRICE_CATALOG } from "./price-catalog";

export type ProviderId = "anthropic" | "openai" | "circuitnotion" | "ollama";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "circuitnotion", "ollama"];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ProviderEnvironment = Record<string, string | undefined>;

/** A provider's identity, with nothing that can open a connection. */
export type ProviderInfo = {
  id: ProviderId;
  label: string;
  /** Environment variables that must be set for this provider to be usable. */
  requires: readonly string[];
  defaultModel: string;
};

/**
 * What the dated catalog says this provider's model costs on a given day.
 *
 * Local inference has no per-model catalog entry — a homelab can pull any model it likes — but its
 * price is not unknown, it is zero: nothing is metered, nothing is billed. Reporting that as
 * "unpriced" would understate confidence in a fact this build is actually certain of.
 */
export function catalogPrices(provider: ProviderId, model: string, asOf?: string): TokenPrices | undefined {
  if (provider === "ollama") return tokenPrices("USD", 0, 0, 0);
  const record = selectPrice(PRICE_CATALOG, { provider, model, asOf });
  return record && record.billingUnit === "tokens" ? tokenPricesFor(record) : undefined;
}

export const PROVIDER_INFO: Record<ProviderId, ProviderInfo> = {
  anthropic: { id: "anthropic", label: "Anthropic", requires: ["ANTHROPIC_API_KEY"], defaultModel: "claude-sonnet-5" },
  openai: { id: "openai", label: "OpenAI", requires: ["OPENAI_API_KEY"], defaultModel: "gpt-5.6-terra" },
  circuitnotion: { id: "circuitnotion", label: "CircuitNotion", requires: ["CIRCUITNOTION_API_KEY"], defaultModel: "circuit-2-turbo" },
  // No key required — an Ollama daemon accepts anything in the Authorization header — so this
  // provider is always "configured" and only fails at call time if nothing is listening on the
  // base URL, the same way a bad OPENAI_BASE_URL override would.
  ollama: { id: "ollama", label: "Ollama (local)", requires: [], defaultModel: "llama3.1" },
};
