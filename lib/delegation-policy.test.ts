import { describe, expect, it } from "vitest";
import { planDelegation } from "./delegation-policy";

const parent = { taskId: "task", runId: "parent", depth: 0, activeChildren: 0, totalChildren: 0, remainingRwf: 1_000, capabilityIds: ["reasoning.plan", "workspace.files", "workspace.terminal", "operations.execute"] };
const limits = { maxDepth: 2, maxConcurrentChildren: 3, maxChildrenPerRun: 8, maxIterationsPerChild: 20, maxBudgetRwfPerChild: 500 };
const request = { goal: "Inspect the tests", capabilityIds: ["workspace.files"], budgetRwf: 200, maxIterations: 10, externalActionsApproved: false };

describe("delegation policy", () => {
  it("creates a reduced child scope with its own bounded budget", () => {
    expect(planDelegation(parent, request, limits)).toEqual({ allowed: true, child: { taskId: "task", parentRunId: "parent", depth: 1, goal: "Inspect the tests", capabilityIds: ["workspace.files"], budgetRwf: 200, maxIterations: 10 } });
  });

  it("rejects authority amplification and unapproved external actions", () => {
    expect(planDelegation(parent, { ...request, capabilityIds: ["web.research"] }, limits)).toMatchObject({ allowed: false, code: "capability_scope" });
    expect(planDelegation(parent, { ...request, capabilityIds: ["operations.execute"] }, limits)).toMatchObject({ allowed: false, code: "approval_required" });
  });

  it("enforces depth, concurrency, count, iteration, and budget limits", () => {
    expect(planDelegation({ ...parent, depth: 2 }, request, limits)).toMatchObject({ code: "depth_limit" });
    expect(planDelegation({ ...parent, activeChildren: 3 }, request, limits)).toMatchObject({ code: "concurrency_limit" });
    expect(planDelegation({ ...parent, totalChildren: 8 }, request, limits)).toMatchObject({ code: "child_limit" });
    expect(planDelegation(parent, { ...request, maxIterations: 21 }, limits)).toMatchObject({ code: "iteration_limit" });
    expect(planDelegation(parent, { ...request, budgetRwf: 501 }, limits)).toMatchObject({ code: "budget_limit" });
  });
});
