import { describe, expect, it } from "vitest";
import { toUnits, priceUsage } from "./money";
import { definePrices, priceAliases, selectPrice, tokenPricesAt, tokenPricesFor, validatePriceRecord, type PriceRecord } from "./pricing";

function record(overrides: Partial<PriceRecord> = {}): PriceRecord {
  return {
    provider: "anthropic",
    model: "claude-opus-5",
    modality: "text",
    currency: "USD",
    billingUnit: "tokens",
    per: 1_000_000,
    rates: { input: 5, output: 25, cachedInput: 0.5 },
    source: "test",
    effectiveFrom: "2026-01-01",
    ...overrides,
  };
}

describe("price records", () => {
  it("rejects a record that cannot price anything", () => {
    expect(() => validatePriceRecord(record({ provider: " " }))).toThrow("provider");
    expect(() => validatePriceRecord(record({ model: "" }))).toThrow("model or meter");
    expect(() => validatePriceRecord(record({ source: "" }))).toThrow("source");
    expect(() => validatePriceRecord(record({ per: 0 }))).toThrow("positive");
    expect(() => validatePriceRecord(record({ rates: {} }))).toThrow("no rates");
    expect(() => validatePriceRecord(record({ rates: { input: -1 } }))).toThrow("non-negative");
  });

  it("rejects dates that are not dates, and windows that end before they start", () => {
    expect(() => validatePriceRecord(record({ effectiveFrom: "June 2026" }))).toThrow("ISO date");
    expect(() => validatePriceRecord(record({ effectiveFrom: "2026-13-45" }))).toThrow("ISO date");
    expect(() => validatePriceRecord(record({ effectiveFrom: "2026-06-01", effectiveUntil: "2026-05-01" }))).toThrow("ends before it starts");
  });
});

describe("selecting the rate in force", () => {
  // The case the whole design exists for: an introductory rate that expires, with the standard
  // rate already recorded behind it. Both are true, on different days.
  const catalog = definePrices([
    record({ rates: { input: 2, output: 10, cachedInput: 0.2 }, effectiveFrom: "2026-06-01", effectiveUntil: "2026-09-01" }),
    record({ rates: { input: 3, output: 15, cachedInput: 0.3 }, effectiveFrom: "2026-09-01" }),
  ]);

  it("prices a day inside the promotional window at the promotional rate", () => {
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-08-10" })?.rates.input).toBe(2);
  });

  it("switches to the standing rate the day the promotion ends", () => {
    // The window is half-open, so the last promotional day and the first standard day are adjacent
    // rather than both matching — an overlap here would make the price depend on sort order.
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-08-31" })?.rates.input).toBe(2);
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-09-01" })?.rates.input).toBe(3);
  });

  it("reports nothing rather than a neighbouring model's rate", () => {
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-opus-4-1", asOf: "2026-08-10" })).toBeUndefined();
    expect(selectPrice(catalog, { provider: "openai", model: "claude-opus-5", asOf: "2026-08-10" })).toBeUndefined();
    // Before any recorded rate, the honest answer is "unknown", not the earliest rate on file.
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-05-31" })).toBeUndefined();
  });

  it("prefers the later record where two windows overlap", () => {
    const overlapping = definePrices([
      record({ rates: { input: 5, output: 25 }, effectiveFrom: "2026-01-01" }),
      record({ rates: { input: 4, output: 20 }, effectiveFrom: "2026-07-01" }),
    ]);
    expect(selectPrice(overlapping, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-08-10" })?.rates.input).toBe(4);
  });
});

describe("converting records to token prices", () => {
  it("carries the rates through at the ledger's per-million denominator", () => {
    const prices = tokenPricesFor(record());
    expect(prices).toEqual({ currency: "USD", inputPerMillion: 5_000_000, outputPerMillion: 25_000_000, cachedInputPerMillion: 500_000 });
  });

  it("rescales a provider that publishes in its own denominator", () => {
    // Recording a per-thousand rate as a long per-million decimal is how a table stops being
    // checkable against the price page it came from, so the record keeps the published shape.
    const perThousand = record({ per: 1_000, rates: { input: 0.005, output: 0.025 } });
    expect(tokenPricesFor(perThousand).inputPerMillion).toBe(5_000_000);
  });

  it("refuses to read a non-token meter as token prices", () => {
    expect(() => tokenPricesFor(record({ billingUnit: "requests", rates: { request: 7 } }))).toThrow("billed per requests");
    expect(() => tokenPricesFor(record({ rates: { input: 5 } }))).toThrow("input and output");
  });

  it("prices real usage end to end at the promotional rate", () => {
    const catalog = definePrices([record({ rates: { input: 2, output: 10, cachedInput: 0.2 }, effectiveFrom: "2026-06-01", effectiveUntil: "2026-09-01" })]);
    const prices = tokenPricesAt(catalog, { provider: "anthropic", model: "claude-opus-5", asOf: "2026-08-10" })!;
    // 10k uncached at $2/M + 90k cached at $0.20/M + 2k output at $10/M.
    const expected = (10_000 * 2 + 90_000 * 0.2 + 2_000 * 10) / 1_000_000;
    expect(toUnits(priceUsage({ inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000 }, prices))).toBeCloseTo(expected, 6);
  });
});

describe("version aliases", () => {
  it("reduces a version marker and nothing else", () => {
    // The invariant: every alias after the first is a strict prefix of the id it came from, and the
    // only thing removed is a date or a pointer word — never a segment that names a other model.
    for (const model of ["claude-sonnet-5-20260514", "gpt-4.1-mini-2025-04-14", "claude-opus-5-latest", "gpt-5.6-luna", "o3-mini", "llama3.1:8b"]) {
      const aliases = priceAliases(model);
      expect(aliases[0]).toBe(model);
      for (const alias of aliases.slice(1)) {
        expect(model.startsWith(alias)).toBe(true);
        expect(model.slice(alias.length)).toMatch(/^-(?:\d{8}|\d{4}-\d{2}-\d{2}|latest|preview)$/i);
      }
    }
  });

  it("leaves an id with no version marker alone", () => {
    for (const model of ["gpt-5-mini", "claude-opus-5", "deepseek-v4-pro"]) expect(priceAliases(model)).toEqual([model]);
  });
});

describe("pricing a dated snapshot", () => {
  const catalog = definePrices([
    record({ model: "claude-sonnet-5", rates: { input: 3, output: 15 }, effectiveFrom: "2026-01-01" }),
    record({ model: "gpt-5-mini", provider: "openai", rates: { input: 1, output: 4 }, effectiveFrom: "2026-01-01" }),
  ]);

  it("prices a snapshot id at its family's published rate", () => {
    // What `/v1/models` actually lists. Pricing only the exact string reported "unpriced" for every
    // id the live model list hands the user.
    for (const model of ["claude-sonnet-5-20260514", "claude-sonnet-5-latest", "claude-sonnet-5"]) {
      expect(selectPrice(catalog, { provider: "anthropic", model, asOf: "2026-08-10" })?.rates.input).toBe(3);
    }
  });

  it("still refuses to price a different model that merely shares a prefix", () => {
    // `gpt-5-mini` must never fall back to `gpt-5`: a cheaper model priced at a dearer one's rate is
    // exactly the confident-but-wrong number the catalog exists to prevent.
    expect(selectPrice(catalog, { provider: "openai", model: "gpt-5-mini-turbo", asOf: "2026-08-10" })).toBeUndefined();
    expect(selectPrice(catalog, { provider: "anthropic", model: "claude-sonnet-5-fast", asOf: "2026-08-10" })).toBeUndefined();
  });

  it("prefers a snapshot's own rate over the family rate when one is recorded", () => {
    const pinned = definePrices([...catalog, record({ model: "claude-sonnet-5-20260514", rates: { input: 9, output: 40 }, effectiveFrom: "2026-01-01" })]);
    expect(selectPrice(pinned, { provider: "anthropic", model: "claude-sonnet-5-20260514", asOf: "2026-08-10" })?.rates.input).toBe(9);
  });
});
