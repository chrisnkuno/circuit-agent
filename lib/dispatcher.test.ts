import { describe, expect, it } from "vitest";
import { buildCodingTaskPlan } from "./agent-orchestration";
import { planDispatch, qualifiedStepId, toDispatchPlan } from "./dispatcher";

describe("dispatcher planning", () => {
  it("dispatches fairly while stopping an exhausted run", () => {
    const first = buildCodingTaskPlan({ runId: "first", title: "First", requiresBrowserVerification: false });
    const second = buildCodingTaskPlan({ runId: "second", title: "Second", requiresBrowserVerification: false });
    const decisions = planDispatch({
      plans: [first, second], globalParallelism: 2, codingExecutionReady: true,
      budgetsByRun: { first: { maxRwf: 1000, spentRwf: 0, reservedRwf: 0 }, second: { maxRwf: 1000, spentRwf: 1000, reservedRwf: 0 } },
      estimatedRwfByStep: { "first:inspect": 200, "second:inspect": 200 },
    });
    expect(decisions.map((decision) => decision.action)).toEqual(["dispatch", "budget_exhausted"]);
  });

  it("does not dispatch without provider readiness", () => {
    const plan = buildCodingTaskPlan({ runId: "org:config", title: "Config", requiresBrowserVerification: false });
    expect(planDispatch({ plans: [plan], globalParallelism: 1, codingExecutionReady: false, budgetsByRun: {}, estimatedRwfByStep: {} })[0]).toMatchObject({ runId: "org:config", action: "needs_configuration" });
  });

  it("routes consequential steps through approval", () => {
    const plan = buildCodingTaskPlan({ runId: "approval", title: "Approval", requiresBrowserVerification: false });
    for (const step of plan.steps.slice(0, -1)) step.status = "completed";
    const decision = planDispatch({ plans: [plan], globalParallelism: 1, codingExecutionReady: true, budgetsByRun: { approval: { maxRwf: 1000, spentRwf: 0, reservedRwf: 0 } }, estimatedRwfByStep: { "approval:review": 100 } })[0];
    expect(decision.action).toBe("awaiting_approval");
  });

  it("blocks invalid planner output", () => {
    const plan = buildCodingTaskPlan({ runId: "invalid", title: "Invalid", requiresBrowserVerification: false });
    plan.steps[0].dependsOn = ["missing"];
    expect(planDispatch({ plans: [plan], globalParallelism: 1, codingExecutionReady: true, budgetsByRun: {}, estimatedRwfByStep: {} })[0].action).toBe("invalid_graph");
  });

  it("rejects ambiguous step ownership across active runs", () => {
    const first = buildCodingTaskPlan({ runId: "first", title: "First", requiresBrowserVerification: false });
    const second = buildCodingTaskPlan({ runId: "second", title: "Second", requiresBrowserVerification: false });
    second.steps[0].id = first.steps[0].id;
    const decisions = planDispatch({
      plans: [first, second],
      globalParallelism: 2,
      codingExecutionReady: true,
      budgetsByRun: {},
      estimatedRwfByStep: {},
    });
    expect(decisions).toHaveLength(2);
    expect(decisions.every((decision) => decision.action === "invalid_graph")).toBe(true);
    expect(decisions[0].reason).toContain("globally unique");
  });

  // Regression: persisted steps store a run-local stepKey, and every coding run uses the same
  // four keys. Handing those bare keys to planDispatch made each run look ambiguous to the
  // other, so all of them were failed closed as invalid_graph and nothing was ever dispatched
  // — the whole queue jammed the moment a second run existed.
  it("dispatches concurrent runs that share the same persisted step keys", () => {
    const persisted = [
      { stepKey: "inspect", title: "Inspect", role: "coding" as const, dependsOn: [], status: "pending" as const, requiresApproval: false },
      { stepKey: "reproduce", title: "Reproduce", role: "coding" as const, dependsOn: ["inspect"], status: "pending" as const, requiresApproval: false },
    ];
    const plans = ["runA", "runB"].map((runId) => toDispatchPlan({ runId, title: "objective", maxParallelism: 2, steps: persisted }));
    const decisions = planDispatch({
      plans,
      globalParallelism: 4,
      codingExecutionReady: true,
      budgetsByRun: { runA: { maxRwf: 2400, spentRwf: 0, reservedRwf: 0 }, runB: { maxRwf: 2400, spentRwf: 0, reservedRwf: 0 } },
      estimatedRwfByStep: { [qualifiedStepId("runA", "inspect")]: 200, [qualifiedStepId("runB", "inspect")]: 200 },
    });
    expect(decisions.map((decision) => decision.action)).toEqual(["dispatch", "dispatch"]);
    // The dispatcher looks each decision's step back up by this id to claim the right row.
    expect(decisions.map((decision) => decision.step?.id)).toEqual([qualifiedStepId("runA", "inspect"), qualifiedStepId("runB", "inspect")]);
  });

  it("allows work near the cap while preserving a warning reason", () => {
    const plan = buildCodingTaskPlan({ runId: "warning", title: "Warning", requiresBrowserVerification: false });
    const decision = planDispatch({
      plans: [plan], globalParallelism: 1, codingExecutionReady: true,
      budgetsByRun: { warning: { maxRwf: 1000, spentRwf: 800, reservedRwf: 0 } },
      estimatedRwfByStep: { "warning:inspect": 100 },
    })[0];
    expect(decision).toMatchObject({ action: "dispatch", reservationRwf: 100 });
    expect(decision.reason).toContain("warning threshold");
  });
});
