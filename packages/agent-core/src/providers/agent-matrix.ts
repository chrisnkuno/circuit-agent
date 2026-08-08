import type { AgentTurnProvider } from "../agent-runtime";
import { tokenPrices, type Currency, type TokenPrices } from "../money";
import { AnthropicAgentTurnProvider } from "./anthropic-agent";
import { CircuitNotionAgentTurnProvider } from "./circuitnotion-agent";
import { OpenAIAgentTurnProvider } from "./openai-agent";

/**
 * Which model providers Nova can drive, and what their tokens cost.
 *
 * Prices are recorded in the currency the provider actually publishes — USD for the frontier
 * labs — and converted for display, rather than being pre-converted into RWF at some forgotten
 * rate. A price table denominated in a currency nobody quotes is a table nobody can check against
 * an invoice.
 *
 * The catalog is a default, not an authority: a model absent from it still runs, and the CLI says
 * plainly that it cannot price it rather than inventing a number.
 */

export type ProviderId = "anthropic" | "openai" | "circuitnotion";

export const PROVIDER_IDS: readonly ProviderId[] = ["anthropic", "openai", "circuitnotion"];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ProviderEnvironment = Record<string, string | undefined>;

export type ProviderSpec = {
  id: ProviderId;
  label: string;
  /** Environment variables that must be set for this provider to be usable. */
  requires: readonly string[];
  defaultModel: string;
  /** Published prices per model id, in the provider's own currency. */
  prices: Record<string, TokenPrices>;
  create(environment: ProviderEnvironment, model: string): AgentTurnProvider;
};

const USD: Currency = "USD";

/**
 * Anthropic list prices, per million tokens (2026-06 catalog).
 *
 * Cached input is priced at a tenth of the input rate — the published cache-read multiplier — which
 * is what makes a long agent session affordable and what the cost report needs in order to show the
 * saving rather than a flat overstatement.
 */
const ANTHROPIC_PRICES: Record<string, TokenPrices> = {
  "claude-opus-5": tokenPrices(USD, 5, 25, 0.5),
  "claude-opus-4-8": tokenPrices(USD, 5, 25, 0.5),
  "claude-sonnet-5": tokenPrices(USD, 3, 15, 0.3),
  "claude-sonnet-4-6": tokenPrices(USD, 3, 15, 0.3),
  "claude-haiku-4-5": tokenPrices(USD, 1, 5, 0.1),
};

export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    requires: ["ANTHROPIC_API_KEY"],
    defaultModel: "claude-opus-5",
    prices: ANTHROPIC_PRICES,
    create: (environment, model) =>
      new AnthropicAgentTurnProvider({
        apiKey: environment.ANTHROPIC_API_KEY!.trim(),
        model,
        baseURL: environment.ANTHROPIC_BASE_URL?.trim() || undefined,
      }),
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    requires: ["OPENAI_API_KEY"],
    defaultModel: "gpt-5.6-terra",
    // Deliberately empty: these rates are not verified here, and a wrong price is worse than an
    // honest "unpriced" — set them through the price-override environment variables instead.
    prices: {},
    create: (environment, model) =>
      new OpenAIAgentTurnProvider({
        apiKey: environment.OPENAI_API_KEY!.trim(),
        model,
        baseURL: environment.OPENAI_BASE_URL?.trim() || undefined,
      }),
  },
  circuitnotion: {
    id: "circuitnotion",
    label: "CircuitNotion",
    requires: ["CIRCUITNOTION_API_KEY"],
    defaultModel: "gpt-5.6-luna",
    prices: {},
    create: (environment, model) =>
      new CircuitNotionAgentTurnProvider({
        apiKey: environment.CIRCUITNOTION_API_KEY!.trim(),
        model,
        baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined,
        relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined,
      }),
  },
};

/** Providers whose credentials are actually present, so the CLI can offer only what will work. */
export function availableProviders(environment: ProviderEnvironment): ProviderSpec[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).filter((spec) => spec.requires.every((name) => environment[name]?.trim()));
}

export type ResolvedProvider = {
  spec: ProviderSpec;
  model: string;
  provider: AgentTurnProvider;
  /** Undefined when this model has no published price and none was configured. */
  prices: TokenPrices | undefined;
};

/**
 * Picks the provider and model for a session.
 *
 * An explicit choice is honoured even when its credentials are missing, so the error names the
 * thing the user asked for. Without a choice, the first configured provider wins — in catalog
 * order, which is deliberate rather than alphabetical.
 */
export function resolveProvider(
  environment: ProviderEnvironment,
  options: { provider?: string; model?: string } = {},
): ResolvedProvider | { error: string } {
  if (options.provider && !isProviderId(options.provider)) {
    return { error: `Unknown provider "${options.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.` };
  }
  const spec = options.provider ? PROVIDERS[options.provider as ProviderId] : availableProviders(environment)[0];
  if (!spec) {
    return { error: `No model provider is configured. Set one of: ${PROVIDER_IDS.map((id) => PROVIDERS[id].requires.join("+")).join(", ")}.` };
  }
  const missing = spec.requires.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) return { error: `${spec.label} needs ${missing.join(" and ")}.` };

  const model = options.model?.trim() || environment[`${spec.id.toUpperCase()}_MODEL`]?.trim() || spec.defaultModel;
  return { spec, model, provider: spec.create(environment, model), prices: resolvePrices(spec, model, environment) };
}

/**
 * The price for one model: an explicit override first, then the published catalog.
 *
 * Overrides exist because a negotiated rate is real and a list price is only a default — and
 * because a provider whose catalog is not verified here still deserves accurate accounting.
 */
export function resolvePrices(spec: ProviderSpec, model: string, environment: ProviderEnvironment): TokenPrices | undefined {
  const currency = (environment.MODEL_PRICE_CURRENCY?.trim() as Currency | undefined) ?? "USD";
  const input = Number(environment.MODEL_INPUT_PER_MILLION);
  const output = Number(environment.MODEL_OUTPUT_PER_MILLION);
  if (Number.isFinite(input) && Number.isFinite(output) && input > 0 && output > 0) {
    const cached = Number(environment.MODEL_CACHED_INPUT_PER_MILLION);
    return tokenPrices(currency, input, output, Number.isFinite(cached) && cached >= 0 ? cached : undefined);
  }
  return spec.prices[model];
}

export type ProviderStatus = {
  id: ProviderId;
  label: string;
  configured: boolean;
  /** Environment variables this provider needs that are not set. */
  missing: string[];
  model: string;
  /** Whether a price is known for the resolved model, and where it came from. */
  pricing: "catalog" | "configured" | "unknown";
};

/**
 * What is configured, what is missing, and what that means for cost reporting.
 *
 * Written for someone setting the tool up: a provider is either usable or it names the exact
 * variable that would make it usable. Pricing is reported separately because a provider can work
 * perfectly while its costs are unknowable — that combination is confusing without being told.
 */
export function describeProviders(environment: ProviderEnvironment): ProviderStatus[] {
  return PROVIDER_IDS.map((id) => {
    const spec = PROVIDERS[id];
    const missing = spec.requires.filter((name) => !environment[name]?.trim());
    const model = environment[`${id.toUpperCase()}_MODEL`]?.trim() || spec.defaultModel;
    const overridden = Number(environment.MODEL_INPUT_PER_MILLION) > 0 && Number(environment.MODEL_OUTPUT_PER_MILLION) > 0;
    return {
      id,
      label: spec.label,
      configured: missing.length === 0,
      missing,
      model,
      pricing: overridden ? "configured" : spec.prices[model] ? "catalog" : "unknown",
    };
  });
}

/** The variables that set a price for a model this build has no published rate for. */
export const PRICE_ENVIRONMENT_HINT = "MODEL_INPUT_PER_MILLION, MODEL_OUTPUT_PER_MILLION (and optionally MODEL_CACHED_INPUT_PER_MILLION, MODEL_PRICE_CURRENCY)";
