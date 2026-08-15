import { addMoney, convertTo, formatMoney, priceUsage, zero, type Currency, type FxRate, type Money, type TokenPrices } from "../money";
import type { ModelUsage } from "../providers/model";

/**
 * What this session is costing, while it is still cheap to change course.
 *
 * The hosted product quotes before it spends and settles after, because someone else's money is
 * involved. A CLI has the same obligation for a different reason: the cost of an agent session is
 * invisible until the bill arrives, and an agent that quietly burns budget re-reading the same file
 * looks identical to one doing careful work. Showing the number after every turn is what makes the
 * difference visible while the user can still stop it.
 */

export type TurnCost = {
  turnNumber: number;
  usage: ModelUsage;
  /** Priced in the provider's own currency; undefined when the model has no known price. */
  cost: Money | undefined;
  iterations: number;
  toolCalls: number;
  elapsedMs: number;
};

export type CostLedgerOptions = {
  /** What this model's tokens cost, in the currency the provider publishes. */
  prices?: TokenPrices;
  /** What the user wants to read. Costs are converted for display only. */
  display: Currency;
  rates?: readonly FxRate[];
  /** Session cap, expressed in the display currency. */
  budget?: Money;
};

const emptyUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

export class CostLedger {
  private readonly turns: TurnCost[] = [];

  constructor(private readonly options: CostLedgerOptions) {}

  /** Prices a turn from its usage, so callers never have to know the rate card. */
  record(entry: Omit<TurnCost, "turnNumber" | "cost">): TurnCost {
    const cost = this.options.prices
      ? priceUsage({ inputTokens: entry.usage.inputTokens, outputTokens: entry.usage.outputTokens, cachedInputTokens: entry.usage.cachedInputTokens }, this.options.prices)
      : undefined;
    const turn = { ...entry, cost, turnNumber: this.turns.length + 1 };
    this.turns.push(turn);
    return turn;
  }

  /** True when this session can be priced at all. */
  get priced(): boolean {
    return this.options.prices !== undefined;
  }

  /** Session total in the provider's currency, or undefined when unpriced. */
  get total(): Money | undefined {
    if (!this.options.prices) return undefined;
    return this.turns.reduce<Money>((sum, turn) => (turn.cost ? addMoney(sum, turn.cost) : sum), zero(this.options.prices.currency));
  }

  /**
   * The session total as the user asked to see it.
   *
   * Returns undefined rather than a converted-looking number when no rate exists — a cost shown in
   * the wrong currency is worse than no cost at all.
   */
  get displayTotal(): Money | undefined {
    const total = this.total;
    return total ? convertTo(total, this.options.display, this.options.rates ?? []) : undefined;
  }

  get totalUsage(): ModelUsage {
    return this.turns.reduce<ModelUsage>((total, turn) => ({
      inputTokens: total.inputTokens + turn.usage.inputTokens,
      outputTokens: total.outputTokens + turn.usage.outputTokens,
      totalTokens: total.totalTokens + turn.usage.totalTokens,
      cachedInputTokens: total.cachedInputTokens + turn.usage.cachedInputTokens,
      cacheWriteTokens: total.cacheWriteTokens + turn.usage.cacheWriteTokens,
      reasoningTokens: total.reasoningTokens + turn.usage.reasoningTokens,
    }), { ...emptyUsage });
  }

  get history(): TurnCost[] {
    return [...this.turns];
  }

  /**
   * What the cached input tokens saved.
   *
   * Worth surfacing separately because it is the one number a user can act on: a session with no
   * cache hits is one where something — a changing system prompt, a reordered history — is
   * defeating the provider's cache, and that is a real and fixable cost.
   */
  get cacheSavings(): Money | undefined {
    const { prices } = this.options;
    const cached = this.totalUsage.cachedInputTokens;
    if (!prices || cached === 0 || prices.cachedInputPerMillion === undefined) return undefined;
    const full = priceUsage({ inputTokens: cached, outputTokens: 0 }, prices);
    const discounted = priceUsage({ inputTokens: cached, outputTokens: 0, cachedInputTokens: cached }, prices);
    return { micros: full.micros - discounted.micros, currency: prices.currency };
  }

  /** Fraction of the budget spent, or undefined when uncapped or unpriceable. */
  get budgetFraction(): number | undefined {
    const budget = this.options.budget;
    const spent = this.displayTotal;
    if (!budget || budget.micros <= 0 || !spent) return undefined;
    return spent.micros / budget.micros;
  }

  /**
   * How many more turns like the ones so far the remaining budget affords, at the average cost
   * per turn observed this session.
   *
   * Deliberately not a time-based projection — how fast turns arrive says nothing about what they
   * cost, and a number derived from that would look precise while meaning nothing. Average cost
   * per turn is the one honest signal this session has produced about itself.
   */
  get turnsRemaining(): number | undefined {
    const budget = this.options.budget;
    const spent = this.displayTotal;
    if (!budget || budget.micros <= 0 || !spent || this.turns.length === 0) return undefined;
    const remaining = budget.micros - spent.micros;
    if (remaining <= 0) return 0;
    const averagePerTurn = spent.micros / this.turns.length;
    if (averagePerTurn <= 0) return undefined; // every priced turn cost nothing — no rate to project
    return Math.floor(remaining / averagePerTurn);
  }

  /** One line for after each turn: what this cost, and what the session has cost so far. */
  formatTurn(turn: TurnCost): string {
    const parts = [`${turn.iterations} turns`, `${turn.toolCalls} tools`];
    const shown = turn.cost ? convertTo(turn.cost, this.options.display, this.options.rates ?? []) : undefined;
    parts.push(shown ? formatMoney(shown) : "cost unknown");
    parts.push(`${(turn.elapsedMs / 1_000).toFixed(1)}s`);
    const sessionTotal = this.displayTotal;
    if (this.turns.length > 1 && sessionTotal) parts.push(`session ${formatMoney(sessionTotal)}`);
    return parts.join(" · ");
  }

  /** The full breakdown, for `/cost`. */
  formatReport(): string {
    const usage = this.totalUsage;
    const total = this.displayTotal;
    const savings = this.cacheSavings;
    const shownSavings = savings ? convertTo(savings, this.options.display, this.options.rates ?? []) : undefined;
    const lines = [
      total
        ? `Session cost: ${formatMoney(total)} over ${this.turns.length} request${this.turns.length === 1 ? "" : "s"}`
        : `Session cost: unknown — no price is configured for this model (${this.turns.length} request${this.turns.length === 1 ? "" : "s"})`,
      `  input   ${usage.inputTokens.toLocaleString()} tokens${usage.cachedInputTokens > 0 ? ` (${usage.cachedInputTokens.toLocaleString()} cached${shownSavings ? `, saving ${formatMoney(shownSavings)}` : ""})` : ""}`,
      `  output  ${usage.outputTokens.toLocaleString()} tokens${usage.reasoningTokens > 0 ? ` (${usage.reasoningTokens.toLocaleString()} reasoning)` : ""}`,
    ];

    const { prices } = this.options;
    if (prices) {
      lines.push(`  rate    ${formatMoney({ micros: prices.inputPerMillion, currency: prices.currency })} per M in · ${formatMoney({ micros: prices.outputPerMillion, currency: prices.currency })} per M out`);
    }
    // Say when a figure has crossed currencies, and on what rate — an unlabelled converted number
    // is the kind of thing nobody can reconcile against an invoice later.
    const rate = prices && prices.currency !== this.options.display
      ? (this.options.rates ?? []).find((candidate) => (candidate.from === prices.currency && candidate.to === this.options.display) || (candidate.to === prices.currency && candidate.from === this.options.display))
      : undefined;
    if (rate) lines.push(`  fx      ${rate.from}→${rate.to} at ${rate.rate} (${rate.source}, ${rate.asOf})`);
    if (prices && prices.currency !== this.options.display && !rate) {
      lines.push(`  fx      no ${prices.currency}→${this.options.display} rate configured; showing ${prices.currency}`);
    }

    const fraction = this.budgetFraction;
    if (fraction !== undefined && this.options.budget && total) {
      const remaining = this.turnsRemaining;
      const forecast = remaining !== undefined && this.turns.length > 1 ? `, ~${remaining} more turn${remaining === 1 ? "" : "s"} at this rate` : "";
      lines.push(`  budget  ${formatMoney(total)} of ${formatMoney(this.options.budget)} (${Math.round(fraction * 100)}%${forecast})`);
    }
    if (this.turns.length > 1) {
      lines.push("", "Per request:");
      for (const turn of this.turns) {
        const shown = turn.cost ? convertTo(turn.cost, this.options.display, this.options.rates ?? []) : undefined;
        lines.push(`  ${turn.turnNumber}. ${shown ? formatMoney(shown) : "unpriced"} · ${turn.iterations} model turns · ${turn.toolCalls} tools · ${(turn.elapsedMs / 1_000).toFixed(1)}s`);
      }
    }
    return lines.join("\n");
  }

  /**
   * Warns as the budget is approached rather than only when it is hit.
   *
   * A hard stop at the cap with no warning is the behaviour people describe as "it just died" —
   * the run ends mid-task with the money already spent and nothing to show.
   */
  budgetWarning(): string | undefined {
    const fraction = this.budgetFraction;
    const budget = this.options.budget;
    if (fraction === undefined || !budget) return undefined;
    if (fraction >= 1) return `Budget of ${formatMoney(budget)} is spent. Raise it with --budget to continue.`;
    if (fraction >= 0.8) {
      const remaining = this.turnsRemaining;
      const forecast = remaining !== undefined && this.turns.length > 1 ? ` — roughly ${remaining} more turn${remaining === 1 ? "" : "s"} at this rate` : "";
      return `${Math.round(fraction * 100)}% of the ${formatMoney(budget)} budget spent${forecast}.`;
    }
    return undefined;
  }

  /** True when the next request would start with the budget already gone. */
  get exhausted(): boolean {
    return (this.budgetFraction ?? 0) >= 1;
  }

  /** Reprices future turns against a different model's rate card — for switching models mid-session. */
  setPrices(prices: TokenPrices | undefined): void {
    this.options.prices = prices;
  }
}
