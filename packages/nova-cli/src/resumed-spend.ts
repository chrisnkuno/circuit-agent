import { readEventJournal } from "@circuit-nova/nova-core/nova-cli/protocol";
import { addMoney, convertTo, priceUsage, zero, type Currency, type FxRate, type Money, type TokenPrices } from "@circuit-nova/nova-core/money";
import type { ModelUsage } from "@circuit-nova/nova-core/providers/model";

/**
 * What a session spent before this process resumed it.
 *
 * The obvious source is the session record's own `totalRwf`, and it is the wrong one. That field
 * is the runtime's integer runaway guard, and its unit is not fixed: `modelPriceCatalogFor` feeds
 * the runtime exact per-million micro-rates when a budget was approved and a coarse whole-currency
 * rate when none was, so the same number means micros in one run and something near whole dollars
 * in the next. A figure whose unit depends on a flag nobody recorded cannot be added to money.
 *
 * The event journal has what the record does not: `model_turn` events carrying real `ModelUsage`
 * and the model that produced it. Tokens are unambiguous, they are already the canonical durable
 * record, and pricing them here means the CLI's own currency-aware rate card does the arithmetic —
 * the same one that priced the turns when they happened.
 */

export type SessionModelTurn = { model: string; usage: ModelUsage };

/** Every model call a past session made, oldest first, as its journal recorded them. */
export async function readSessionModelTurns(root: string, sessionId: string): Promise<SessionModelTurn[]> {
  const events = await readEventJournal(root, sessionId);
  const turns: SessionModelTurn[] = [];
  for (const envelope of events) {
    const { payload } = envelope;
    if (payload.type !== "runtime" || payload.event.type !== "model_turn") continue;
    turns.push({ model: payload.event.model, usage: payload.event.usage });
  }
  return turns;
}

export type SessionSpend = {
  /** In the display currency; undefined when nothing could be priced. */
  spent: Money | undefined;
  /** Models whose turns could not be priced, so the caller can say the total is a floor. */
  unpriced: string[];
};

/**
 * Prices a past session's model calls in the display currency.
 *
 * Priced per recorded model rather than at one blended rate, because a session that switched
 * models mid-thread spent at two different rates and charging all of it at the current one is
 * simply a wrong number. Today's rate card is used for turns that ran under an older one — an
 * approximation, and the only one available, since the journal records what was consumed rather
 * than what it was billed at.
 *
 * Models the catalog cannot price are named rather than counted as free: a total that silently
 * omits a component reads exactly like a complete one.
 */
export function priceSessionModelTurns(
  turns: readonly SessionModelTurn[],
  options: {
    display: Currency;
    rates?: readonly FxRate[];
    /** Rate card for a model id, when the catalog knows one. */
    pricesFor: (model: string) => TokenPrices | undefined;
  },
): SessionSpend {
  const unpriced = new Set<string>();
  let total: Money | undefined;
  for (const turn of turns) {
    const prices = options.pricesFor(turn.model);
    if (!prices) { unpriced.add(turn.model); continue; }
    const cost = priceUsage(
      { inputTokens: turn.usage.inputTokens, outputTokens: turn.usage.outputTokens, cachedInputTokens: turn.usage.cachedInputTokens },
      prices,
    );
    const shown = convertTo(cost, options.display, options.rates ?? []);
    // An unconvertible currency is the same kind of gap as an unknown rate, and is reported the
    // same way: named, not quietly dropped into the total as if it were zero.
    if (!shown) { unpriced.add(turn.model); continue; }
    total = addMoney(total ?? zero(options.display), shown);
  }
  return { spent: total, unpriced: [...unpriced].sort() };
}
