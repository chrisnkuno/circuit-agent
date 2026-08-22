// `provider-specs` rather than `agent-matrix`: identical data, but importing the matrix reaches
// `create()` and through it both vendor SDKs, which this bundle would then ship to a browser
// that never calls either — every request goes through the sidecar.
import { PROVIDER_INFO, catalogPrices } from "@circuit-nova/nova-core/providers/provider-specs";
import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";
import { formatMoney, money } from "@circuit-nova/nova-core/money";
import { mergeModelLists } from "@circuit-nova/nova-core/providers/model-list";
import type { ProviderId } from "./settings";

/**
 * The models this app can switch to, and what they cost.
 *
 * The sidecar has had a `model.set` handler since the app was written and nothing ever called it:
 * changing model meant opening Settings and typing an exact id like `gpt-5.6-luna` from memory.
 * The list of models is not a secret — it is in the price catalog the cost panel already reads —
 * so it can be shown, and once it can be shown, switching is a click.
 *
 * Built from `@circuit-nova/nova-core` rather than a list kept here, so the desktop app and the
 * CLI cannot drift into offering different models or quoting different prices.
 */

export type ModelOption = {
  provider: ProviderId;
  providerLabel: string;
  model: string;
  /** True when this provider has no key yet, so choosing it has to send you to Settings first. */
  needsKey?: boolean;
  /** What this provider uses when no model is named. */
  isDefault: boolean;
  /** Per-million input/output, already formatted, or undefined when the catalog has no rate. */
  price?: string;
  /**
   * True when this model came from the provider rather than the price catalog.
   *
   * Worth marking in the menu, because it is exactly the set whose `price` is missing: the model
   * is real and selectable, and what it costs is genuinely unknown to this build rather than free.
   */
  live?: boolean;
};

/**
 * Text models known to this build, provider default first.
 *
 * Only text, and only tokens: the catalog also prices embeddings, images and audio, and offering
 * `text-embedding-3-large` as something to hold a conversation with is offering a mistake.
 */
export function modelsForProvider(provider: ProviderId, live?: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider || record.modality !== "text" || record.billingUnit !== "tokens") continue;
    seen.add(record.model);
  }
  const fallback = PROVIDER_INFO[provider].defaultModel;
  seen.add(fallback);
  const known = [fallback, ...[...seen].filter((model) => model !== fallback).sort()];
  // Known ids keep the order they were given — the default first, then the catalog — and anything
  // the provider named that this build has never heard of is appended. Merged with the CLI's own
  // rule rather than a second one, so the same key produces the same menu in both surfaces.
  return mergeModelLists(known, live);
}

/**
 * Per-million input/output rates, formatted.
 *
 * `inputPerMillion` is already in micros, so it is wrapped with `money()` rather than `fromUnits()`
 * — the latter multiplies by a million and turns a 1,610 RWF rate into "RWF 1,610,000,000".
 */
function describePrice(provider: ProviderId, model: string, asOf?: string): string | undefined {
  const prices = catalogPrices(provider, model, asOf);
  if (!prices) return undefined;
  return `${formatMoney(money(prices.inputPerMillion, prices.currency))} / ${formatMoney(money(prices.outputPerMillion, prices.currency))} per Mtok`;
}

export const DESKTOP_PROVIDERS: readonly ProviderId[] = ["circuitnotion", "openai", "anthropic"];

/**
 * Every switchable model, grouped by provider in a stable order.
 *
 * Unlike the CLI this does not hide providers without a key: the desktop app holds one provider's
 * credentials at a time and switching provider is a legitimate thing to do from here, so the
 * unusable ones are listed and marked rather than omitted. Hiding them would make the menu look
 * like the app only supports one provider.
 */
export function buildModelOptions(
  configured: ProviderId | ReadonlySet<ProviderId>,
  options: { asOf?: string; live?: Partial<Record<ProviderId, string[]>> } = {},
): ModelOption[] {
  const { asOf, live } = options;
  // Accepts either the single selected provider (what every earlier caller passed) or the set that
  // actually has keys. The set is what lets a row say "needs a key" instead of letting someone
  // choose a model that cannot run — the switch itself succeeds, and the failure arrives a turn
  // later as a 401 with no obvious cause.
  const ready = typeof configured === "string" ? new Set<ProviderId>([configured]) : configured;
  const rows: ModelOption[] = [];
  for (const provider of DESKTOP_PROVIDERS) {
    const spec = PROVIDER_INFO[provider];
    const fromCatalog = new Set(modelsForProvider(provider));
    for (const model of modelsForProvider(provider, live?.[provider])) {
      const price = describePrice(provider, model, asOf);
      rows.push({
        provider,
        providerLabel: spec.label,
        model,
        isDefault: model === spec.defaultModel,
        ...(ready.has(provider) ? {} : { needsKey: true }),
        ...(fromCatalog.has(model) ? {} : { live: true }),
        ...(price ? { price } : {}),
      });
    }
  }
  return rows;
}

/** Case-insensitive substring match, ranked so a prefix beats a mid-string hit. */
export function filterModels(options: readonly ModelOption[], query: string): ModelOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...options];
  const rank = (option: ModelOption): number => {
    const model = option.model.toLowerCase();
    if (model.startsWith(needle)) return 0;
    if (model.includes(needle)) return 1;
    return option.providerLabel.toLowerCase().includes(needle) ? 2 : 3;
  };
  return options
    .map((option, index) => ({ option, index, tier: rank(option) }))
    .filter((entry) => entry.tier < 3)
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map((entry) => entry.option);
}
