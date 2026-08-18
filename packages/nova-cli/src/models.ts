import { PROVIDER_IDS, PROVIDERS, catalogPrices, isProviderId, type ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";
import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";
import { formatMoney, money, type Currency, type TokenPrices } from "@circuit-nova/nova-core/money";

/**
 * The models a session can actually switch to, and what each costs.
 *
 * `/model anthropic claude-sonnet-5` only helps someone who already knows both halves of that
 * answer. The list exists in the price catalog, so it can be shown — and once it can be shown it
 * can be numbered, and choosing becomes typing `3` rather than recalling an exact model id.
 *
 * Two rules keep the list honest:
 *
 * - **Only text models.** The catalog also prices embeddings, images and audio; offering
 *   `text-embedding-3-large` as something to hold a conversation with is offering a mistake.
 * - **Only configured providers.** A model whose provider has no key cannot be selected, and
 *   listing it produces a menu where some entries fail on choosing. Those are reported separately,
 *   as something to configure rather than something to pick.
 */

export type ModelChoice = {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  /** True for the model this provider uses when none is named. */
  isProviderDefault: boolean;
  /** Undefined when the catalog has no rate for it — the CLI says so rather than inventing one. */
  prices: TokenPrices | undefined;
  /**
   * True for a model the provider reported that this build had never heard of.
   *
   * Shown, not hidden: the list's job is "what can I switch to", and a model missing from the
   * price table is disproportionately likely to be the new one someone actually wants.
   */
  live?: boolean;
};

export type ModelCatalog = {
  choices: ModelChoice[];
  /** Providers with a model to offer but no credentials, so the list can explain the absence. */
  unconfigured: Array<{ provider: ProviderId; label: string; missing: string[] }>;
};

/**
 * Text models known to this build, per provider, in catalog order.
 *
 * The provider's own default comes first within its group: it is the one a user gets by doing
 * nothing, so it is the one they are most likely to want back.
 */
export function modelsForProvider(provider: ProviderId, asOf?: string): string[] {
  const seen = new Set<string>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider || record.modality !== "text" || record.billingUnit !== "tokens") continue;
    seen.add(record.model);
  }
  const fallback = PROVIDERS[provider].defaultModel;
  seen.add(fallback);
  const models = [...seen].filter((model) => model !== fallback).sort();
  void asOf;
  return [fallback, ...models];
}

/**
 * The catalog, optionally widened by what the providers themselves report.
 *
 * `live` is a map of provider to model ids, from `model-fetch.ts`. Absent, this behaves exactly as
 * it always has, which is what keeps every offline path and every test that predates fetching
 * working unchanged.
 */
export function buildModelCatalog(
  environment: Record<string, string | undefined>,
  asOf?: string,
  live?: Partial<Record<ProviderId, readonly string[]>>,
): ModelCatalog {
  const choices: ModelChoice[] = [];
  const unconfigured: ModelCatalog["unconfigured"] = [];

  for (const provider of PROVIDER_IDS) {
    const spec = PROVIDERS[provider];
    const missing = spec.requires.filter((name) => !environment[name]?.trim());
    if (missing.length > 0) {
      unconfigured.push({ provider, label: spec.label, missing });
      continue;
    }
    const known = modelsForProvider(provider, asOf);
    const knownSet = new Set(known);
    const extra = (live?.[provider] ?? []).filter((model) => !knownSet.has(model)).slice().sort();
    for (const model of [...known, ...extra]) {
      choices.push({
        provider,
        providerLabel: spec.label,
        model,
        isProviderDefault: model === (environment[`${provider.toUpperCase()}_MODEL`]?.trim() || spec.defaultModel),
        prices: catalogPrices(provider, model, asOf),
        ...(knownSet.has(model) ? {} : { live: true }),
      });
    }
  }
  return { choices, unconfigured };
}

/** Per-million input/output rates in the display currency, or a plain admission of not knowing. */
export function describePrice(prices: TokenPrices | undefined, display: Currency, convert: (value: { currency: Currency; micros: number }) => { currency: Currency; micros: number } | undefined): string {
  if (!prices) return "unpriced";
  const input = convert({ currency: prices.currency, micros: prices.inputPerMillion });
  const output = convert({ currency: prices.currency, micros: prices.outputPerMillion });
  if (!input || !output) {
    // Unconverted, in the provider's own currency. `money()` and not `fromUnits()`: these are
    // already micros, and multiplying them by a million again renders a 1,610 RWF rate as
    // "RWF 1,610,000,000" — a number wrong by six orders of magnitude on the fallback path nobody
    // sees until an exchange rate is missing.
    return `${formatMoney(money(prices.inputPerMillion, prices.currency))}/${formatMoney(money(prices.outputPerMillion, prices.currency))} per Mtok`;
  }
  void display;
  return `${formatMoney(input)}/${formatMoney(output)} per Mtok`;
}

export type ModelCommand =
  | { kind: "list" }
  | { kind: "pick"; index: number }
  | { kind: "query"; text: string }
  | { kind: "explicit"; provider?: string; model?: string };

/**
 * Reads `/model`, `/models`, `/model 3`, `/model opus`, `/model anthropic claude-sonnet-5`.
 *
 * A bare `/model` lists rather than doing nothing: with a numbered menu available, showing it is
 * the most useful reading of an argumentless command, and it costs a keystroke to then choose.
 *
 * A lone word that is not a provider is a *query*, not a provider. Reading it as a provider is what
 * made `/model opus` fail with `Unknown provider "opus"` — an error about a word the user never
 * meant as a provider, offering a list of three provider names when what they typed was most of a
 * model id. Provider names stay reserved, so `/model openai` still means "that provider's default".
 */
export function parseModelCommand(input: string): ModelCommand | null {
  const trimmed = input.trim();
  const match = /^\/models?(?:\s+(.*))?$/.exec(trimmed);
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (!rest) return { kind: "list" };
  if (/^\d+$/.test(rest)) return { kind: "pick", index: Number(rest) };
  const [provider, model] = rest.split(/\s+/);
  if (model === undefined && !isProviderId(provider)) return { kind: "query", text: provider };
  return { kind: "explicit", provider, model };
}

export type ModelMatch =
  | { kind: "match"; choice: ModelChoice }
  | { kind: "ambiguous"; candidates: ModelChoice[] }
  | { kind: "none" };

/**
 * Finds the model a partial name means.
 *
 * Ranked in tiers — exact id, then prefix, then substring — and only the best non-empty tier is
 * considered. Tiers rather than one flat pool is what makes `/model claude-opus-5` land on that
 * model even while `claude-opus-5-fast` also contains it: an exact id is never ambiguous with the
 * things it is a prefix of, which would otherwise make the most precise thing a user can type the
 * one input guaranteed to need disambiguating.
 *
 * A tie inside a tier is reported, not guessed. Two models matching `sonnet` are two different bills
 * and two different sets of abilities, and silently taking the first is a switch the user did not
 * ask for and has no reason to notice.
 */
export function matchModelQuery(catalog: ModelCatalog, query: string): ModelMatch {
  const needle = query.trim().toLowerCase();
  if (!needle) return { kind: "none" };
  const tiers: ModelChoice[][] = [[], [], []];
  for (const choice of catalog.choices) {
    const model = choice.model.toLowerCase();
    if (model === needle) tiers[0].push(choice);
    else if (model.startsWith(needle)) tiers[1].push(choice);
    else if (model.includes(needle)) tiers[2].push(choice);
  }
  const best = tiers.find((tier) => tier.length > 0);
  if (!best) return { kind: "none" };
  return best.length === 1 ? { kind: "match", choice: best[0] } : { kind: "ambiguous", candidates: best };
}
