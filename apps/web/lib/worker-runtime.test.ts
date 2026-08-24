import { describe, expect, it } from "vitest";
import { classifyWorkerFailure, recoverExpiredLease, retryDelayForFailure, retryDelayMs, summarizeCommandFailure, summarizeWorkerError, validateStepOutcome } from "./worker-runtime";

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

describe("classifyWorkerFailure", () => {
  it("retries failures that only describe not reaching the provider", () => {
    const transient = [
      "Request was aborted.",
      "The operation timed out",
      "socket hang up",
      "fetch failed: ECONNRESET",
      "Provider returned 503 Service Unavailable",
      "Rate limit exceeded, retry later",
      "Model is temporarily overloaded",
      "Provider returned an HTML error page instead of a JSON response (likely a gateway or bot-protection block).",
      "Sandbox create failed",
    ];
    for (const message of transient) {
      expect(classifyWorkerFailure(new Error(message)), message).toBe("transient");
    }
  });

  it("never retries a verdict the work already reached", () => {
    // Each of these fails identically on every attempt, so a retry only spends money again.
    const permanent = [
      "Command contains an argument blocked by the sandbox policy",
      "Git command is not read-only",
      "Model response did not contain a coding plan matching the required schema after one retry",
      "model refused: unsafe request",
      "Usage exceeds approved task cap",
      "Model response ended with finish reason length",
    ];
    for (const message of permanent) {
      expect(classifyWorkerFailure(new Error(message)), message).toBe("permanent");
    }
  });

  it("treats an unrecognized failure as permanent so a new failure mode cannot triple its own cost", () => {
    expect(classifyWorkerFailure(new Error("something entirely new"))).toBe("permanent");
    expect(classifyWorkerFailure(undefined)).toBe("permanent");
  });
});

describe("provider spending capacity", () => {
  // Observed live once steps began running in parallel: the provider reserves each request's
  // maximum cost, so concurrent steps hold the balance and refuse a sibling that would fit.
  const refusal = new Error("402 Insufficient funds for the maximum request cost (need 17.06 RWF, available 1.18 RWF, balance 12.15 RWF, held 10.97)");

  it("waits for capacity a sibling step is holding rather than failing the run", () => {
    expect(classifyWorkerFailure(refusal)).toBe("transient");
  });

  it("waits far longer for capacity than for a network blip, since an empty account will not recover in a second", () => {
    expect(retryDelayForFailure(refusal, 1)).toBeGreaterThanOrEqual(30_000);
    expect(retryDelayForFailure(new Error("socket hang up"), 1)).toBeLessThanOrEqual(1_000);
  });

  it("still bounds the wait so a stuck step cannot sit forever", () => {
    expect(retryDelayForFailure(refusal, 8)).toBeLessThanOrEqual(120_000);
  });
});

describe("summarizeCommandFailure", () => {
  // Every failure of this class used to read "A verification command failed." and nothing else,
  // which is unactionable in the terminal, the notification, and the run ledger alike.
  it("names the command and the reason it gave", () => {
    const summary = summarizeCommandFailure({
      program: "python3",
      args: ["verify.py"],
      exitCode: 1,
      stdout: "",
      stderr: 'Traceback (most recent call last):\n  File "verify.py", line 4\nAssertionError: expected hello world',
    });
    expect(summary).toContain("`python3 verify.py` exited 1");
    expect(summary).toContain("AssertionError: expected hello world");
  });

  it("falls back to stdout for tools that report failure there", () => {
    const summary = summarizeCommandFailure({ program: "npm", args: ["test"], exitCode: 1, stdout: "2 failing", stderr: "" });
    expect(summary).toContain("2 failing");
  });

  it("still identifies the command when it said nothing at all", () => {
    expect(summarizeCommandFailure({ program: "node", args: ["x.js"], exitCode: 127 })).toBe("`node x.js` exited 127");
  });

  it("stays bounded so it cannot flood a step summary or an email", () => {
    const summary = summarizeCommandFailure({ program: "node", args: ["x.js"], exitCode: 1, stderr: "e".repeat(10_000) });
    expect(summary.length).toBeLessThanOrEqual(500);
  });
});
