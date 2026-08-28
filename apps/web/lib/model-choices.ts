import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";

/**
 * The models a person can actually choose, derived from the priced catalog rather than a
 * hand-written list — a model nobody has a rate for cannot be offered as a priced choice.
 */
export type ModelChoice = {
  id: string;
  provider: string;
  /** Input rate per million tokens, in the provider's own quoted currency. */
  inputRate?: number;
  currency?: string;
};

const NON_MODEL_METERS = new Set(["search", "sandbox", "browser", "storage"]);

export function modelChoicesFor(provider: string): ModelChoice[] {
  const byModel = new Map<string, ModelChoice>();
  for (const record of PRICE_CATALOG) {
    if (record.provider !== provider) continue;
    if (NON_MODEL_METERS.has(record.model)) continue;
    if (record.modality !== "text" || record.billingUnit !== "tokens") continue;
    if (byModel.has(record.model)) continue;
    byModel.set(record.model, {
      id: record.model,
      provider: record.provider,
      inputRate: record.per === 1_000_000 ? record.rates.input : undefined,
      currency: record.currency,
    });
  }
  return [...byModel.values()].sort((a, b) => a.id.localeCompare(b.id));
}
