import type { AgentTurnProvider } from "../agent-runtime";
import { PROVIDER_IDS, PROVIDER_INFO, catalogPrices, isProviderId, type ProviderEnvironment, type ProviderId, type ProviderInfo } from "./provider-specs";
import { tokenPrices, type Currency, type TokenPrices } from "../money";
import { priceAliases } from "../pricing";
import { AnthropicAgentTurnProvider } from "./anthropic-agent";
import { CircuitNotionAgentTurnProvider } from "./circuitnotion-agent";
import { OpenAIAgentTurnProvider } from "./openai-agent";

/**
 * Which model providers Nova can drive, and what their tokens cost.
 *
 * Rates themselves live in `price-catalog.ts`, scoped to a model and dated. This file only resolves
 * which provider and model a session runs on, then asks the catalog what that pair costs today.
 *
 * The catalog is a default, not an authority: a model absent from it still runs, and the CLI says
 * plainly that it cannot price it rather than inventing a number.
 */

// Identity lives in `provider-specs.ts`, which imports no network client — see that file for why.
// Re-exported here so every existing importer of this module is unaffected.
export {
  PROVIDER_IDS,
  PROVIDER_INFO,
  catalogPrices,
  isProviderId,
  type ProviderEnvironment,
  type ProviderId,
  type ProviderInfo,
} from "./provider-specs";

/** A provider's identity plus the one thing that needs a vendor SDK: constructing a client. */
export type ProviderSpec = ProviderInfo & {
  create(environment: ProviderEnvironment, model: string): AgentTurnProvider;
};

/**
 * Every provider, ready to construct.
 *
 * Spread from `PROVIDER_INFO` rather than restated, so a label or a default model has exactly one
 * definition and the two halves cannot drift into disagreeing about what a provider is called.
 */
export const PROVIDERS: Record<ProviderId, ProviderSpec> = {
  anthropic: {
    ...PROVIDER_INFO.anthropic,
    create: (environment, model) =>
      new AnthropicAgentTurnProvider({
        apiKey: environment.ANTHROPIC_API_KEY!.trim(),
        model,
        baseURL: environment.ANTHROPIC_BASE_URL?.trim() || undefined,
      }),
  },
  openai: {
    ...PROVIDER_INFO.openai,
    create: (environment, model) =>
      new OpenAIAgentTurnProvider({
        apiKey: environment.OPENAI_API_KEY!.trim(),
        model,
        baseURL: environment.OPENAI_BASE_URL?.trim() || undefined,
      }),
  },
  circuitnotion: {
    ...PROVIDER_INFO.circuitnotion,
    create: (environment, model) =>
      new CircuitNotionAgentTurnProvider({
        apiKey: environment.CIRCUITNOTION_API_KEY!.trim(),
        model,
        baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined,
        relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined,
      }),
  },
  ollama: {
    ...PROVIDER_INFO.ollama,
    create: (environment, model) =>
      new OpenAIAgentTurnProvider({
        apiKey: "ollama",
        model,
        baseURL: environment.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1",
      }),
  },
};

/** Providers whose credentials are actually present, so the CLI can offer only what will work. */
export function availableProviders(environment: ProviderEnvironment): ProviderSpec[] {
  return PROVIDER_IDS.map((id) => PROVIDERS[id]).filter((spec) => spec.requires.every((name) => environment[name]?.trim()));
}

/**
 * `availableProviders`, minus a provider that requires nothing at all to look "configured".
 *
 * Ollama needs no key, so it is trivially "available" in an environment with nothing configured —
 * exactly the environment `resolveProvider`'s implicit fallback exists to reject with a real error
 * rather than silently starting a session against a local daemon nobody asked for and that is
 * probably not even running. Explicit selection (`/model ollama`, `NOVA_PROVIDER=ollama`) always
 * still works; only the *unrequested* auto-pick excludes it.
 */
function implicitlyAvailableProviders(environment: ProviderEnvironment): ProviderSpec[] {
  return availableProviders(environment).filter((spec) => spec.requires.length > 0);
}

export type ResolvedProvider = {
  spec: ProviderSpec;
  model: string;
  provider: AgentTurnProvider;
  /** Undefined when this model has no published price and none was configured. */
  prices: TokenPrices | undefined;
};

/**
 * The provider a previous session settled on, when it is still a usable answer.
 *
 * Unlike `options.provider` this is not a live request — it is stale configuration, so it fails
 * soft. A `NOVA_PROVIDER` naming a provider this build dropped, or one whose key has since been
 * removed, must not be able to refuse to start a session that would otherwise run fine; falling
 * back to the ordinary first-configured rule is strictly better than an error the user cannot act
 * on from inside a CLI that never opened.
 */
function rememberedProvider(environment: ProviderEnvironment): ProviderSpec | undefined {
  const remembered = environment.NOVA_PROVIDER?.trim();
  if (!remembered || !isProviderId(remembered)) return undefined;
  const spec = PROVIDERS[remembered];
  return spec.requires.every((name) => environment[name]?.trim()) ? spec : undefined;
}

/**
 * Picks the provider and model for a session.
 *
 * An explicit choice is honoured even when its credentials are missing, so the error names the
 * thing the user asked for. Without a choice, the provider a previous session persisted wins, and
 * failing that the first configured provider — in catalog order, which is deliberate rather than
 * alphabetical.
 */
export function resolveProvider(
  environment: ProviderEnvironment,
  options: { provider?: string; model?: string } = {},
): ResolvedProvider | { error: string } {
  if (options.provider && !isProviderId(options.provider)) {
    return { error: `Unknown provider "${options.provider}". Choose one of: ${PROVIDER_IDS.join(", ")}.` };
  }
  const spec = options.provider
    ? PROVIDERS[options.provider as ProviderId]
    : rememberedProvider(environment) ?? implicitlyAvailableProviders(environment)[0];
  if (!spec) {
    return { error: `No model provider is configured. Set one of: ${PROVIDER_IDS.map((id) => PROVIDERS[id].requires.join("+")).join(", ")}.` };
  }
  const missing = spec.requires.filter((name) => !environment[name]?.trim());
  if (missing.length > 0) return { error: `${spec.label} needs ${missing.join(" and ")}.` };

  const model = options.model?.trim() || environment[`${spec.id.toUpperCase()}_MODEL`]?.trim() || spec.defaultModel;
  return { spec, model, provider: spec.create(environment, model), prices: resolvePrices(spec, model, environment) };
}

/**
 * Which model a configured override is a price *for*.
 *
 * An override without a model is the bug this exists to close. `MODEL_INPUT_PER_MILLION` used to
 * apply to whatever model was current, so switching mid-session with `/model` carried a rate quoted
 * for one model onto another — still producing a confident number, just for the wrong rate card.
 *
 * `MODEL_PRICE_MODEL` names the model explicitly. Without it the override binds to the model the
 * environment itself configures, which is what the person setting those variables was looking at
 * when they set them; switching away from that model correctly drops back to the catalog.
 */
function overrideApplies(spec: ProviderSpec, model: string, environment: ProviderEnvironment): boolean {
  // Compared against the model's version aliases, the same way the catalog is looked up: someone
  // who wrote down a rate for `claude-sonnet-5` means it for the dated snapshot of it they are
  // actually served, and an exact-string test silently drops their rate the moment they pin one.
  const aliases = priceAliases(model);
  const named = environment.MODEL_PRICE_MODEL?.trim();
  if (named) return aliases.includes(named);
  return aliases.includes(environment[`${spec.id.toUpperCase()}_MODEL`]?.trim() || spec.defaultModel);
}

/**
 * The price for one model: an explicit override first, then the dated catalog.
 *
 * Overrides exist because a negotiated rate is real and a list price is only a default — and
 * because a provider whose catalog is not verified here still deserves accurate accounting.
 */
export function resolvePrices(spec: ProviderSpec, model: string, environment: ProviderEnvironment, asOf?: string): TokenPrices | undefined {
  const currency = (environment.MODEL_PRICE_CURRENCY?.trim() as Currency | undefined) ?? "USD";
  const input = Number(environment.MODEL_INPUT_PER_MILLION);
  const output = Number(environment.MODEL_OUTPUT_PER_MILLION);
  if (Number.isFinite(input) && Number.isFinite(output) && input > 0 && output > 0 && overrideApplies(spec, model, environment)) {
    const cached = Number(environment.MODEL_CACHED_INPUT_PER_MILLION);
    return tokenPrices(currency, input, output, Number.isFinite(cached) && cached >= 0 ? cached : undefined);
  }
  return catalogPrices(spec.id, model, asOf);
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
    const overridden = Number(environment.MODEL_INPUT_PER_MILLION) > 0
      && Number(environment.MODEL_OUTPUT_PER_MILLION) > 0
      && overrideApplies(spec, model, environment);
    return {
      id,
      label: spec.label,
      configured: missing.length === 0,
      missing,
      model,
      pricing: overridden ? "configured" : catalogPrices(id, model) ? "catalog" : "unknown",
    };
  });
}

/** The variables that set a price for a model this build has no published rate for. */
export const PRICE_ENVIRONMENT_HINT = "MODEL_INPUT_PER_MILLION, MODEL_OUTPUT_PER_MILLION (and optionally MODEL_CACHED_INPUT_PER_MILLION, MODEL_PRICE_CURRENCY, MODEL_PRICE_MODEL)";
