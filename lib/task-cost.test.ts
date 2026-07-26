import { describe, expect, it } from "vitest";
import { estimateTaskCost, formatRwf } from "./task-cost";

describe("estimateTaskCost", () => {
  it("returns a bounded quote that covers its estimate", () => {
    const quote = estimateTaskCost({
      kind: "coding",
      quality: "balanced",
      attachmentCount: 2,
      requiresBrowser: false,
      requiresSandbox: true,
    });

    expect(quote.estimateLowRwf).toBeLessThan(quote.estimateHighRwf);
    expect(quote.maxRwf).toBeGreaterThanOrEqual(quote.estimateHighRwf);
    expect(quote.confidence).toBe("medium");
  });

  it("rejects invalid attachment counts before pricing", () => {
    expect(() => estimateTaskCost({ kind: "research", quality: "fast", attachmentCount: -1, requiresBrowser: false, requiresSandbox: false })).toThrow("non-negative integer");
    expect(() => estimateTaskCost({ kind: "research", quality: "fast", attachmentCount: 1.5, requiresBrowser: false, requiresSandbox: false })).toThrow("non-negative integer");
  });

  it("formats integer prices as RWF without fractional ambiguity", () => {
    const formatted = formatRwf(1250);
    expect(formatted).toContain("1,250");
    expect(formatted).not.toMatch(/[.,]00$/);
  });
});
