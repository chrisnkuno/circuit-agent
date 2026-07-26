import { describe, expect, it } from "vitest";
import { buildCodingTaskPlan, propagateBlockedSteps, runStatus, scheduleAcrossRuns, scheduleReadySteps, validateTaskGraph, type AgentRunPlan } from "./agent-orchestration";

describe("agent orchestration", () => {
  it("starts only dependency-free work and honors its concurrency cap", () => {
    const plan: AgentRunPlan = {
      runId: "run_1", title: "Parallel work", maxParallelism: 2,
      steps: [
        { id: "a", title: "A", role: "research", dependsOn: [], status: "pending" },
        { id: "b", title: "B", role: "coding", dependsOn: [], status: "pending" },
        { id: "c", title: "C", role: "reviewer", dependsOn: ["a"], status: "pending" },
      ],
    };
    expect(scheduleReadySteps(plan).map((step) => step.id)).toEqual(["a", "b"]);
  });

  it("builds a coding workflow with a review gate", () => {
    const plan = buildCodingTaskPlan({ runId: "run_2", title: "Fix checkout", requiresBrowserVerification: true });
    expect(plan.steps.map((step) => step.id)).toContain("run_2:browser");
    expect(plan.steps.at(-1)?.requiresApproval).toBe(true);
    expect(runStatus(plan)).toBe("queued");
    expect(validateTaskGraph(plan)).toEqual([]);
  });

  it("rejects missing dependencies and cycles before execution", () => {
    const plan: AgentRunPlan = { runId: "bad", title: "Bad graph", maxParallelism: 2, steps: [
      { id: "a", title: "A", role: "coding", dependsOn: ["b"], status: "pending" },
      { id: "b", title: "B", role: "coding", dependsOn: ["a", "missing"], status: "pending" },
    ] };
    expect(validateTaskGraph(plan).map((issue) => issue.code)).toEqual(["missing_dependency", "cycle"]);
  });

  it("rejects invalid run concurrency before scheduling", () => {
    const plan = buildCodingTaskPlan({ runId: "bad-cap", title: "Bad cap", requiresBrowserVerification: false });
    plan.maxParallelism = 0;
    expect(validateTaskGraph(plan)).toContainEqual(expect.objectContaining({ code: "invalid_parallelism" }));
  });

  it("schedules fairly across runs and propagates failure blockers", () => {
    const first = buildCodingTaskPlan({ runId: "first", title: "First", requiresBrowserVerification: false });
    const second = buildCodingTaskPlan({ runId: "second", title: "Second", requiresBrowserVerification: false });
    expect(scheduleAcrossRuns([first, second], 2).map((step) => step.id)).toEqual(["first:inspect", "second:inspect"]);
    first.steps[0].status = "failed";
    expect(propagateBlockedSteps(first).steps[1].status).toBe("blocked");
    expect(propagateBlockedSteps(first).steps.at(-1)?.status).toBe("blocked");
  });

  it("counts ready work against both run and global capacity", () => {
    const plan = buildCodingTaskPlan({ runId: "capacity", title: "Capacity", requiresBrowserVerification: false });
    plan.steps[0].status = "ready";
    plan.maxParallelism = 1;
    expect(scheduleReadySteps(plan)).toEqual([]);
    expect(scheduleAcrossRuns([plan], 1)).toEqual([]);
  });
});
