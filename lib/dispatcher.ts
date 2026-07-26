import { evaluateBudget, type TaskBudget } from "./agent-budget";
import { scheduleAcrossRuns, validateTaskGraph, type AgentRunPlan, type AgentStep } from "./agent-orchestration";

export type DispatchAction = "dispatch" | "awaiting_approval" | "budget_approval_required" | "budget_exhausted" | "needs_configuration" | "invalid_graph";

export type DispatchDecision = {
  runId: string;
  step?: AgentStep;
  action: DispatchAction;
  reservationRwf: number;
  reason: string;
};

export type DispatchPlanningInput = {
  plans: AgentRunPlan[];
  globalParallelism: number;
  codingExecutionReady: boolean;
  budgetsByRun: Record<string, TaskBudget | undefined>;
  estimatedRwfByStep: Record<string, number | undefined>;
};

/** Produces auditable dispatch decisions before any worker or provider is called. */
export function planDispatch(input: DispatchPlanningInput): DispatchDecision[] {
  if (!Number.isInteger(input.globalParallelism) || input.globalParallelism < 1) throw new Error("globalParallelism must be a positive integer");
  const decisions: DispatchDecision[] = [];
  const validPlans: AgentRunPlan[] = [];
  const stepOwners = new Map<string, string>();
  const duplicateStepIds = new Set<string>();

  for (const plan of input.plans) {
    for (const step of plan.steps) {
      const owner = stepOwners.get(step.id);
      if (owner && owner !== plan.runId) duplicateStepIds.add(step.id);
      else stepOwners.set(step.id, plan.runId);
    }
  }

  for (const plan of input.plans) {
    const issues = validateTaskGraph(plan);
    const ambiguousIds = plan.steps.filter((step) => duplicateStepIds.has(step.id)).map((step) => step.id);
    if (issues.length > 0 || ambiguousIds.length > 0) {
      const reasons = issues.map((issue) => issue.message);
      if (ambiguousIds.length > 0) reasons.push(`Step IDs must be globally unique across active runs: ${ambiguousIds.join(", ")}`);
      decisions.push({ runId: plan.runId, action: "invalid_graph", reservationRwf: 0, reason: reasons.join("; ") });
    } else {
      validPlans.push(plan);
    }
  }

  for (const step of scheduleAcrossRuns(validPlans, input.globalParallelism)) {
    const runId = stepOwners.get(step.id);
    if (!runId) throw new Error(`Scheduled step ${step.id} has no owning run`);
    const estimatedRwf = input.estimatedRwfByStep[step.id];
    const budget = input.budgetsByRun[runId];
    if (step.requiresApproval) {
      decisions.push({ runId, step, action: "awaiting_approval", reservationRwf: 0, reason: "This step crosses a human approval gate." });
      continue;
    }
    if (!input.codingExecutionReady || !budget || estimatedRwf === undefined) {
      decisions.push({ runId, step, action: "needs_configuration", reservationRwf: 0, reason: "Execution provider, budget, or step estimate is not configured." });
      continue;
    }
    const budgetDecision = evaluateBudget(budget, estimatedRwf);
    if (budgetDecision.status === "exhausted") {
      decisions.push({ runId, step, action: "budget_exhausted", reservationRwf: 0, reason: "The approved task budget is exhausted." });
    } else if (budgetDecision.status === "approval_required") {
      decisions.push({ runId, step, action: "budget_approval_required", reservationRwf: 0, reason: "This step would exceed the approved task cap." });
    } else {
      decisions.push({ runId, step, action: "dispatch", reservationRwf: estimatedRwf, reason: budgetDecision.status === "warning" ? "Dispatch allowed near the budget warning threshold." : "Dispatch allowed." });
    }
  }
  return decisions;
}
