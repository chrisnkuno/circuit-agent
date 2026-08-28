import { describe, expect, it } from "vitest";
import { automationCap, decideAutomation, DEFAULT_AUTO_APPROVE_RWF, MANUAL_ONLY_RWF } from "./automation-budget";

describe("automationCap", () => {
  it("falls back to the default rather than treating an unset ceiling as zero", () => {
    // Reading "unset" as zero would silently turn automation off for every existing workspace.
    expect(automationCap(undefined)).toBe(DEFAULT_AUTO_APPROVE_RWF);
    expect(automationCap(Number.NaN)).toBe(DEFAULT_AUTO_APPROVE_RWF);
    expect(automationCap(-10)).toBe(DEFAULT_AUTO_APPROVE_RWF);
  });

  it("keeps an explicit ceiling, including an explicit zero", () => {
    expect(automationCap(12_000)).toBe(12_000);
    expect(automationCap(MANUAL_ONLY_RWF)).toBe(MANUAL_ONLY_RWF);
    expect(automationCap(999.9)).toBe(999);
  });
});

describe("decideAutomation", () => {
  const cap = 5_000;

  it("starts a sandbox immediately when the quote is within the ceiling", () => {
    expect(decideAutomation({ kind: "task_start", quotedRwf: 4_999, configuredCapRwf: cap }).automatic).toBe(true);
    // The boundary is inclusive: a quote exactly at the ceiling is within it.
    expect(decideAutomation({ kind: "task_start", quotedRwf: cap, configuredCapRwf: cap }).automatic).toBe(true);
  });

  it("stops and asks the moment a quote exceeds the ceiling, and says by what rule", () => {
    const decision = decideAutomation({ kind: "task_start", quotedRwf: cap + 1, configuredCapRwf: cap });
    expect(decision.automatic).toBe(false);
    expect(decision.reason).toContain("5,000");
  });

  it("never automates anything but starting a sandbox", () => {
    // A budget overage means the work already cost more than quoted, and an external action
    // changes something outside this system. Both are exactly when a person wants to be asked.
    for (const kind of ["budget_overage", "external_action", "payment_authorization"]) {
      expect(decideAutomation({ kind, quotedRwf: 1, configuredCapRwf: cap }).automatic).toBe(false);
    }
  });

  it("honours a workspace that wants to approve everything by hand", () => {
    expect(decideAutomation({ kind: "task_start", quotedRwf: 1, configuredCapRwf: MANUAL_ONLY_RWF }).automatic).toBe(false);
  });

  it("asks rather than guesses when the quote itself is unreadable", () => {
    expect(decideAutomation({ kind: "task_start", quotedRwf: Number.NaN, configuredCapRwf: cap }).automatic).toBe(false);
    expect(decideAutomation({ kind: "task_start", quotedRwf: -1, configuredCapRwf: cap }).automatic).toBe(false);
  });

  it("uses the default ceiling when a workspace has never chosen one", () => {
    expect(decideAutomation({ kind: "task_start", quotedRwf: DEFAULT_AUTO_APPROVE_RWF, configuredCapRwf: undefined }).automatic).toBe(true);
    expect(decideAutomation({ kind: "task_start", quotedRwf: DEFAULT_AUTO_APPROVE_RWF + 1, configuredCapRwf: undefined }).automatic).toBe(false);
  });
});
