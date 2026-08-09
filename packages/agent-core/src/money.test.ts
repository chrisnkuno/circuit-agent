import { describe, expect, it } from "vitest";
import {
  addMoney,
  convert,
  convertTo,
  formatMoney,
  fromUnits,
  isCurrency,
  money,
  priceUsage,
  tokenPrices,
  toUnits,
  type FxRate,
} from "./money";

const rwfPerUsd: FxRate = { from: "USD", to: "RWF", rate: 1_320, asOf: "2026-08-01", source: "manual" };

describe("money", () => {
  it("holds sub-cent amounts without losing them to rounding", () => {
    // A request that costs $0.0004 must not become $0.00 — "free" and "very cheap" lead to
    // different decisions, and cents are too coarse a unit to tell them apart.
    const tiny = fromUnits(0.0004, "USD");
    expect(tiny.micros).toBe(400);
    expect(toUnits(tiny)).toBeCloseTo(0.0004, 6);
    expect(formatMoney(tiny)).toBe("$0.0004");
  });

  it("formats each currency the way people write it", () => {
    expect(formatMoney(fromUnits(1_234, "RWF"))).toBe("RWF 1,234");
    expect(formatMoney(fromUnits(12.5, "USD"))).toBe("$12.50");
    // RWF has no subunit in practice, so fractions are noise.
    expect(formatMoney(money(1_500_500, "RWF"))).toBe("RWF 2");
    expect(formatMoney(fromUnits(12.5, "EUR"))).toMatch(/12[.,]50/);
  });

  it("refuses to add two different currencies", () => {
    expect(() => addMoney(fromUnits(1, "USD"), fromUnits(1, "RWF"))).toThrow(/without a rate/);
    expect(addMoney(fromUnits(1.5, "USD"), fromUnits(2.25, "USD")).micros).toBe(3_750_000);
  });
});

describe("conversion", () => {
  it("converts only with a rate that matches the currency", () => {
    expect(convert(fromUnits(2, "USD"), rwfPerUsd)).toEqual({ micros: 2_640_000_000, currency: "RWF" });
    expect(() => convert(fromUnits(2, "RWF"), rwfPerUsd)).toThrow(/converts USD/);
  });

  it("uses a rate in reverse rather than needing it configured twice", () => {
    // One number, one place to go stale.
    const back = convertTo(fromUnits(1_320, "RWF"), "USD", [rwfPerUsd]);
    expect(back?.currency).toBe("USD");
    expect(toUnits(back!)).toBeCloseTo(1, 6);
  });

  it("returns nothing when no rate exists, instead of guessing one", () => {
    expect(convertTo(fromUnits(5, "USD"), "RWF", [])).toBeUndefined();
    // Same currency needs no rate at all.
    expect(convertTo(fromUnits(5, "USD"), "USD", [])).toEqual(fromUnits(5, "USD"));
  });

  it("carries the date and source, so a historical charge can be audited", () => {
    expect(rwfPerUsd.asOf).toBe("2026-08-01");
    expect(rwfPerUsd.source).toBe("manual");
  });

  it("rejects a nonsensical rate", () => {
    expect(() => convert(fromUnits(1, "USD"), { ...rwfPerUsd, rate: 0 })).toThrow(/positive/);
  });
});

describe("token pricing", () => {
  const opus = tokenPrices("USD", 5, 25, 0.5);

  it("prices a request in the provider's own currency", () => {
    const cost = priceUsage({ inputTokens: 1_000_000, outputTokens: 100_000 }, opus);
    // $5 for the input million + $2.50 for 100k output.
    expect(toUnits(cost)).toBeCloseTo(7.5, 6);
    expect(cost.currency).toBe("USD");
  });

  it("treats cached tokens as a discounted subset of input, never as extra", () => {
    const cost = priceUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 }, opus);
    // 100k at $5/M plus 900k at $0.50/M = $0.50 + $0.45.
    expect(toUnits(cost)).toBeCloseTo(0.95, 6);

    // Double-counting the cheapest part of a long session would be the expensive mistake here.
    const allCached = priceUsage({ inputTokens: 500_000, outputTokens: 0, cachedInputTokens: 500_000 }, opus);
    expect(toUnits(allCached)).toBeCloseTo(0.25, 6);
  });

  it("charges full price when the provider publishes no cached rate", () => {
    const flat = tokenPrices("USD", 5, 25);
    const cost = priceUsage({ inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 900_000 }, flat);
    expect(toUnits(cost)).toBeCloseTo(5, 6);
  });

  it("never counts more cached tokens than input tokens", () => {
    const cost = priceUsage({ inputTokens: 1_000, outputTokens: 0, cachedInputTokens: 9_999 }, opus);
    expect(cost.micros).toBeGreaterThanOrEqual(0);
    expect(toUnits(cost)).toBeCloseTo(0.0005, 6);
  });
});

describe("currency guard", () => {
  it("accepts supported ISO currencies and rejects arbitrary codes", () => {
    expect(isCurrency("RWF")).toBe(true);
    expect(isCurrency("USD")).toBe(true);
    expect(isCurrency("EUR")).toBe(true);
    expect(isCurrency("NOPE")).toBe(false);
  });
});
