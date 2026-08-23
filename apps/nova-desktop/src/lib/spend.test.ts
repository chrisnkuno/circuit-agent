import { describe, expect, it } from "vitest";
import { CRITICAL_BALANCE_RWF, LOW_BALANCE_RWF, MAXIMUM_TOP_UP_RWF, MINIMUM_TOP_UP_RWF } from "@circuit-nova/nova-core/nova-cli/billing";
import type { TurnCostPoint } from "./cost-chart";
import { isStale, paceSeries, runway, spendAdvice, spendPace, suggestTopUpRwf, STALE_BALANCE_MS } from "./spend";

const turn = (patch: Partial<TurnCostPoint> & { turnNumber: number }): TurnCostPoint => ({
  inputTokens: 1000,
  outputTokens: 200,
  toolCalls: 2,
  iterations: 3,
  elapsedMs: 60_000,
  ...patch,
});

/** `rwf` is whole RWF for readability; the point stores micros, as the ledger does. */
const priced = (turnNumber: number, rwf: number, elapsedMs = 60_000): TurnCostPoint =>
  turn({ turnNumber, elapsedMs, cost: { micros: rwf * 1_000_000, currency: "RWF" } });

const series = (count: number, rwf: number): TurnCostPoint[] =>
  Array.from({ length: count }, (_, index) => priced(index + 1, rwf));

const balance = (balanceRwf: number, asOf = Date.now()) => ({ balanceRwf, asOf });

describe("spend pace", () => {
  it("distinguishes an unpriced session from a free one", () => {
    // The whole reason this returns null: "RWF 0 per turn" reads as free when it means unknown,
    // and a user who believes the first is a user who gets a surprise.
    expect(spendPace([turn({ turnNumber: 1 }), turn({ turnNumber: 2 })])).toBeNull();
    expect(spendPace(series(3, 100))?.perTurnMicros).toBe(100_000_000);
  });

  it("divides by working time, not by the wall clock", () => {
    // Two turns of one minute each, 100 RWF apiece, however long ago they ran. The rate that
    // matters is the rate while working, because that is the rate the next request will be charged.
    const pace = spendPace([priced(1, 100, 60_000), priced(2, 100, 60_000)]);
    expect(pace?.perMinuteMicros).toBe(100_000_000);
  });

  it("never divides by a zero elapsed time", () => {
    const pace = spendPace([priced(1, 100, 0)]);
    expect(pace?.perMinuteMicros).toBe(0);
    expect(Number.isFinite(pace!.perMinuteMicros)).toBe(true);
  });

  it("measures the recent window rather than the whole session", () => {
    // An expensive opening turn should stop describing a session that has since settled down.
    const pace = spendPace([priced(1, 10_000), ...Array.from({ length: 5 }, (_, index) => priced(index + 2, 100))]);
    expect(pace?.perTurnMicros).toBe(100_000_000);
  });

  it("calls a rising pace rising, and only against an equal earlier window", () => {
    const rising = spendPace([...series(3, 100), priced(4, 500), priced(5, 500), priced(6, 500)], 3);
    expect(rising?.trend).toBe("rising");
    const easing = spendPace([priced(1, 500), priced(2, 500), priced(3, 500), ...Array.from({ length: 3 }, (_, index) => priced(index + 4, 100))], 3);
    expect(easing?.trend).toBe("easing");
    expect(spendPace(series(6, 100), 3)?.trend).toBe("steady");
  });

  it("refuses to call a direction on too thin a sample", () => {
    expect(spendPace([priced(1, 100), priced(2, 900)], 1)?.trend).toBe("steady");
  });
});

describe("runway", () => {
  it("refuses rather than guesses across currencies", () => {
    // There is no ambient exchange rate here, by design. A wrong runway is the number someone
    // plans their afternoon around.
    const usd = spendPace([turn({ turnNumber: 1, cost: { micros: 1_000_000, currency: "USD" } })]);
    expect(runway(balance(10_000), usd!)).toBeNull();
  });

  it("floors turns, because a partial turn is not a turn", () => {
    const pace = spendPace(series(3, 300))!;
    expect(runway(balance(1_000), pace)?.turns).toBe(3);
  });

  it("hedges until the sample is thick enough to plan around", () => {
    expect(runway(balance(10_000), spendPace(series(2, 100))!)?.confident).toBe(false);
    expect(runway(balance(10_000), spendPace(series(3, 100))!)?.confident).toBe(true);
  });

  it("survives a zero balance without dividing by anything", () => {
    const left = runway(balance(0), spendPace(series(3, 100))!);
    expect(left).toEqual({ turns: 0, minutes: 0, confident: true });
  });
});

describe("spend advice", () => {
  const pace = () => spendPace(series(4, 100));

  it("says work is paused, and that nothing was charged, when credit runs out", () => {
    const advice = spendAdvice({ balance: balance(0), pace: pace() });
    expect(advice.level).toBe("empty");
    // The fear at zero is a silent charge for the turn that did not run.
    expect(advice.detail).toContain("Nothing was charged");
    expect(advice.topUpRwf).toBeGreaterThan(0);
  });

  it("agrees with the CLI about where low and critical begin", () => {
    expect(spendAdvice({ balance: balance(CRITICAL_BALANCE_RWF - 1), pace: null }).level).toBe("critical");
    expect(spendAdvice({ balance: balance(LOW_BALANCE_RWF), pace: null }).level).toBe("low");
  });

  it("calls a large balance low when the pace will exhaust it in a couple of turns", () => {
    // The absolute floor is not the only way to be nearly out: 20,000 RWF at 9,000 a turn is two
    // turns of runway, and a threshold that only looked at the number would call that healthy.
    const expensive = spendPace(series(4, 9_000))!;
    expect(spendAdvice({ balance: balance(20_000), pace: expensive }).level).toBe("low");
  });

  it("names the runway even when everything is fine", () => {
    // The feature only works if the number has been there all along; someone meeting it for the
    // first time at "3 more turns" reads it as an alarm rather than as information.
    const advice = spendAdvice({ balance: balance(500_000), pace: pace() });
    expect(advice.level).toBe("healthy");
    expect(advice.detail).toMatch(/more turns/);
  });

  it("asks for nothing while the balance is healthy", () => {
    // An app that asks for money when it does not need it is an app that gets ignored when it does.
    expect(spendAdvice({ balance: balance(500_000), pace: pace() }).topUpRwf).toBeUndefined();
  });

  it("explains itself when there is no pace to project from", () => {
    const advice = spendAdvice({ balance: balance(500_000), pace: null });
    expect(advice.level).toBe("healthy");
    expect(advice.detail).toContain("no pace");
  });
});

describe("top-up suggestion", () => {
  it("scales with how the person actually works", () => {
    const light = suggestTopUpRwf(spendPace(series(3, 50)));
    const heavy = suggestTopUpRwf(spendPace(series(3, 2_000)));
    expect(heavy).toBeGreaterThan(light);
  });

  it("stays inside the gateway's own bounds and on a typeable round number", () => {
    expect(suggestTopUpRwf(spendPace(series(3, 1)))).toBeGreaterThanOrEqual(MINIMUM_TOP_UP_RWF);
    expect(suggestTopUpRwf(spendPace(series(3, 10_000_000)))).toBeLessThanOrEqual(MAXIMUM_TOP_UP_RWF);
    expect(suggestTopUpRwf(spendPace(series(3, 137))) % 500).toBe(0);
  });

  it("falls back to a sane figure with no measured pace", () => {
    expect(suggestTopUpRwf(null)).toBeGreaterThanOrEqual(MINIMUM_TOP_UP_RWF);
  });
});

describe("staleness", () => {
  it("marks a balance stale only once it is genuinely old", () => {
    const now = 1_000_000_000;
    expect(isStale(balance(5_000, now - STALE_BALANCE_MS + 1_000), now)).toBe(false);
    expect(isStale(balance(5_000, now - STALE_BALANCE_MS - 1_000), now)).toBe(true);
  });
});

describe("pace series", () => {
  it("reports a rate, not an amount", () => {
    // A two-minute turn costing 200 and a one-minute turn costing 100 are the same speed, and a
    // chart of amounts would show the first as twice the second.
    const points = paceSeries([priced(1, 200, 120_000), priced(2, 100, 60_000)]);
    expect(points[0].perMinuteMicros).toBe(points[1].perMinuteMicros);
  });

  it("breaks the line rather than drawing a plunge that never happened", () => {
    const points = paceSeries([priced(1, 100), turn({ turnNumber: 2 }), priced(3, 100, 0)]);
    expect(points[1].perMinuteMicros).toBeNull();
    expect(points[2].perMinuteMicros).toBeNull();
  });
});
