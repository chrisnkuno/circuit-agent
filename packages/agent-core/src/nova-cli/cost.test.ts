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
});
