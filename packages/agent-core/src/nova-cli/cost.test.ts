import { describe, expect, it } from "vitest";
import { formatMoney, fromUnits, tokenPrices, toUnits, type FxRate } from "../money";
import { definePrices } from "../pricing";
import { CostLedger, predictAgentUsage, type Expense } from "./cost";

/** Anthropic's published Opus rates: $5 / $25 per million, cached input at a tenth. */
const opus = tokenPrices("USD", 5, 25, 0.5);
const rwfPerUsd: FxRate = { from: "USD", to: "RWF", rate: 1_320, asOf: "2026-08-01", source: "test" };
const usage = (input: number, output: number, cached = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: cached,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

describe("cost ledger", () => {
  it("predicts cumulative agent tokens rather than pricing only the opening prompt", () => {
    const prediction = predictAgentUsage({ initialInputTokens: 2_000, objective: "refactor the entire CLI", mode: "build" });
    expect(prediction.expectedIterations).toBeGreaterThan(6);
    expect(prediction.inputTokensExpected).toBeGreaterThan(2_000 * prediction.expectedIterations);
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    expect(ledger.formatPrediction(prediction)).toMatch(/input \+ .* output tokens .*\$.*model turns/);
  });

  it("budgets defender reviews for playbooks and research instead of pretending they are build turns", () => {
    const objective = "audit the entire authentication and API surface";
    const build = predictAgentUsage({ initialInputTokens: 6_000, objective, mode: "build" });
    const defender = predictAgentUsage({ initialInputTokens: 6_000, objective, mode: "defender" });

    expect(defender.expectedIterations).toBeGreaterThan(build.expectedIterations);
    expect(defender.inputTokensExpected).toBeGreaterThan(build.inputTokensExpected);
    expect(defender.outputTokensExpected).toBeGreaterThan(build.outputTokensExpected);
  });
  it("prices each turn from its usage, in the provider's currency", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    const turn = ledger.record({ usage: usage(100_000, 2_000), iterations: 3, toolCalls: 4, elapsedMs: 12_000 });

    // 100k input at $5/M + 2k output at $25/M.
    expect(toUnits(turn.cost!)).toBeCloseTo(0.55, 6);
    expect(toUnits(ledger.total!)).toBeCloseTo(0.55, 6);
  });

  it("accumulates across a session and shows a running total after the first turn", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    const first = ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    expect(ledger.formatTurn(first)).not.toContain("session");

    const second = ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    expect(ledger.formatTurn(second)).toContain("session");
    expect(toUnits(ledger.total!)).toBeCloseTo(1.05, 6);
  });

  it("displays in the currency the user asked for, and names the rate that produced it", () => {
    const ledger = new CostLedger({ prices: opus, display: "RWF", rates: [rwfPerUsd] });
    ledger.record({ usage: usage(1_000_000, 0), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });

    // $5 at 1,320 RWF/USD.
    expect(formatMoney(ledger.displayTotal!)).toBe("RWF 6,600");
    const report = ledger.formatReport();
    // An unlabelled converted number is one nobody can reconcile against an invoice later.
    expect(report).toContain("USD→RWF at 1320");
    expect(report).toContain("2026-08-01");
  });

  it("keeps the provider's currency rather than inventing a conversion when no rate exists", () => {
    const ledger = new CostLedger({ prices: opus, display: "RWF", rates: [] });
    ledger.record({ usage: usage(1_000_000, 0), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });

    expect(ledger.displayTotal).toBeUndefined();
    expect(ledger.formatReport()).toContain("no USD→RWF rate configured");
  });

  it("says the cost is unknown rather than reporting zero for an unpriced model", () => {
    // Zero and unknown lead to very different decisions.
    const ledger = new CostLedger({ display: "USD" });
    const turn = ledger.record({ usage: usage(500_000, 10_000), iterations: 2, toolCalls: 3, elapsedMs: 5_000 });

    expect(ledger.priced).toBe(false);
    expect(turn.cost).toBeUndefined();
    expect(ledger.formatTurn(turn)).toContain("cost unknown");
    expect(ledger.formatReport()).toContain("no price is configured");
    // Token counts are still real and still reported.
    expect(ledger.formatReport()).toContain("500,000 tokens");
  });

  it("reports what the prompt cache saved, since a session with no hits is a fixable cost", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    ledger.record({ usage: usage(100_000, 0, 90_000), iterations: 4, toolCalls: 6, elapsedMs: 20_000 });

    // 90k tokens that would have cost $5/M billed at $0.50/M instead.
    expect(toUnits(ledger.cacheSavings!)).toBeCloseTo(0.405, 6);
    expect(ledger.formatReport()).toContain("90,000 cached");
  });

  it("warns before the budget is gone, not only when it is", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(1, "USD") });
    ledger.record({ usage: usage(100_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $0.50
    expect(ledger.budgetWarning()).toBeUndefined();
    expect(ledger.exhausted).toBe(false);

    ledger.record({ usage: usage(70_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $0.85 total
    expect(ledger.budgetWarning()).toContain("85%");
    expect(ledger.exhausted).toBe(false);

    ledger.record({ usage: usage(40_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $1.05
    expect(ledger.exhausted).toBe(true);
    expect(ledger.budgetWarning()).toContain("--budget");
  });

  it("forecasts turns remaining from the average cost per turn so far, once there is a trend", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(1, "USD") });
    ledger.record({ usage: usage(100_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $0.50, one turn — no trend yet
    expect(ledger.turnsRemaining).toBe(1); // still computable, just not shown in the warning below (only one turn so far)
    expect(ledger.budgetWarning()).toBeUndefined();

    ledger.record({ usage: usage(70_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $0.85 total, avg $0.425/turn
    // $0.15 left ÷ $0.425/turn average rounds down to zero more turns at this pace.
    expect(ledger.turnsRemaining).toBe(0);
    expect(ledger.budgetWarning()).toContain("more turn");
    expect(ledger.formatReport()).toContain("more turn");
  });

  it("reports zero turns remaining once the budget is already gone", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(1, "USD") });
    ledger.record({ usage: usage(300_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 }); // $1.50, over budget
    expect(ledger.turnsRemaining).toBe(0);
  });

  it("has no forecast to give when there is no budget or no price", () => {
    expect(new CostLedger({ prices: opus, display: "USD" }).turnsRemaining).toBeUndefined();
    const unpriced = new CostLedger({ display: "USD", budget: fromUnits(1, "USD") });
    unpriced.record({ usage: usage(100_000, 0), iterations: 1, toolCalls: 1, elapsedMs: 1_000 });
    expect(unpriced.turnsRemaining).toBeUndefined();
  });

  it("enforces a budget stated in the display currency against costs priced in another", () => {
    // The user says "stop at RWF 1,000"; the provider bills in USD. Both must be true at once.
    const ledger = new CostLedger({ prices: opus, display: "RWF", rates: [rwfPerUsd], budget: fromUnits(1_000, "RWF") });
    ledger.record({ usage: usage(100_000, 0), iterations: 1, toolCalls: 0, elapsedMs: 1_000 }); // $0.50 = RWF 660
    expect(Math.round((ledger.budgetFraction ?? 0) * 100)).toBe(66);
    expect(ledger.exhausted).toBe(false);

    ledger.record({ usage: usage(100_000, 0), iterations: 1, toolCalls: 0, elapsedMs: 1_000 }); // RWF 1,320
    expect(ledger.exhausted).toBe(true);
  });

  it("stays quiet about budget when the session is uncapped", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    ledger.record({ usage: usage(10_000, 5_000), iterations: 2, toolCalls: 3, elapsedMs: 5_000 });
    expect(ledger.budgetFraction).toBeUndefined();
    expect(ledger.budgetWarning()).toBeUndefined();
    expect(ledger.formatReport()).not.toContain("budget");
  });

  it("breaks the report down per request once there is more than one, and shows the budget line", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(2, "USD") });
    ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 1, elapsedMs: 1_000 });
    ledger.record({ usage: usage(50_000, 500), iterations: 2, toolCalls: 0, elapsedMs: 2_000 });

    const report = ledger.formatReport();
    expect(report).toContain("Per request:");
    expect(report).toContain("1. ");
    expect(report).toContain("2. ");
    expect(report).toMatch(/budget\s+\$[\d.]+ of \$2\.00/);
  });

  it("reports a turn as unpriced in the per-request breakdown when the model has no known price", () => {
    const ledger = new CostLedger({ display: "USD" }); // no prices at all
    ledger.record({ usage: usage(1_000, 100), iterations: 1, toolCalls: 0, elapsedMs: 500 });
    ledger.record({ usage: usage(1_000, 100), iterations: 1, toolCalls: 0, elapsedMs: 500 });
    expect(ledger.formatReport()).toContain("unpriced");
  });

  it("reprices future turns after /model switches to a different provider", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    const before = ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    expect(before.cost).toBeDefined();

    const cheaper = tokenPrices("USD", 1, 2);
    ledger.setPrices(cheaper);
    const after = ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    // The same usage, priced at the new, much cheaper rate — proof the switch actually took effect.
    expect(toUnits(after.cost!)).toBeLessThan(toUnits(before.cost!));

    ledger.setPrices(undefined);
    const unpriced = ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    expect(unpriced.cost).toBeUndefined();
  });

  it("re-reads the whole session in a new currency after the location changes", () => {
    const rate = { from: "USD", to: "RWF", rate: 1_300, asOf: "2026-08-12", source: "test" } as const;
    const ledger = new CostLedger({ prices: opus, display: "USD", rates: [rate] });
    ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    const inDollars = ledger.displayTotal!;

    ledger.setDisplay("RWF");
    const inFrancs = ledger.displayTotal!;

    // Spending recorded *before* the change is converted too, not left behind in the old currency:
    // the total still describes one history, read in different money.
    expect(inFrancs.currency).toBe("RWF");
    expect(toUnits(inFrancs)).toBeCloseTo(toUnits(inDollars) * 1_300, -3);
  });

  it("can be given the rates it needs at the same time as the currency", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    ledger.record({ usage: usage(100_000, 1_000), iterations: 1, toolCalls: 0, elapsedMs: 1_000 });
    // Without the rate arriving alongside, a session that started with nothing to convert with
    // could never move currency at all.
    ledger.setDisplay("RWF", [{ from: "USD", to: "RWF", rate: 1_300, asOf: "2026-08-12", source: "test" }]);
    expect(ledger.displayTotal?.currency).toBe("RWF");
  });
});

describe("spending beyond the model", () => {
  const catalog = definePrices([
    {
      provider: "exa", model: "search", modality: "search", currency: "USD", billingUnit: "requests",
      per: 1_000, rates: { request: 7, contents: 1 }, source: "test", effectiveFrom: "2026-01-01",
    },
    {
      provider: "e2b", model: "sandbox", modality: "compute", currency: "USD", billingUnit: "seconds",
      per: 3_600, rates: { runtime: 0.18 }, source: "test", effectiveFrom: "2026-01-01",
    },
  ]);

  const search = (results: number): Expense => ({ provider: "exa", meter: "search", quantities: { request: 1, contents: results }, label: "web search: rust async" });

  it("charges every meter a call touches, not just the headline one", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    // A ten-result search is $0.007 of request plus $0.010 of contents. Pricing only the request
    // — which the old "~$0.007 per search" figure did — understates it by more than half.
    expect(toUnits(ledger.recordExpense(search(10)).cost!)).toBeCloseTo(0.017, 6);
  });

  /**
   * The catalog rate is a published list price applied to a page count Nova counted; `reportedUsd`
   * is what the provider says it will invoice. Where they disagree the provider is right, and they
   * disagree routinely — a deep search is billed at a rate the single "exa/search" record has no
   * way to express, so pricing it from the catalog understates it.
   */
  it("prefers the provider's own reported cost over the catalog estimate", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    const catalogOnly = ledger.recordExpense(search(10));
    const reported = ledger.recordExpense({ ...search(10), reportedUsd: 0.042 });
    expect(toUnits(catalogOnly.cost!)).toBeCloseTo(0.017, 6);
    expect(toUnits(reported.cost!)).toBeCloseTo(0.042, 6);
    // And it counts toward the session total at the reported figure, not the estimated one.
    expect(toUnits(ledger.expenseTotal!)).toBeCloseTo(0.059, 6);
  });

  it("prices a reported expense even for a meter the catalog has never heard of", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    const priced = ledger.recordExpense({ provider: "exa", meter: "websets", quantities: { request: 1 }, label: "webset", reportedUsd: 0.25 });
    expect(toUnits(priced.cost!)).toBeCloseTo(0.25, 6);
  });

  it("falls back to the catalog when the reported figure is missing or nonsense", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    for (const bad of [undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(toUnits(ledger.recordExpense({ ...search(10), reportedUsd: bad as number }).cost!)).toBeCloseTo(0.017, 6);
    }
  });

  it("records a reported cost of exactly zero as free, rather than falling back to an estimate", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    expect(toUnits(ledger.recordExpense({ ...search(10), reportedUsd: 0 }).cost!)).toBe(0);
  });

  it("adds non-model spending to the session total the budget is checked against", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog, budget: fromUnits(1, "USD") });
    ledger.record({ usage: usage(100_000, 2_000), iterations: 3, toolCalls: 4, elapsedMs: 12_000 }); // $0.55
    for (let index = 0; index < 20; index += 1) ledger.recordExpense(search(10)); // $0.34

    expect(toUnits(ledger.total!)).toBeCloseTo(0.55, 6);
    expect(toUnits(ledger.expenseTotal!)).toBeCloseTo(0.34, 6);
    expect(toUnits(ledger.displayTotal!)).toBeCloseTo(0.89, 6);
    // On tokens alone this session reads as 55% spent, which is the number that lets a run sail
    // past its cap: the searches are the difference between 55% and 89%.
    expect(Math.round(ledger.budgetFraction! * 100)).toBe(89);
    expect(ledger.budgetWarning()).toMatch(/89% of the \$1\.00 budget/);
  });

  it("converts each meter into the display currency at its own rate", () => {
    const ledger = new CostLedger({ prices: opus, display: "RWF", catalog, rates: [rwfPerUsd] });
    ledger.recordExpense({ provider: "e2b", meter: "sandbox", quantities: { runtime: 1_800 }, label: "sandbox: 30m" });
    // Half an hour at $0.18/hour is $0.09, or 118.8 RWF.
    expect(formatMoney(ledger.expenseTotal!)).toBe("RWF 119");
  });

  it("records what it cannot price rather than dropping it from the total", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    ledger.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 1, elapsedMs: 900 });
    const unpriced = ledger.recordExpense({ provider: "deepgram", meter: "transcription", quantities: { seconds: 90 }, label: "voice prompt" });

    expect(unpriced.cost).toBeUndefined();
    expect(ledger.hasUnpricedSpend).toBe(true);
    const report = ledger.formatReport();
    // The total is real but incomplete, and says so — an unqualified figure here reads as final.
    expect(report).toContain("Session cost: at least $0.55");
    expect(report).toContain("unpriced (no deepgram/transcription rate)");
    expect(report).toContain("voice prompt");
  });

  it("rejects a meter the rate card does not define, instead of charging zero for it", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    expect(() => ledger.recordExpense({ provider: "exa", meter: "search", quantities: { summaries: 4 }, label: "bad meter" }))
      .toThrow('no rate for meter "summaries"');
  });

  it("leaves the report unchanged when nothing outside the model was spent", () => {
    const ledger = new CostLedger({ prices: opus, display: "USD", catalog });
    ledger.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 1, elapsedMs: 900 });
    expect(ledger.formatReport()).not.toContain("Beyond the model");
    expect(ledger.expenseTotal).toBeUndefined();
  });

  /**
   * What a resumed session does to a budget.
   *
   * The cap the user approved is a cap on the *session*, but the ledger enforcing it is built per
   * process. Left alone, that difference is a way to spend a budget over and over: resume, spend
   * the whole allowance again, resume again. The session record already carries the running total
   * across runs, so the invariant these tests pin is that the ledger is checked against that total
   * rather than against however much this particular process happens to have spent.
   */
  describe("spend carried in from a resumed session", () => {
    it("counts against the budget, so resuming does not hand back the whole allowance", () => {
      const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(1, "USD") });
      // The session had already spent $0.90 of its $1.00 before this process opened it.
      ledger.carryForward("session_a", fromUnits(0.9, "USD"));
      expect(toUnits(ledger.displayTotal!)).toBeCloseTo(0.9, 6);
      expect(ledger.exhausted).toBe(false);

      // One more turn at $0.55 takes the *session* past the cap, even though this process has
      // spent barely half of it. Without the carry the ledger would report 55% spent and keep going.
      ledger.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 0, elapsedMs: 900 });
      expect(toUnits(ledger.displayTotal!)).toBeCloseTo(1.45, 6);
      expect(ledger.exhausted).toBe(true);
      expect(ledger.budgetWarning()).toContain("is spent");
    });

    it("restates a session's total when it is resumed again, rather than adding a second copy", () => {
      // `/history resume` on a session already resumed this process is an ordinary thing to do —
      // leave and come back to a thread. Summing on arrival would charge the same dollars twice.
      const ledger = new CostLedger({ prices: opus, display: "USD" });
      ledger.carryForward("session_a", fromUnits(0.4, "USD"));
      ledger.carryForward("session_a", fromUnits(0.6, "USD"));
      expect(toUnits(ledger.carriedTotal!)).toBeCloseTo(0.6, 6);
    });

    it("sums distinct sessions, because a process that resumed two of them has spent both", () => {
      const ledger = new CostLedger({ prices: opus, display: "USD" });
      ledger.carryForward("session_a", fromUnits(0.4, "USD"));
      ledger.carryForward("session_b", fromUnits(0.25, "USD"));
      expect(toUnits(ledger.carriedTotal!)).toBeCloseTo(0.65, 6);
    });

    it("projects remaining turns from the turns it watched, not from the inherited total", () => {
      // $10 cap, $9 already spent elsewhere, and one observed turn costing $0.55. The honest
      // answer is "one more turn at this rate" — $0.45 left over a $0.55 average. Averaging the
      // carried $9 over the single observed turn instead would claim zero.
      const ledger = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(10, "USD") });
      ledger.carryForward("session_a", fromUnits(9, "USD"));
      ledger.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 0, elapsedMs: 900 });
      expect(ledger.turnsRemaining).toBe(0); // $0.45 remaining does not buy another $0.55 turn
      expect(ledger.carriedTotal).toBeDefined();

      const roomier = new CostLedger({ prices: opus, display: "USD", budget: fromUnits(12, "USD") });
      roomier.carryForward("session_a", fromUnits(9, "USD"));
      roomier.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 0, elapsedMs: 900 });
      // $2.45 left at the $0.55 per turn this process actually observed.
      expect(roomier.turnsRemaining).toBe(4);
    });

    it("shows the running total from the first turn, and names the inherited part in the report", () => {
      const ledger = new CostLedger({ prices: opus, display: "USD" });
      ledger.carryForward("session_a", fromUnits(0.9, "USD"));
      const turn = ledger.record({ usage: usage(100_000, 2_000), iterations: 1, toolCalls: 0, elapsedMs: 900 });
      // Normally withheld until turn two; on a resumed session turn one already has a history.
      expect(ledger.formatTurn(turn)).toContain("session $1.45");
      // The token lines and the request count describe this process only, so the gap between them
      // and the total has to be accounted for by name rather than left to be inferred.
      expect(ledger.formatReport()).toContain("carried $0.90 spent before this session was resumed");
      expect(ledger.formatReport()).toContain("over 1 request");
    });

    it("refuses a figure in a currency the ledger does not display, instead of misreading it", () => {
      // The stored total is a bare integer with no currency on it. Converting it is the caller's
      // job precisely so a mismatch fails here rather than silently entering the total as if
      // 1,320 francs were 1,320 dollars.
      const ledger = new CostLedger({ prices: opus, display: "USD", rates: [rwfPerUsd] });
      expect(() => ledger.carryForward("session_a", fromUnits(1_320, "RWF"))).toThrow(/display currency/);
      expect(() => ledger.carryForward("session_a", { micros: -1, currency: "USD" })).toThrow(/non-negative/);
      expect(ledger.carriedTotal).toBeUndefined();
    });
  });
});

/**
 * The prompt cache is the largest lever on what a long session costs, and it fails silently — a
 * prefix match is defeated by one changed byte near the front, and the session goes on working
 * while paying full price. These are the numbers that make that visible.
 */
describe("whether the prompt cache is actually working", () => {
  const cacheUsage = (input: number, cached: number, written: number) => ({
    inputTokens: input,
    outputTokens: 500,
    totalTokens: input + 500,
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    reasoningTokens: 0,
  });

  function ledgerWith(turns: Array<{ input: number; cached: number; written: number }>): CostLedger {
    const ledger = new CostLedger({ prices: opus, display: "USD" });
    for (const turn of turns) {
      ledger.record({ usage: cacheUsage(turn.input, turn.cached, turn.written), iterations: 1, toolCalls: 1, elapsedMs: 1_000 });
    }
    return ledger;
  }

  it("reports the share of input that came from the cache", () => {
    const ledger = ledgerWith([{ input: 100_000, cached: 80_000, written: 0 }]);
    expect(ledger.cacheHealth.hitRate).toBeCloseTo(0.8, 3);
    expect(ledger.cacheHealth.readTokens).toBe(80_000);
    expect(ledger.cacheHealth.freshTokens).toBe(20_000);
    expect(ledger.formatReport()).toContain("80% of input served from cache");
  });

  it("says nothing about a cache the session never used", () => {
    const ledger = ledgerWith([{ input: 10_000, cached: 0, written: 0 }]);
    expect(ledger.formatReport()).not.toContain("cache");
    expect(ledger.cacheHealth.hitRate).toBe(0);
  });

  it("flags a prefix that keeps being rewritten and never read back", () => {
    // Writes exceeding reads, turn after turn, is the signature of an invalidated prefix: Nova pays
    // the 1.25x storage premium for something nothing ever reads, which is worse than not caching.
    const ledger = ledgerWith([
      { input: 40_000, cached: 0, written: 40_000 },
      { input: 45_000, cached: 0, written: 45_000 },
      { input: 50_000, cached: 0, written: 50_000 },
    ]);
    expect(ledger.cacheHealth.churning).toBe(true);
    expect(ledger.formatReport()).toContain("rewritten more than it is read");
  });

  it("does not cry wolf on a healthy session that is simply young", () => {
    // Early turns legitimately write more than they read; warning there teaches everyone to ignore
    // the warning by the time it means something.
    expect(ledgerWith([{ input: 40_000, cached: 0, written: 40_000 }]).cacheHealth.churning).toBe(false);
    expect(ledgerWith([
      { input: 40_000, cached: 0, written: 40_000 },
      { input: 45_000, cached: 40_000, written: 0 },
      { input: 50_000, cached: 45_000, written: 0 },
    ]).cacheHealth.churning).toBe(false);
  });

  it("ignores churn too small to be worth anyone's attention", () => {
    const ledger = ledgerWith([
      { input: 300, cached: 0, written: 300 },
      { input: 300, cached: 0, written: 300 },
      { input: 300, cached: 0, written: 300 },
    ]);
    expect(ledger.cacheHealth.churning).toBe(false);
  });
});
