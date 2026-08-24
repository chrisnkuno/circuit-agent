import { describe, expect, it } from "vitest";
import { buildCodingTaskPlan, buildTaskPlan, propagateBlockedSteps, runStatus, scheduleAcrossRuns, scheduleReadySteps, validateTaskGraph, type AgentRunPlan } from "./agent-orchestration";

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
    const plan = buildCodingTaskPlan({ runId: "run_2", title: "Fix checkout", requiresBrowserVerification: true, hasExistingCodebase: true });
    expect(plan.steps.map((step) => step.id)).toContain("run_2:browser");
    expect(plan.steps.at(-1)?.requiresApproval).toBe(true);
    expect(runStatus(plan)).toBe("queued");
    expect(validateTaskGraph(plan)).toEqual([]);
  });

  it.each(["research", "writing", "operations"] as const)("builds a valid capability-scoped %s workflow", (kind) => {
    const plan = buildTaskPlan({ runId: `run-${kind}`, title: `${kind} task`, kind });
    expect(validateTaskGraph(plan)).toEqual([]);
    expect(plan.steps.every((step) => (step.capabilityIds?.length ?? 0) > 0)).toBe(true);
    expect(plan.steps.at(-1)?.role).toBe("reviewer");
  });

  it("requires approval before an operations connector can execute", () => {
    const plan = buildTaskPlan({ runId: "run-ops", title: "Update CRM", kind: "operations" });
    expect(plan.steps.find((step) => step.id.endsWith(":execute"))).toMatchObject({
      requiresApproval: true,
      capabilityIds: ["operations.execute"],
    });
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
    const first = buildCodingTaskPlan({ runId: "first", title: "First", requiresBrowserVerification: false, hasExistingCodebase: true });
    const second = buildCodingTaskPlan({ runId: "second", title: "Second", requiresBrowserVerification: false, hasExistingCodebase: true });
    expect(scheduleAcrossRuns([first, second], 2).map((step) => step.id)).toEqual(["first:inspect", "second:inspect"]);
    first.steps[0].status = "failed";
    expect(propagateBlockedSteps(first).steps[1].status).toBe("blocked");
    expect(propagateBlockedSteps(first).steps.at(-1)?.status).toBe("blocked");
  });

  it("counts ready work against both run and global capacity", () => {
    const plan = buildCodingTaskPlan({ runId: "capacity", title: "Capacity", requiresBrowserVerification: false, hasExistingCodebase: true });
    plan.steps[0].status = "ready";
    plan.maxParallelism = 1;
    expect(scheduleReadySteps(plan)).toEqual([]);
    expect(scheduleAcrossRuns([plan], 1)).toEqual([]);
  });
});

describe("the coding graph matches the work that exists", () => {
  /**
   * Observed live before this: against an empty workspace, all four steps of a from-scratch task
   * produced the same plan — "create hello.py and run it" — four times over, at one model call and
   * roughly twenty-five seconds each.
   */
  it("does not inspect or reproduce when there is nothing to inspect and no prior behaviour", () => {
    const plan = buildCodingTaskPlan({ runId: "scratch", title: "Write a script", requiresBrowserVerification: false });
    const codingSteps = plan.steps.filter((step) => step.role === "coding").map((step) => step.id);
    expect(codingSteps).toEqual(["scratch:implement"]);
    expect(plan.steps.some((step) => step.id.endsWith(":reproduce"))).toBe(false);
  });

  it("keeps the full graph when a codebase exists to work against", () => {
    const plan = buildCodingTaskPlan({ runId: "repo", title: "Fix a bug", requiresBrowserVerification: false, hasExistingCodebase: true });
    const codingSteps = plan.steps.filter((step) => step.role === "coding").map((step) => step.id);
    expect(codingSteps).toEqual(["repo:inspect", "repo:reproduce", "repo:implement", "repo:checks"]);
  });

  it("stays a valid graph in both shapes, including with browser verification", () => {
    for (const hasExistingCodebase of [false, true]) {
      for (const requiresBrowserVerification of [false, true]) {
        const plan = buildCodingTaskPlan({ runId: "shape", title: "Task", requiresBrowserVerification, hasExistingCodebase });
        expect(validateTaskGraph(plan), `${hasExistingCodebase}/${requiresBrowserVerification}`).toEqual([]);
      }
    }
  });
});
