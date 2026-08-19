import { describe, expect, it } from "vitest";
import { costBars, costSummary, runningTotal, tokenBars, tokenPeak, type TurnCostPoint } from "./cost-chart";

const turn = (patch: Partial<TurnCostPoint> & { turnNumber: number }): TurnCostPoint => ({
  inputTokens: 1000,
  outputTokens: 200,
  toolCalls: 2,
  iterations: 3,
  elapsedMs: 4000,
  ...patch,
});

const priced = (turnNumber: number, micros: number): TurnCostPoint =>
  turn({ turnNumber, cost: { micros, currency: "RWF" }, display: `RWF ${micros / 1000}` });

describe("cost bars", () => {
  it("scales to the most expensive turn in the series, not to a budget", () => {
    // Scaling to a budget draws every ordinary session as a flat line along the bottom, which
    // answers nothing. The question is which turn cost more than its neighbours.
    const bars = costBars([priced(1, 1000), priced(2, 4000), priced(3, 2000)]);
    expect(bars[1].height).toBe(1);
    expect(bars[0].height).toBeCloseTo(0.25);
    expect(bars[2].height).toBeCloseTo(0.5);
  });

  it("points at the peak turn", () => {
    const bars = costBars([priced(1, 1000), priced(2, 4000)]);
    expect(bars.map((bar) => bar.peak)).toEqual([false, true]);
  });

  it("keeps a visible stub for a turn that cost almost nothing", () => {
    // Otherwise a cheap turn is indistinguishable from no turn at all.
    const bars = costBars([priced(1, 1), priced(2, 100000)]);
    expect(bars[0].height).toBeGreaterThan(0);
  });

  it("draws no bar at all for a turn with no known price, and says so", () => {
    // Different from cheap: an unpriced model must not be rendered as a free one.
    const bars = costBars([turn({ turnNumber: 1 }), priced(2, 5000)]);
    expect(bars[0].height).toBe(0);
    expect(bars[0].label).toBe("cost unknown");
  });

  it("does not divide by zero when nothing is priced", () => {
    const bars = costBars([turn({ turnNumber: 1 }), turn({ turnNumber: 2 })]);
    expect(bars.every((bar) => bar.height === 0 && Number.isFinite(bar.height))).toBe(true);
    expect(bars.some((bar) => bar.peak)).toBe(false);
  });

  it("has nothing to draw for a session with no turns", () => {
    expect(costBars([])).toEqual([]);
  });
});

describe("the running total", () => {
  it("accumulates turn by turn", () => {
    expect(runningTotal([priced(1, 1000), priced(2, 2000), priced(3, 500)])).toEqual([1000, 3000, 3500]);
  });

  it("carries an unpriced turn forward flat rather than breaking the line", () => {
    expect(runningTotal([priced(1, 1000), turn({ turnNumber: 2 }), priced(3, 1000)])).toEqual([1000, 1000, 2000]);
  });
});

describe("token bars", () => {
  it("separates what was sent, what came back, and what was cached", () => {
    const [bar] = tokenBars([turn({ turnNumber: 1, inputTokens: 900, outputTokens: 100, cachedInputTokens: 700 })]);
    expect(bar).toMatchObject({ input: 900, output: 100, cached: 700, total: 1000 });
  });

  it("treats a missing cache count as none rather than as unknown", () => {
    expect(tokenBars([turn({ turnNumber: 1 })])[0].cached).toBe(0);
  });

  it("shares one scale across the series", () => {
    expect(tokenPeak([turn({ turnNumber: 1, inputTokens: 10, outputTokens: 5 }), turn({ turnNumber: 2, inputTokens: 40, outputTokens: 10 })])).toBe(50);
    expect(tokenPeak([])).toBe(0);
  });
});

describe("the summary", () => {
  it("averages only the turns that have a price", () => {
    const summary = costSummary([priced(1, 1000), turn({ turnNumber: 2 }), priced(3, 3000)]);
    expect(summary).toMatchObject({ averageMicros: 2000, peakTurn: 3, currency: "RWF" });
  });

  it("says nothing rather than inventing an average when nothing is priced", () => {
    expect(costSummary([turn({ turnNumber: 1 })])).toBeNull();
    expect(costSummary([])).toBeNull();
  });
});
