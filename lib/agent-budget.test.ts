import { describe, expect, it } from "vitest";
import { evaluateBudget, settleUsage } from "./agent-budget";

describe("task budget guard", () => {
  it("requires approval before a provider call can exceed the cap", () => {
    const decision = evaluateBudget({ maxRwf: 3000, spentRwf: 2200, reservedRwf: 300 }, 700);
    expect(decision.status).toBe("approval_required");
    expect(decision.remainingRwf).toBe(500);
  });

  it("releases a reservation and records actual integer RWF usage", () => {
    expect(settleUsage({ maxRwf: 3000, spentRwf: 500, reservedRwf: 1000 }, 1000, 800)).toEqual({ maxRwf: 3000, spentRwf: 1300, reservedRwf: 0 });
  });

  it("cannot settle more usage than the approved step reservation", () => {
    expect(() => settleUsage({ maxRwf: 3000, spentRwf: 500, reservedRwf: 500 }, 500, 600)).toThrow("step reservation");
  });

  it("reports an exhausted budget distinctly", () => {
    expect(evaluateBudget({ maxRwf: 1000, spentRwf: 1000, reservedRwf: 0 }, 1).status).toBe("exhausted");
  });
});
