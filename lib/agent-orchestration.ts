export type AgentRole = "planner" | "coding" | "reviewer" | "research" | "operator";
export type StepStatus = "pending" | "ready" | "running" | "awaiting_approval" | "completed" | "failed" | "blocked" | "cancelled";

export type AgentStep = {
  id: string;
  title: string;
  role: AgentRole;
  dependsOn: string[];
  status: StepStatus;
  requiresApproval?: boolean;
  sandboxTemplate?: "coding" | "browser" | "data";
};

export type AgentRunPlan = {
  runId: string;
  title: string;
  maxParallelism: number;
  steps: AgentStep[];
};

export type GraphIssue = {
  code: "duplicate_step" | "missing_dependency" | "cycle" | "invalid_parallelism";
  stepId: string;
  message: string;
};

export type CodingTaskInput = {
  runId: string;
  title: string;
  requiresBrowserVerification: boolean;
};

/**
 * Produces a constrained coding workflow. The planner may propose implementation
 * details later, but the execution checkpoints are fixed and auditable here.
 */
export function buildCodingTaskPlan(input: CodingTaskInput): AgentRunPlan {
  const inspectId = `${input.runId}:inspect`;
  const reproduceId = `${input.runId}:reproduce`;
  const implementId = `${input.runId}:implement`;
  const checksId = `${input.runId}:checks`;
  const reviewId = `${input.runId}:review`;

  const steps: AgentStep[] = [
    { id: inspectId, title: "Inspect repository and constraints", role: "coding", dependsOn: [], status: "pending", sandboxTemplate: "coding" },
    { id: reproduceId, title: "Reproduce issue and establish baseline", role: "coding", dependsOn: [inspectId], status: "pending", sandboxTemplate: "coding" },
    { id: implementId, title: "Implement scoped change", role: "coding", dependsOn: [reproduceId], status: "pending", sandboxTemplate: "coding" },
    { id: checksId, title: "Run targeted checks and build", role: "coding", dependsOn: [implementId], status: "pending", sandboxTemplate: "coding" },
    { id: reviewId, title: "Review diff and prepare handoff", role: "reviewer", dependsOn: [checksId], status: "pending", requiresApproval: true },
  ];

  if (input.requiresBrowserVerification) {
    steps.splice(4, 0, {
      id: `${input.runId}:browser`,
      title: "Verify affected workflow in browser", role: "coding", dependsOn: [checksId], status: "pending", sandboxTemplate: "browser",
    });
    steps[5].dependsOn = [checksId, `${input.runId}:browser`];
  }

  return { runId: input.runId, title: input.title, maxParallelism: 2, steps };
}

/** Returns pending steps whose dependencies have completed, respecting the run cap. */
export function scheduleReadySteps(plan: AgentRunPlan): AgentStep[] {
  const completed = new Set(plan.steps.filter((step) => step.status === "completed").map((step) => step.id));
  const activeCount = plan.steps.filter((step) => step.status === "running" || step.status === "ready").length;
  const availableSlots = Math.max(0, plan.maxParallelism - activeCount);

  return plan.steps
    .filter((step) => step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)))
    .slice(0, availableSlots)
    .map((step) => ({ ...step, status: "ready" }));
}

/** Validates planner output before any payment hold or sandbox is created. */
export function validateTaskGraph(plan: AgentRunPlan): GraphIssue[] {
  const issues: GraphIssue[] = [];
  const ids = new Set<string>();

  if (!Number.isInteger(plan.maxParallelism) || plan.maxParallelism < 1 || plan.maxParallelism > 8) {
    issues.push({
      code: "invalid_parallelism",
      stepId: plan.runId,
      message: `Run ${plan.runId} maxParallelism must be an integer between 1 and 8`,
    });
  }

  for (const step of plan.steps) {
    if (ids.has(step.id)) issues.push({ code: "duplicate_step", stepId: step.id, message: `Duplicate step id: ${step.id}` });
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) {
      if (!ids.has(dependency)) issues.push({ code: "missing_dependency", stepId: step.id, message: `${step.id} depends on missing step ${dependency}` });
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stepsById = new Map(plan.steps.map((step) => [step.id, step]));
  function visit(stepId: string): boolean {
    if (visiting.has(stepId)) return true;
    if (visited.has(stepId)) return false;
    visiting.add(stepId);
    const step = stepsById.get(stepId);
    const cyclic = step?.dependsOn.some((dependency) => stepsById.has(dependency) && visit(dependency)) ?? false;
    visiting.delete(stepId);
    visited.add(stepId);
    return cyclic;
  }
  for (const step of plan.steps) {
    if (visit(step.id)) {
      issues.push({ code: "cycle", stepId: step.id, message: `Dependency cycle includes ${step.id}` });
      break;
    }
  }
  return issues;
}

/**
 * Selects work round-robin across runs so a large run cannot consume every
 * global worker. Per-run limits are still enforced by scheduleReadySteps.
 */
export function scheduleAcrossRuns(plans: AgentRunPlan[], globalParallelism: number): AgentStep[] {
  const slots = Math.max(0, globalParallelism - plans.flatMap((plan) => plan.steps).filter((step) => step.status === "running" || step.status === "ready").length);
  const queues = plans.map(scheduleReadySteps);
  const selected: AgentStep[] = [];
  let cursor = 0;
  while (selected.length < slots && queues.some((queue) => queue.length > 0)) {
    const queue = queues[cursor % queues.length];
    const step = queue.shift();
    if (step) selected.push(step);
    cursor += 1;
  }
  return selected;
}

/** Marks descendants of a failed/cancelled step as blocked for an honest terminal state. */
export function propagateBlockedSteps(plan: AgentRunPlan): AgentRunPlan {
  const terminalFailures = new Set(plan.steps.filter((step) => step.status === "failed" || step.status === "cancelled" || step.status === "blocked").map((step) => step.id));
  const steps = plan.steps.map((step) => ({ ...step }));
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.status === "pending" && step.dependsOn.some((dependency) => terminalFailures.has(dependency))) {
        step.status = "blocked";
        terminalFailures.add(step.id);
        changed = true;
      }
    }
  }
  return { ...plan, steps };
}

export function runStatus(plan: AgentRunPlan): "queued" | "running" | "awaiting_approval" | "blocked" | "completed" | "failed" | "cancelled" {
  if (plan.steps.some((step) => step.status === "failed")) return "failed";
  if (plan.steps.every((step) => step.status === "completed" || step.status === "cancelled")) return plan.steps.some((step) => step.status === "cancelled") ? "cancelled" : "completed";
  if (plan.steps.every((step) => step.status === "completed")) return "completed";
  if (plan.steps.some((step) => step.status === "awaiting_approval")) return "awaiting_approval";
  if (plan.steps.some((step) => step.status === "running" || step.status === "ready")) return "running";
  if (scheduleReadySteps(plan).length === 0) return "blocked";
  return "queued";
}

export type CodingExecutionRequest = {
  runId: string;
  stepId: string;
  repositoryUrl: string;
  baseRef: string;
  instructions: string;
};

export type CodingExecutionResult = {
  status: "completed" | "failed" | "needs_review" | "needs_configuration";
  summary: string;
  artifactReferences: string[];
};

/**
 * Contract for an E2B-backed coding worker. Implementations must write evidence
 * back to Convex; they must not merge, deploy, or send messages on their own.
 */
export interface CodingExecutor {
  execute(request: CodingExecutionRequest): Promise<CodingExecutionResult>;
}
