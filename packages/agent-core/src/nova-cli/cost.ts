import { addMoney, convertTo, formatMoney, priceUsage, zero, type Currency, type FxRate, type Money, type TokenPrices } from "../money";
import { priceUnits, selectPrice, type PriceRecord } from "../pricing";
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

/**
 * Something the task spent money on that was not model tokens.
 *
 * A coding session is not only a model. It searches the web, transcribes speech, holds a remote
 * sandbox open. Those are billed by other providers on other denominators, and omitting them does
 * not make them free — it makes the reported total quietly lower than the invoice, which is the one
 * direction a cost report must never be wrong in. It also makes a budget cap a fiction, since the
 * spending it does not see is spending it cannot stop.
 */
export type Expense = {
  /** Who charges for it, matching a catalog record's provider. */
  provider: string;
  /** The meter, matching that record's `model` field — "search", "sandbox", "transcription". */
  meter: string;
  /** How much of each of the record's rate meters was consumed. */
  quantities: Readonly<Record<string, number>>;
  /** What it was for, in the transcript's own terms: "web search: rust async runtimes". */
  label: string;
};

export type PricedExpense = Expense & {
  /** In the charging provider's currency; undefined when that meter has no known rate. */
  cost: Money | undefined;
};

export type CostLedgerOptions = {
  /** What this model's tokens cost, in the currency the provider publishes. */
  prices?: TokenPrices;
  /** What the user wants to read. Costs are converted for display only. */
  display: Currency;
  rates?: readonly FxRate[];
  /** Session cap, expressed in the display currency. */
  budget?: Money;
  /** Rates for non-model meters. Without it, expenses are recorded but reported as unpriced. */
  catalog?: readonly PriceRecord[];
  /** Date to price expenses at, for reconstructing a past session. Defaults to today. */
  asOf?: string;
};

export type AgentCostPrediction = {
  expectedIterations: number;
  inputTokensLow: number;
  inputTokensExpected: number;
  inputTokensHigh: number;
  outputTokensLow: number;
  outputTokensExpected: number;
  outputTokensHigh: number;
};

/**
 * Forecasts a bounded agent exchange from the tokens in its real first request.
 *
 * Later calls resend the conversation plus tool results, so multiplying the opening prompt by a
 * turn count systematically underestimates input. This models that cumulative growth explicitly
 * and widens the range for broad verbs that usually require more inspection and verification.
 */
export function predictAgentUsage(input: { initialInputTokens: number; objective: string; mode: "plan" | "build" | "auto" }): AgentCostPrediction {
  if (!Number.isSafeInteger(input.initialInputTokens) || input.initialInputTokens < 1) throw new Error("initialInputTokens must be a positive integer");
  const objective = input.objective.toLowerCase();
  const broad = /\b(migrate|refactor|redesign|audit|all|entire|cross-platform|production|architecture|extensive)\b/.test(objective);
  const narrow = /\b(explain|find|rename|one line|small|single|typo)\b/.test(objective);
  const base = input.mode === "plan" ? 3 : input.mode === "auto" ? 7 : 6;
  const expectedIterations = Math.max(1, Math.min(12, base + (broad ? 2 : 0) - (narrow ? 1 : 0)));
  const toolResultTokensPerIteration = input.mode === "plan" ? 850 : 1_350;
  const outputTokensPerIteration = input.mode === "plan" ? 450 : 650;
  // Every later request contains the earlier assistant/tool material. The triangular term is the
  // part fixed per-request calculators miss.
  const growth = toolResultTokensPerIteration + outputTokensPerIteration;
  const inputTokensExpected = Math.round(
    expectedIterations * input.initialInputTokens + (expectedIterations * (expectedIterations - 1) / 2) * growth,
  );
  const outputTokensExpected = expectedIterations * outputTokensPerIteration;
  return {
    expectedIterations,
    inputTokensLow: Math.max(input.initialInputTokens, Math.round(inputTokensExpected * 0.62)),
    inputTokensExpected,
    inputTokensHigh: Math.round(inputTokensExpected * 1.65),
    outputTokensLow: Math.round(outputTokensExpected * 0.55),
    outputTokensExpected,
    outputTokensHigh: Math.round(outputTokensExpected * 1.7),
  };
}

const emptyUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

export class CostLedger {
  private readonly turns: TurnCost[] = [];
  private readonly expenses: PricedExpense[] = [];

  constructor(private readonly options: CostLedgerOptions) {}

  /**
   * Records something the task spent outside the model, priced from the catalog.
   *
   * Recorded even when it cannot be priced: knowing eleven searches happened for an unknown amount
   * is strictly better than the total silently omitting them, and it names exactly which rate is
   * missing from the catalog.
   */
  recordExpense(entry: Expense): PricedExpense {
    const record = this.options.catalog
      ? selectPrice(this.options.catalog, { provider: entry.provider, model: entry.meter, asOf: this.options.asOf })
      : undefined;
    const priced = { ...entry, cost: record ? priceUnits(record, entry.quantities) : undefined };
    this.expenses.push(priced);
    return priced;
  }

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

  /** Model-token total in the provider's currency, or undefined when unpriced. */
  get total(): Money | undefined {
    if (!this.options.prices) return undefined;
    return this.turns.reduce<Money>((sum, turn) => (turn.cost ? addMoney(sum, turn.cost) : sum), zero(this.options.prices.currency));
  }

  get expenseHistory(): PricedExpense[] {
    return [...this.expenses];
  }

  /**
   * Non-model spending, in the display currency.
   *
   * Summed in the display currency rather than the charging one because these meters need not agree
   * on a currency — a USD search provider and an RWF sandbox bill in one session — and there is no
   * meaningful "native" total across them. Undefined means there is nothing to add, not zero.
   */
  get expenseTotal(): Money | undefined {
    const converted = this.expenses.map((expense) => (expense.cost ? convertTo(expense.cost, this.options.display, this.options.rates ?? []) : undefined));
    const usable = converted.filter((value): value is Money => value !== undefined);
    if (usable.length === 0) return undefined;
    return usable.reduce((sum, value) => addMoney(sum, value), zero(this.options.display));
  }

  /** True when something was spent that the ledger could not price. */
  get hasUnpricedSpend(): boolean {
    return this.expenses.some((expense) => expense.cost === undefined) || (this.turns.length > 0 && !this.options.prices);
  }

  /**
   * Everything this session has cost, as the user asked to see it.
   *
   * Tokens plus every other meter — the number a budget is actually checked against. Returns
   * undefined rather than a converted-looking number when no rate exists: a cost shown in the wrong
   * currency is worse than no cost at all.
   */
  get displayTotal(): Money | undefined {
    const total = this.total;
    const models = total ? convertTo(total, this.options.display, this.options.rates ?? []) : undefined;
    const expenses = this.expenseTotal;
    if (!models) return expenses;
    return expenses ? addMoney(models, expenses) : models;
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

  /** Preflight token and price range for the next request; no provider call is made. */
  formatPrediction(prediction: AgentCostPrediction): string {
    const tokens = `${prediction.inputTokensLow.toLocaleString()}–${prediction.inputTokensHigh.toLocaleString()} input + ${prediction.outputTokensLow.toLocaleString()}–${prediction.outputTokensHigh.toLocaleString()} output tokens`;
    if (!this.options.prices) return `Estimated: ${tokens} · cost unknown (model is unpriced)`;
    const low = convertTo(priceUsage({ inputTokens: prediction.inputTokensLow, outputTokens: prediction.outputTokensLow }, this.options.prices), this.options.display, this.options.rates ?? []);
    const high = convertTo(priceUsage({ inputTokens: prediction.inputTokensHigh, outputTokens: prediction.outputTokensHigh }, this.options.prices), this.options.display, this.options.rates ?? []);
    const cost = low && high ? `${formatMoney(low)}–${formatMoney(high)}` : "cost unavailable in display currency";
    return `Estimated: ${tokens} · ${cost} · about ${prediction.expectedIterations} model turns`;
  }

  /** The full breakdown, for `/cost`. */
  formatReport(): string {
    const usage = this.totalUsage;
    const total = this.displayTotal;
    const savings = this.cacheSavings;
    const shownSavings = savings ? convertTo(savings, this.options.display, this.options.rates ?? []) : undefined;
    // "at least" rather than a bare figure when something in the session could not be priced —
    // a total that silently omits a component reads exactly like a complete one.
    const qualifier = total && this.hasUnpricedSpend ? "at least " : "";
    const lines = [
      total
        ? `Session cost: ${qualifier}${formatMoney(total)} over ${this.turns.length} request${this.turns.length === 1 ? "" : "s"}`
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

    // Non-model spending gets its own section rather than being folded into the token lines: it is
    // the part a reader does not expect, and the part they can most directly act on by searching
    // less or letting a sandbox idle for less time.
    if (this.expenses.length > 0) {
      const shownExpenses = this.expenseTotal;
      lines.push("", `Beyond the model${shownExpenses ? `: ${formatMoney(shownExpenses)}` : ""}`);
      for (const expense of this.expenses) {
        const shown = expense.cost ? convertTo(expense.cost, this.options.display, this.options.rates ?? []) : undefined;
        const meters = Object.entries(expense.quantities).map(([meter, quantity]) => `${quantity.toLocaleString()} ${meter}`).join(", ");
        lines.push(`  ${shown ? formatMoney(shown) : `unpriced (no ${expense.provider}/${expense.meter} rate)`} · ${expense.label} · ${meters}`);
      }
    }

    const fraction = this.budgetFraction;
    if (fraction !== undefined && this.options.budget && total) {
      lines.push(`  budget  ${formatMoney(total)} of ${formatMoney(this.options.budget)} (${Math.round(fraction * 100)}%)`);
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
    if (fraction >= 0.8) return `${Math.round(fraction * 100)}% of the ${formatMoney(budget)} budget spent.`;
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
