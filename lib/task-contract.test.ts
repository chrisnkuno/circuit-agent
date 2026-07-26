import { describe, expect, it } from "vitest";
import { quoteReplayMatches, validateQuotedTaskContract } from "./task-contract";

const quote = {
  title: "Fix checkout",
  estimateLowRwf: 1_000n,
  estimateHighRwf: 1_500n,
  maxRwf: 2_000n,
  assumptions: ["One repository"],
  idempotencyKey: "task-key-1",
};

describe("durable quote contract", () => {
  it("accepts a bounded integer-RWF quote", () => {
    expect(() => validateQuotedTaskContract(quote)).not.toThrow();
  });

  it("rejects malformed ranges and unbounded user input", () => {
    expect(() => validateQuotedTaskContract({ ...quote, estimateLowRwf: 2_001n })).toThrow("low estimate");
    expect(() => validateQuotedTaskContract({ ...quote, title: "" })).toThrow("title");
    expect(() => validateQuotedTaskContract({ ...quote, assumptions: [""] })).toThrow("assumptions");
  });

  it("distinguishes a safe idempotent replay from a conflicting payload", () => {
    const payload = { title: quote.title, kind: "coding", quality: "balanced", estimateLowRwf: 1_000n, estimateHighRwf: 1_500n, maxRwf: 2_000n };
    expect(quoteReplayMatches(payload, { ...payload })).toBe(true);
    expect(quoteReplayMatches(payload, { ...payload, maxRwf: 3_000n })).toBe(false);
  });
});
