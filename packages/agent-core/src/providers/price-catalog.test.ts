import { describe, expect, it } from "vitest";
import { toUnits, priceUsage } from "../money";
import { priceUnits, selectPrice, tokenPricesAt, validatePriceRecord } from "../pricing";
import { PRICE_CATALOG, UNPRICED_PROVIDERS } from "./price-catalog";

describe("the catalog as a whole", () => {
  it("is internally valid — every record passes the same check a new entry would", () => {
    // definePrices() already runs this at import time; re-running it here turns "the catalog failed
    // to load" into a named, debuggable test failure instead of every test in the suite going red.
    for (const record of PRICE_CATALOG) expect(() => validatePriceRecord(record)).not.toThrow();
  });

  it("has no duplicate provider/model/modality active on the same day", () => {
    // Two records both claiming today for the same model is exactly the ambiguity `selectPrice`'s
    // "later effectiveFrom wins" rule is designed to resolve — but an accidental duplicate (typo'd
    // model id copy-pasted twice) should still be caught, not silently shadowed.
    const today = "2026-08-10";
    const seen = new Map<string, number>();
    for (const record of PRICE_CATALOG) {
      if (record.effectiveFrom > today || (record.effectiveUntil && record.effectiveUntil <= today)) continue;
      const key = `${record.provider}/${record.model}/${record.modality}`;
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const duplicates = [...seen.entries()].filter(([, count]) => count > 1);
    expect(duplicates).toEqual([]);
  });

  it("no longer lists CircuitNotion as unpriced", () => {
    expect(UNPRICED_PROVIDERS).not.toContain("circuitnotion");
    expect(UNPRICED_PROVIDERS).toContain("openai");
  });
});

describe("CircuitNotion token models", () => {
  it("prices the provider's own default model", () => {
    // gpt-5.6-luna is PROVIDERS.circuitnotion.defaultModel in agent-matrix.ts — if this entry were
    // missing, every session started without an explicit model would silently report unpriced.
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5.6-luna" })!;
    expect(prices).toBeDefined();
    expect(prices.currency).toBe("RWF");
    expect(prices.inputPerMillion).toBe(1_610_000_000);
    expect(prices.outputPerMillion).toBe(9_660_000_000);
    expect(prices.cachedInputPerMillion).toBe(161_000_000);
  });

  it("prices a real turn against the published table, cache included", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5.4" })!;
    // 10k uncached input at 4,025 RWF/M + 90k cached at 402.5 RWF/M + 2k output at 24,150 RWF/M.
    const expected = (10_000 * 4_025 + 90_000 * 402.5 + 2_000 * 24_150) / 1_000_000;
    const cost = priceUsage({ inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000 }, prices);
    expect(toUnits(cost)).toBeCloseTo(expected, 6);
  });

  it("keeps every named model in the house family distinct", () => {
    // gpt-5.6 and gpt-5.6-sol are priced identically, but as two separate records — a lookup for
    // one must never silently fall back to the other if a future price change splits them.
    for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model })).toBeDefined();
    }
  });

  it("prices the proxied OpenAI-named and DeepSeek models CircuitNotion resells", () => {
    // These are not a separate "openai" catalog entry — they are CircuitNotion's own menu, billed
    // in RWF, selectable via CIRCUITNOTION_MODEL exactly like the house-named tiers.
    for (const model of ["gpt-5", "gpt-4.1", "gpt-4o-mini", "o3", "o3-pro", "deepseek-v4-flash", "deepseek-v4-pro"]) {
      const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model });
      expect(prices?.currency, `${model} should be priced in RWF`).toBe("RWF");
    }
  });

  it("does not price these models under the openai provider", () => {
    // The table is CircuitNotion's rate card, not a general OpenAI price list — recording it under
    // "openai" would misattribute a reseller's markup (or discount) as the vendor's own list price.
    expect(tokenPricesAt(PRICE_CATALOG, { provider: "openai", model: "gpt-5" })).toBeUndefined();
    expect(tokenPricesAt(PRICE_CATALOG, { provider: "openai", model: "gpt-4.1" })).toBeUndefined();
  });

  it("gets the priciest and cheapest tiers right, as a sanity bound on the whole table", () => {
    const proPrices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "o3-pro" })!;
    const nanoPrices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5-nano" })!;
    expect(proPrices.inputPerMillion).toBeGreaterThan(nanoPrices.inputPerMillion * 100);
  });
});

describe("CircuitNotion embeddings", () => {
  it("prices by input tokens only, at each model's own rate", () => {
    const small = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "text-embedding-3-small" })!;
    const large = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "text-embedding-3-large" })!;
    expect(toUnits(priceUnits(small, { input: 1_000_000 }))).toBeCloseTo(32.20, 6);
    expect(toUnits(priceUnits(large, { input: 1_000_000 }))).toBeCloseTo(209.3, 6);
    // Large embeddings cost more per token than small, which is the entire reason to offer both.
    expect(large.rates.input).toBeGreaterThan(small.rates.input);
  });

  it("has no output rate — embeddings do not generate tokens", () => {
    const record = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "text-embedding-ada-002" })!;
    expect(record.rates.output).toBeUndefined();
  });
});

describe("CircuitNotion image generation", () => {
  it("bills the GPT Image family by output tokens", () => {
    const record = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-image-2" })!;
    expect(record.billingUnit).toBe("tokens");
    expect(toUnits(priceUnits(record, { output: 500_000 }))).toBeCloseTo(24_150, 6);
  });

  it("bills DALL-E by the image, not by tokens", () => {
    const record = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-3" })!;
    expect(record.billingUnit).toBe("images");
    expect(toUnits(priceUnits(record, { image: 3 }))).toBeCloseTo(64.40 * 3, 6);
  });

  it("prices DALL-E 2 below DALL-E 3, matching the published table", () => {
    const two = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-2" })!;
    const three = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-3" })!;
    expect(two.rates.image).toBeLessThan(three.rates.image!);
  });
});
