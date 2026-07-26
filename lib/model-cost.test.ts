import { describe, expect, it } from "vitest";
import { approximateInputTokens, estimateModelCost, priceActualModelUsage } from "./model-cost";

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
});
