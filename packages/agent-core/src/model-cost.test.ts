import { describe, expect, it } from "vitest";
import { affordableOutputTokens, approximateInputTokens, estimateModelCost, priceActualModelUsage, priceUsageWithCache } from "./model-cost";

const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };

describe("model cost estimation", () => {
  it("keeps a conservative token cap above the expected estimate", () => {
    const tokens = approximateInputTokens(["Implement a small TypeScript change", "src/index.ts"]);
    expect(tokens.maximumInputTokens).toBeGreaterThan(tokens.expectedInputTokens);
  });

  it("quotes an expected cost and a hard reservation in integer RWF", () => {
    const estimate = estimateModelCost(["Inspect and update the repository"], 2_000, prices);
    expect(estimate.maximumRwf).toBeGreaterThanOrEqual(estimate.expectedRwf);
    expect(Number.isInteger(estimate.maximumRwf)).toBe(true);
  });

  it("prices actual provider usage and rejects unusable catalogs", () => {
    expect(priceActualModelUsage(1_000, 500, prices)).toBe(6);
    expect(() => priceActualModelUsage(1, 1, { ...prices, inputRwfPerMillionTokens: 0 })).toThrow("positive");
  });

  it("clamps output before a provider call so the approved amount cannot be exceeded", () => {
    const generous = affordableOutputTokens(["small prompt"], 2_000, 100, prices);
    expect(generous).toBe(2_000);
    const none = affordableOutputTokens(["small prompt"], 2_000, 1, prices);
    expect(none).toBe(0);
  });
});

describe("cached-token pricing", () => {
  it("falls back to the uncached rate when no cached rate is configured", () => {
    // With no cached rate, cached tokens are simply not discounted — the two functions must agree.
    const usage = { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 800 };
    expect(priceUsageWithCache(usage, prices)).toBe(priceActualModelUsage(1_000, 500, prices));
  });

  it("charges the discounted rate only for the cached share of input tokens", () => {
    const cached = { ...prices, cachedInputRwfPerMillionTokens: 200 };
    // Round numbers throughout, so the expected value isn't itself a rounding judgment call.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 800_000 };
    // 200,000 uncached tokens at 2,000/M (= 400) + 800,000 cached tokens at 200/M (= 160).
    expect(priceUsageWithCache(usage, cached)).toBe(400 + 160);
  });

  it("never charges more cached tokens than were actually reported as input", () => {
    // Providers report cached tokens as a subset of input, not additional to it — a catalog that
    // somehow reports more cached than total input must not go negative on the uncached share.
    const cached = { ...prices, cachedInputRwfPerMillionTokens: 200 };
    const usage = { inputTokens: 500_000, outputTokens: 0, cachedInputTokens: 800_000 };
    expect(priceUsageWithCache(usage, cached)).toBe(160); // 800,000 cached tokens at 200/M, uncached share floors at 0.
  });

  it("rejects an unusable cached rate the same way the uncached path does", () => {
    const cached = { ...prices, cachedInputRwfPerMillionTokens: 0 };
    expect(() => priceUsageWithCache({ inputTokens: 100, outputTokens: 0, cachedInputTokens: 50 }, cached)).toThrow("positive");
  });
});
