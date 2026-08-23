import { addMoney, convertTo, formatMoney, money, priceUsage, zero, type Currency, type FxRate, type Money, type TokenPrices } from "../money";
import { priceUnits, selectPrice, type PriceRecord } from "../pricing";
import type { ModelUsage } from "../providers/model";
import type { NovaMode } from "./permissions";

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
  /**
   * What the provider itself said this call cost, in USD, when it reports one.
   *
   * Preferred over the catalog rate wherever it is present, because it is a different kind of fact:
   * the catalog applies a published list price to a quantity Nova counted, while this is the number
   * the provider will invoice. They diverge the moment a search returns fewer pages than asked for,
   * or runs a deep variant at a rate the catalog has one entry for. Exa returns it as
   * `costDollars.total` on every response.
   */
  reportedUsd?: number;
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
export function predictAgentUsage(input: { initialInputTokens: number; objective: string; mode: NovaMode }): AgentCostPrediction {
  if (!Number.isSafeInteger(input.initialInputTokens) || input.initialInputTokens < 1) throw new Error("initialInputTokens must be a positive integer");
  const objective = input.objective.toLowerCase();
  const broad = /\b(migrate|refactor|redesign|audit|all|entire|cross-platform|production|architecture|extensive)\b/.test(objective);
  const narrow = /\b(explain|find|rename|one line|small|single|typo)\b/.test(objective);
  const constrained = /\b(reply with exactly|exactly one|one grep|one search|smallest (?:correct )?(?:source )?fix|run only|only (?:read|review|search|grep)|do not (?:edit|change|run))\b/.test(objective);
  // Defender is deliberately its own profile. A real review pulls two or three playbooks, reads
  // broad code surfaces, and may ground a dependency finding in current advisory data. Treating it
  // as build hid precisely the expensive work that distinguishes the mode. Delegation is still
  // not assumed — it is optional — so the high range remains the place for that possibility.
  const base = input.mode === "plan" ? 2 : input.mode === "defender" ? 6 : 5;
  const expectedIterations = constrained
    ? 2
    : Math.max(1, Math.min(10, base + (broad ? 2 : 0) - (narrow ? 1 : 0)));
  const toolResultTokensPerIteration = input.mode === "plan" ? 850 : input.mode === "defender" ? 2_500 : 1_350;
  const outputTokensPerIteration = input.mode === "plan" ? 450 : input.mode === "defender" ? 750 : 650;
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
    inputTokensHigh: Math.round(inputTokensExpected * (input.mode === "defender" ? 2 : 1.65)),
    outputTokensLow: Math.round(outputTokensExpected * 0.55),
    outputTokensExpected,
    outputTokensHigh: Math.round(outputTokensExpected * 1.7),
  };
}

const emptyUsage: ModelUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** Below this, cache writes are too small to be worth anyone's attention, whatever their ratio. */
const CACHE_CHURN_FLOOR_TOKENS = 20_000;

/** Said once, where the numbers are, when the cache is being paid for and not used. */
export const CACHE_CHURN_HINT = [
  "The prompt cache is being rewritten more than it is read, which costs more than not caching at all.",
  "Something near the front of each request is changing between turns — a timestamp or per-turn text in",
  "the system prompt, or a tool list whose order or contents move. Caching is a prefix match: one changed",
  "byte invalidates everything after it.",
].join(" ");

export class CostLedger {
  private readonly turns: TurnCost[] = [];
  private readonly expenses: PricedExpense[] = [];
  /**
   * What resumed sessions had already spent before this process opened them, by session id.
   *
   * A ledger that starts at zero every time a session is resumed makes `--budget` a per-process
   * cap wearing a per-session label: approve five dollars, resume four times, spend twenty. The
   * spend is not lost — it is on the session record — so it is carried in here rather than
   * re-derived, and the budget is checked against what the *session* has cost.
   *
   * Keyed by session id, not summed on arrival, because resuming is repeatable: `/history resume`
   * on a session already resumed this process must restate that session's total, not add a second
   * copy of it. Two different sessions resumed in one process do both count.
   */
  private readonly carried = new Map<string, Money>();

  constructor(private readonly options: CostLedgerOptions) {}

  /**
   * Records what a resumed session had already spent, in the display currency.
   *
   * Display currency rather than the provider's, for the same reason `expenseTotal` is: a session
   * resumed after a model switch has spent in two currencies, and there is no provider currency
   * the pair share. Display is the one denominator every component of a total already agrees on.
   */
  carryForward(sessionId: string, spent: Money): void {
    if (!Number.isSafeInteger(spent.micros) || spent.micros < 0) {
      throw new Error("carried spend must be a non-negative integer amount");
    }
    if (spent.currency !== this.options.display) {
      throw new Error(`carried spend must be in the display currency (${this.options.display}), got ${spent.currency}`);
    }
    this.carried.set(sessionId, spent);
  }

  /** Spend inherited from resumed sessions, in the display currency; undefined when there is none. */
  get carriedTotal(): Money | undefined {
    if (this.carried.size === 0) return undefined;
    return [...this.carried.values()].reduce((sum, value) => addMoney(sum, value), zero(this.options.display));
  }

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
    // The provider's own figure wins when it gave one — an invoice beats an estimate, and it needs
    // no catalog entry to be usable, which is also how a newly-added meter gets priced correctly
    // before anyone has written a rate for it.
    const reported = Number.isFinite(entry.reportedUsd) && (entry.reportedUsd ?? -1) >= 0
      // Exa reports dollars ($0.007); the ledger counts integer micros throughout, so this is the
      // one place the conversion happens rather than every call site guessing at it.
      ? money(entry.reportedUsd! * 1_000_000, "USD")
      : undefined;
    const priced = { ...entry, cost: reported ?? (record ? priceUnits(record, entry.quantities) : undefined) };
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
    const parts = [models, this.expenseTotal, this.carriedTotal].filter((part): part is Money => part !== undefined);
    if (parts.length === 0) return undefined;
    return parts.reduce((sum, part) => addMoney(sum, part), zero(this.options.display));
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

  /**
   * Whether the provider's prompt cache is actually working for this session.
   *
   * The cache is the single largest lever on what a long session costs — a cached input token is
   * billed at about a tenth of a fresh one — and it is a *prefix* match, so it is defeated silently.
   * Anything that changes near the front of the request (a timestamp in the system prompt, a
   * per-turn memory block, a tool list that reorders) invalidates everything behind it, and the
   * session goes on working exactly as before while paying full price.
   *
   * The tell is not a low hit rate on its own — the first turns of any session are all misses.
   * It is *writes exceeding reads once a conversation is under way*: Nova keeps paying the 1.25x
   * premium to store a prefix that is never read back, which is strictly worse than not caching at
   * all. That is what `churning` reports, and it is worth more than the hit rate because it names a
   * bug rather than a condition.
   */
  get cacheHealth(): { readTokens: number; writeTokens: number; freshTokens: number; hitRate: number; churning: boolean } {
    const usage = this.totalUsage;
    return {
      readTokens: usage.cachedInputTokens,
      writeTokens: usage.cacheWriteTokens,
      // Provider adapters normalize inputTokens as the complete input, including cached reads.
      // Adding reads again would double-count them and turn a real 80% hit rate into 44%.
      freshTokens: Math.max(0, usage.inputTokens - usage.cachedInputTokens),
      hitRate: usage.inputTokens === 0 ? 0 : Math.min(1, usage.cachedInputTokens / usage.inputTokens),
      // Three turns before judging: a session that has only just started has legitimately written
      // more than it has read, and warning there would train everyone to ignore the warning. The
      // floor keeps a handful of tiny turns from raising it on a few hundred tokens of noise.
      churning: this.turns.length >= 3 && usage.cacheWriteTokens > CACHE_CHURN_FLOOR_TOKENS && usage.cacheWriteTokens > usage.cachedInputTokens,
    };
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
   * per turn (including non-model spend, since `displayTotal` already folds that in) is the one
   * honest signal this session has produced about itself.
   */
  get turnsRemaining(): number | undefined {
    const budget = this.options.budget;
    const spent = this.displayTotal;
    if (!budget || budget.micros <= 0 || !spent || this.turns.length === 0) return undefined;
    const remaining = budget.micros - spent.micros;
    if (remaining <= 0) return 0;
    // Averaged over what *this* process observed, not over everything the budget is checked
    // against: spend carried in from a resumed session has no turn count here to divide by, and
    // folding it into the numerator alone would inflate the per-turn rate by however long the
    // session ran before this one — turning "you have twenty turns left" into "you have two".
    const observed = this.displayTotal && this.carriedTotal
      ? { micros: spent.micros - this.carriedTotal.micros, currency: spent.currency }
      : spent;
    const averagePerTurn = observed.micros / this.turns.length;
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
    // From the first turn when spend was carried in: on a resumed session the running total is
    // already the interesting number, and withholding it until turn two reads as if the earlier
    // conversation cost nothing.
    if ((this.turns.length > 1 || this.carried.size > 0) && sessionTotal) parts.push(`session ${formatMoney(sessionTotal)}`);
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
    // Only once there is a cache to describe. A session that never touched one should not carry a
    // row of zeroes explaining a feature it did not use.
    const cache = this.cacheHealth;
    if (cache.readTokens > 0 || cache.writeTokens > 0) {
      lines.push(`  cache   ${Math.round(cache.hitRate * 100)}% of input served from cache · ${cache.writeTokens.toLocaleString()} written`);
      if (cache.churning) lines.push(`  ${CACHE_CHURN_HINT}`);
    }
    // Named rather than folded in silently: the request count and the token lines above describe
    // only what this process did, so without this line a resumed session reads as one that spent
    // far more per token than it did.
    const carried = this.carriedTotal;
    if (carried) lines.push(`  carried ${formatMoney(carried)} spent before this session was resumed`);

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

  /**
   * Reads the same session back in a different currency — for changing location mid-session.
   *
   * Only the display side moves. Turns are stored in the currency they were charged in, so past
   * spending is re-converted rather than rewritten, and the total after the change means the same
   * thing it did before: a conversion of one history, not two histories in two currencies.
   */
  setDisplay(display: Currency, rates?: readonly FxRate[]): void {
    this.options.display = display;
    if (rates) this.options.rates = rates;
  }
}
