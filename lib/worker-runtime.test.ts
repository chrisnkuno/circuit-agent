import { describe, expect, it } from "vitest";
import { recoverExpiredLease, retryDelayMs, summarizeWorkerError, validateStepOutcome } from "./worker-runtime";

describe("worker lease recovery", () => {
  it("releases the exact reservation before retrying expired work", () => {
    expect(recoverExpiredLease({ status: "running", attempts: 1, leaseExpiresAt: 900, reservedRwf: 450 }, 1000)).toEqual({ action: "retry", releaseRwf: 450, retryAfterMs: 1000 });
  });

  it("fails work after the retry ceiling", () => {
    expect(recoverExpiredLease({ status: "running", attempts: 3, leaseExpiresAt: 900, reservedRwf: 700 }, 1000)).toEqual({ action: "fail", releaseRwf: 700 });
  });

  it("cancels expired active work instead of reviving a cancelled run", () => {
    expect(recoverExpiredLease({ status: "running", attempts: 1, leaseExpiresAt: 900, reservedRwf: 700, runCancelled: true }, 1000)).toEqual({ action: "cancel", releaseRwf: 700 });
  });

  it("caps exponential retry delay", () => {
    expect(retryDelayMs(10)).toBe(60_000);
  });

  it("rejects invalid recovery accounting", () => {
    expect(() => recoverExpiredLease({ status: "running", attempts: 1, leaseExpiresAt: 1, reservedRwf: -1 }, 2)).toThrow("reservedRwf");
  });

  it("requires evidence and bounded accounting for completed outcomes", () => {
    expect(() => validateStepOutcome({ outcome: "completed", summary: "Done", artifactReferences: [], reservedRwf: 100, actualRwf: 50 })).toThrow("evidence");
    expect(() => validateStepOutcome({ outcome: "completed", summary: "Done", artifactReferences: ["artifact:test-log"], reservedRwf: 100, actualRwf: 101 })).toThrow("reservation");
    expect(() => validateStepOutcome({ outcome: "completed", summary: "Done", artifactReferences: ["artifact:test-log"], reservedRwf: 100, actualRwf: 50 })).not.toThrow();
  });
});

describe("summarizeWorkerError", () => {
  it("replaces an HTML error page with a short, honest summary instead of storing raw markup", () => {
    const html = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head><body>${"x".repeat(2_000)}</body></html>`;
    const summary = summarizeWorkerError(new Error(`403 ${html}`));
    expect(summary).toBe("Provider returned an HTML error page instead of a JSON response (likely a gateway or bot-protection block).");
    expect(summary.length).toBeLessThan(200);
  });

  it("passes an ordinary error message through, bounded to a safe length", () => {
    expect(summarizeWorkerError(new Error("model refused: unsafe request"))).toBe("model refused: unsafe request");
    expect(summarizeWorkerError(new Error("x".repeat(10_000))).length).toBeLessThanOrEqual(500);
  });

  it("falls back to a generic message for a non-Error throw", () => {
    expect(summarizeWorkerError("boom")).toBe("Worker execution failed");
  });
});
