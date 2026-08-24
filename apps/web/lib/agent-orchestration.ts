import { capabilityRegistry } from "./capability-registry";
import type { TaskKind } from "./task-cost";

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
  capabilityIds?: string[];
};

export type AgentRunPlan = {
  runId: string;
  title: string;
  maxParallelism: number;
  capabilityIds?: string[];
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
  hasExistingCodebase?: boolean;
};

export type TaskPlanInput = {
  runId: string;
  title: string;
  kind: TaskKind;
  requiresBrowserVerification?: boolean;
  requestedCapabilityIds?: string[];
  /**
   * Whether the workspace will contain a codebase to work against. It changes the shape of the
   * graph, not merely its wording: inspection and reproduction are steps only when there is
   * something to inspect and a prior behaviour to reproduce.
   */
  hasExistingCodebase?: boolean;
};

type StepDefinition = Omit<AgentStep, "id" | "status"> & { key: string };

const taskWorkflows: Record<TaskKind, (input: TaskPlanInput) => StepDefinition[]> = {
  /**
   * Two shapes, chosen by whether a codebase exists to work against.
   *
   * Inspecting a repository and reproducing a baseline are real work when there is a repository and
   * a prior behaviour. Against an empty workspace they are neither, and the evidence was
   * unambiguous: across live runs, all four steps of a from-scratch task produced the same plan —
   * "create hello.py and run it" — four times over. Each step is a full model call, so the graph
   * was spending four calls and about ninety seconds to do one task's work, then reporting each
   * redundant repetition as progress.
   *
   * From-scratch work is therefore one step that writes and verifies. That is not a loss of rigour:
   * the step still runs its own verification commands, the worker repairs it in place when they
   * fail (see MAX_REPAIR_ATTEMPTS), and the command log records exactly what was checked. The
   * repository shape is left as it was, since there is no connected repository to validate a
   * change to it against.
   */
  coding: (input) => {
    if (!input.hasExistingCodebase) {
      const scratch: StepDefinition[] = [
        {
          key: "implement",
          title: "Build and verify the requested work",
          role: "coding",
          dependsOn: [],
          sandboxTemplate: "coding",
          capabilityIds: ["reasoning.plan", "workspace.files", "workspace.terminal"],
        },
      ];
      if (input.requiresBrowserVerification) {
        scratch.push({ key: "browser", title: "Verify affected workflow in browser", role: "coding", dependsOn: ["implement"], sandboxTemplate: "browser", capabilityIds: ["web.research"] });
      }
      scratch.push({ key: "review", title: "Review evidence and prepare handoff", role: "reviewer", dependsOn: input.requiresBrowserVerification ? ["implement", "browser"] : ["implement"], requiresApproval: true, capabilityIds: ["reasoning.plan"] });
      return scratch;
    }
    const steps: StepDefinition[] = [
      { key: "inspect", title: "Inspect repository and constraints", role: "coding", dependsOn: [], sandboxTemplate: "coding", capabilityIds: ["reasoning.plan", "workspace.files", "workspace.terminal"] },
      { key: "reproduce", title: "Reproduce issue and establish baseline", role: "coding", dependsOn: ["inspect"], sandboxTemplate: "coding", capabilityIds: ["workspace.terminal"] },
      { key: "implement", title: "Implement scoped change", role: "coding", dependsOn: ["reproduce"], sandboxTemplate: "coding", capabilityIds: ["workspace.files", "workspace.terminal"] },
      { key: "checks", title: "Run targeted checks and build", role: "coding", dependsOn: ["implement"], sandboxTemplate: "coding", capabilityIds: ["workspace.terminal"] },
    ];
    if (input.requiresBrowserVerification) {
      steps.push({ key: "browser", title: "Verify affected workflow in browser", role: "coding", dependsOn: ["checks"], sandboxTemplate: "browser", capabilityIds: ["web.research"] });
    }
    steps.push({ key: "review", title: "Review evidence and prepare handoff", role: "reviewer", dependsOn: input.requiresBrowserVerification ? ["checks", "browser"] : ["checks"], requiresApproval: true, capabilityIds: ["reasoning.plan"] });
    return steps;
  },
  research: () => [
    { key: "scope", title: "Define questions and evidence standard", role: "planner", dependsOn: [], capabilityIds: ["reasoning.plan"] },
    { key: "sources", title: "Gather and validate primary sources", role: "research", dependsOn: ["scope"], sandboxTemplate: "browser", capabilityIds: ["web.research"] },
    { key: "synthesis", title: "Synthesize findings with provenance", role: "research", dependsOn: ["sources"], sandboxTemplate: "data", capabilityIds: ["document.compose"] },
    { key: "review", title: "Review claims and deliver recommendation", role: "reviewer", dependsOn: ["synthesis"], requiresApproval: true, capabilityIds: ["reasoning.plan"] },
  ],
  writing: () => [
    { key: "brief", title: "Turn the goal into a structured brief", role: "planner", dependsOn: [], capabilityIds: ["reasoning.plan"] },
    { key: "draft", title: "Create the first deliverable", role: "operator", dependsOn: ["brief"], sandboxTemplate: "data", capabilityIds: ["workspace.files", "document.compose"] },
    { key: "revise", title: "Revise for accuracy, voice, and format", role: "reviewer", dependsOn: ["draft"], sandboxTemplate: "data", capabilityIds: ["document.compose"] },
    { key: "review", title: "Approve the packaged deliverable", role: "reviewer", dependsOn: ["revise"], requiresApproval: true, capabilityIds: ["reasoning.plan"] },
  ],
  operations: () => [
    { key: "inspect", title: "Inspect current state and policy", role: "operator", dependsOn: [], capabilityIds: ["reasoning.plan"] },
    { key: "proposal", title: "Prepare an exact action proposal", role: "operator", dependsOn: ["inspect"], capabilityIds: ["reasoning.plan"] },
    { key: "execute", title: "Execute the approved external action", role: "operator", dependsOn: ["proposal"], requiresApproval: true, capabilityIds: ["operations.execute"] },
    { key: "verify", title: "Verify outcome and record evidence", role: "reviewer", dependsOn: ["execute"], capabilityIds: ["reasoning.plan"] },
  ],
};

/** Compiles a task kind into a capability-scoped graph before any provider is called. */
export function buildTaskPlan(input: TaskPlanInput): AgentRunPlan {
  const selected = new Set(capabilityRegistry.resolve(input.kind, input.requestedCapabilityIds).map((item) => item.id));
  const definitions = taskWorkflows[input.kind](input);
  for (const step of definitions) {
    for (const capabilityId of step.capabilityIds ?? []) {
      const capability = capabilityRegistry.get(capabilityId);
      if (!capability || !capability.taskKinds.includes(input.kind)) throw new Error(`Workflow uses invalid capability ${capabilityId}`);
      selected.add(capabilityId);
    }
    if ((step.capabilityIds ?? []).some((id) => capabilityRegistry.get(id)?.requiresApproval) && !step.requiresApproval) {
      throw new Error(`Workflow step ${step.key} must require approval for its capabilities`);
    }
  }
  const steps = definitions.map(({ key, dependsOn, ...step }) => ({
    ...step,
    id: `${input.runId}:${key}`,
    dependsOn: dependsOn.map((dependency) => `${input.runId}:${dependency}`),
    status: "pending" as const,
  }));
  return { runId: input.runId, title: input.title, maxParallelism: input.kind === "coding" ? 2 : 1, capabilityIds: [...selected], steps };
}

/**
 * Produces a constrained coding workflow. The planner may propose implementation
 * details later, but the execution checkpoints are fixed and auditable here.
 */
export function buildCodingTaskPlan(input: CodingTaskInput): AgentRunPlan {
  return buildTaskPlan({ ...input, kind: "coding" });
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
