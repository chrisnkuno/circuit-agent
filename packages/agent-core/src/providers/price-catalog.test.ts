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
    const today = "2026-08-23";
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
  it("contains every chat model in the 2026-08-23 live catalog", () => {
    const expected = [
      "auto", "circuit-1", "circuit-1-mini", "circuit-2", "circuit-2-turbo", "circuit-3",
      "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna",
      "gpt-5.5", "gpt-5.5-pro", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.4-pro",
      "gpt-5", "gpt-5-mini", "gpt-5-nano",
      "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano", "gpt-4o", "gpt-4o-mini",
      "o4-mini", "o3", "o3-mini", "o3-pro", "deepseek-v4-flash", "deepseek-v4-pro",
      "kimi", "kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6", "kimi-k2", "kimi-k2.5",
      "claude", "claude-fable-5", "claude-mythos-5", "claude-opus-5", "claude-sonnet-5",
      "claude-haiku-4-5", "claude-opus-4-8", "claude-opus-4-6", "claude-sonnet-4-6", "claude-sonnet-4-5",
    ];
    const actual = PRICE_CATALOG
      .filter((record) => record.provider === "circuitnotion" && record.modality === "text")
      .map((record) => record.model);
    expect(actual.slice().sort()).toEqual(expected.slice().sort());
  });

  it("prices the provider's published gpt-5.6-luna rate", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5.6-luna" })!;
    expect(prices).toBeDefined();
    expect(prices.currency).toBe("RWF");
    expect(prices.inputPerMillion).toBe(2_433_400_000);
    expect(prices.outputPerMillion).toBe(14_600_380_000);
    expect(prices.cachedInputPerMillion).toBeUndefined();
  });

  it("applies GPT-5.6's whole-request long-context tier only above 272K input", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5.6-luna" })!;
    const base = toUnits(priceUsage({ inputTokens: 272_000, outputTokens: 1_000 }, prices));
    const tiered = toUnits(priceUsage({ inputTokens: 272_001, outputTokens: 1_000 }, prices));
    const expectedBase = (272_000 * 2_433.4 + 1_000 * 14_600.38) / 1_000_000;
    const expectedTiered = (272_001 * 2_433.4 * 2 + 1_000 * 14_600.38 * 1.5) / 1_000_000;
    expect(base).toBeCloseTo(expectedBase, 6);
    expect(tiered).toBeCloseTo(expectedTiered, 6);
  });

  it("prices the default circuit-2-turbo routing alias", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "circuit-2-turbo" })!;
    expect(prices.inputPerMillion).toBe(304_180_000);
    expect(prices.outputPerMillion).toBe(608_350_000);
  });

  it("prices a real turn against the published table without inventing a cache discount", () => {
    const prices = tokenPricesAt(PRICE_CATALOG, { provider: "circuitnotion", model: "gpt-5.4" })!;
    // The live catalog publishes no cache-read rate, so cached usage remains billed at input rate.
    const expected = (100_000 * 6_083.49 + 2_000 * 36_500.94) / 1_000_000;
    const cost = priceUsage({ inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000 }, prices);
    expect(toUnits(cost)).toBeCloseTo(expected, 6);
  });

  it("keeps every named model in the house family distinct", () => {
    // gpt-5.6 and gpt-5.6-sol are priced identically, but as two separate records — a lookup for
    // one must never silently fall back to the other if a future price change splits them.
    for (const model of ["auto", "circuit-1", "circuit-1-mini", "circuit-2", "circuit-2-turbo", "circuit-3", "gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
      expect(selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model })).toBeDefined();
    }
  });

  it("prices the proxied OpenAI-named and DeepSeek models CircuitNotion resells", () => {
    // These are not a separate "openai" catalog entry — they are CircuitNotion's own menu, billed
    // in RWF, selectable via CIRCUITNOTION_MODEL exactly like the house-named tiers.
    for (const model of ["gpt-5", "gpt-4.1", "gpt-4o-mini", "o3", "o3-pro", "deepseek-v4-flash", "deepseek-v4-pro", "kimi", "kimi-k3", "kimi-k2.7-code", "claude", "claude-fable-5", "claude-sonnet-4-5"]) {
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
    expect(toUnits(priceUnits(small, { input: 1_000_000 }))).toBeCloseTo(43.45, 6);
    expect(toUnits(priceUnits(large, { input: 1_000_000 }))).toBeCloseTo(282.45, 6);
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
    expect(toUnits(priceUnits(record, { output: 500_000 }))).toBeCloseTo(32_590.125, 6);
  });

  it("bills DALL-E by the image, not by tokens", () => {
    const record = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-3" })!;
    expect(record.billingUnit).toBe("images");
    expect(toUnits(priceUnits(record, { image: 3 }))).toBeCloseTo(86.91 * 3, 6);
  });

  it("prices DALL-E 2 below DALL-E 3, matching the published table", () => {
    const two = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-2" })!;
    const three = selectPrice(PRICE_CATALOG, { provider: "circuitnotion", model: "dall-e-3" })!;
    expect(two.rates.image).toBeLessThan(three.rates.image!);
  });
});
