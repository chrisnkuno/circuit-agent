import { PROVIDERS, catalogPrices } from "@circuit-nova/nova-core/providers/agent-matrix";
import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";
import { formatMoney, money } from "@circuit-nova/nova-core/money";
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
  /** What this provider uses when no model is named. */
  isDefault: boolean;
  /** Per-million input/output, already formatted, or undefined when the catalog has no rate. */
  price?: string;
};

/**
 * Text models known to this build, provider default first.
 *
 * Only text, and only tokens: the catalog also prices embeddings, images and audio, and offering
 * `text-embedding-3-large` as something to hold a conversation with is offering a mistake.
 */
export function modelsForProvider(provider: ProviderId): string[] {
  const seen = new Set<string>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider || record.modality !== "text" || record.billingUnit !== "tokens") continue;
    seen.add(record.model);
  }
  const fallback = PROVIDERS[provider].defaultModel;
  seen.add(fallback);
  return [fallback, ...[...seen].filter((model) => model !== fallback).sort()];
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
export function buildModelOptions(configured: ProviderId, asOf?: string): ModelOption[] {
  const options: ModelOption[] = [];
  for (const provider of DESKTOP_PROVIDERS) {
    const spec = PROVIDERS[provider];
    for (const model of modelsForProvider(provider)) {
      options.push({
        provider,
        providerLabel: spec.label,
        model,
        isDefault: model === spec.defaultModel,
        ...(describePrice(provider, model, asOf) ? { price: describePrice(provider, model, asOf)! } : {}),
      });
    }
  }
  void configured;
  return options;
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
