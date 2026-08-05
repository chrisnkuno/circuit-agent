import { capabilityRegistry } from "./capability-registry";

export type DelegationLimits = {
  maxDepth: number;
  maxConcurrentChildren: number;
  maxChildrenPerRun: number;
  maxIterationsPerChild: number;
  maxBudgetRwfPerChild: number;
};

export type ParentRunScope = {
  taskId: string;
  runId: string;
  depth: number;
  activeChildren: number;
  totalChildren: number;
  remainingRwf: number;
  capabilityIds: string[];
};

export type DelegationRequest = {
  goal: string;
  capabilityIds: string[];
  budgetRwf: number;
  maxIterations: number;
  externalActionsApproved: boolean;
};

export type DelegationDecision =
  | { allowed: true; child: { taskId: string; parentRunId: string; depth: number; goal: string; capabilityIds: string[]; budgetRwf: number; maxIterations: number } }
  | { allowed: false; code: "depth_limit" | "concurrency_limit" | "child_limit" | "budget_limit" | "iteration_limit" | "capability_scope" | "approval_required" | "invalid_request"; reason: string };

/** Produces a child scope that can only reduce the parent's authority and budget. */
export function planDelegation(parent: ParentRunScope, request: DelegationRequest, limits: DelegationLimits): DelegationDecision {
  if (![limits.maxDepth, limits.maxConcurrentChildren, limits.maxChildrenPerRun, limits.maxIterationsPerChild, limits.maxBudgetRwfPerChild].every((value) => Number.isSafeInteger(value) && value >= 1)) {
    return { allowed: false, code: "invalid_request", reason: "Delegation limits must be positive integers." };
  }
  if (!parent.taskId.trim() || !parent.runId.trim() || !request.goal.trim() || request.goal.length > 4_000) {
    return { allowed: false, code: "invalid_request", reason: "Delegation requires bounded task identity and a non-empty goal." };
  }
  if (![parent.depth, parent.activeChildren, parent.totalChildren, parent.remainingRwf].every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return { allowed: false, code: "invalid_request", reason: "Parent delegation counters are invalid." };
  }
  if (parent.depth + 1 > limits.maxDepth) return { allowed: false, code: "depth_limit", reason: "Delegation depth limit reached." };
  if (parent.activeChildren >= limits.maxConcurrentChildren) return { allowed: false, code: "concurrency_limit", reason: "Concurrent child limit reached." };
  if (parent.totalChildren >= limits.maxChildrenPerRun) return { allowed: false, code: "child_limit", reason: "Total child-run limit reached." };
  if (!Number.isSafeInteger(request.maxIterations) || request.maxIterations < 1 || request.maxIterations > limits.maxIterationsPerChild) {
    return { allowed: false, code: "iteration_limit", reason: "Child iteration request exceeds its configured limit." };
  }
  if (!Number.isSafeInteger(request.budgetRwf) || request.budgetRwf < 1 || request.budgetRwf > parent.remainingRwf || request.budgetRwf > limits.maxBudgetRwfPerChild) {
    return { allowed: false, code: "budget_limit", reason: "Child budget exceeds the parent remainder or per-child limit." };
  }
  const parentCapabilities = new Set(parent.capabilityIds);
  const capabilities = [...new Set(request.capabilityIds)];
  if (capabilities.length === 0 || capabilities.some((id) => !parentCapabilities.has(id) || !capabilityRegistry.get(id))) {
    return { allowed: false, code: "capability_scope", reason: "A child may only receive a non-empty subset of its parent's known capabilities." };
  }
  if (!request.externalActionsApproved && capabilities.some((id) => capabilityRegistry.get(id)?.risk === "external_action")) {
    return { allowed: false, code: "approval_required", reason: "External-action authority cannot be delegated without explicit approval." };
  }
  return {
    allowed: true,
    child: {
      taskId: parent.taskId,
      parentRunId: parent.runId,
      depth: parent.depth + 1,
      goal: request.goal,
      capabilityIds: capabilities,
      budgetRwf: request.budgetRwf,
      maxIterations: request.maxIterations,
    },
  };
}
