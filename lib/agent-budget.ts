export type TaskBudget = {
  maxRwf: number;
  spentRwf: number;
  reservedRwf: number;
};

export type BudgetDecision = {
  status: "allowed" | "warning" | "approval_required" | "exhausted";
  remainingRwf: number;
  projectedRwf: number;
  utilization: number;
};

function assertMoney(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer RWF amount`);
}

/** Applies a hard task cap before any provider work is dispatched. */
export function evaluateBudget(budget: TaskBudget, proposedRwf: number): BudgetDecision {
  assertMoney(budget.maxRwf, "maxRwf");
  assertMoney(budget.spentRwf, "spentRwf");
  assertMoney(budget.reservedRwf, "reservedRwf");
  assertMoney(proposedRwf, "proposedRwf");
  if (budget.maxRwf === 0) return { status: "exhausted", remainingRwf: 0, projectedRwf: proposedRwf, utilization: 1 };

  const committed = budget.spentRwf + budget.reservedRwf;
  const projectedRwf = committed + proposedRwf;
  const remainingRwf = Math.max(0, budget.maxRwf - committed);
  const utilization = projectedRwf / budget.maxRwf;
  const status = remainingRwf === 0 && proposedRwf > 0
    ? "exhausted"
    : proposedRwf > remainingRwf
    ? "approval_required"
    : utilization >= 0.85
      ? "warning"
      : "allowed";
  return { status, remainingRwf, projectedRwf, utilization };
}

export function settleUsage(budget: TaskBudget, reservedRwf: number, actualRwf: number): TaskBudget {
  assertMoney(reservedRwf, "reservedRwf");
  assertMoney(actualRwf, "actualRwf");
  if (reservedRwf > budget.reservedRwf) throw new Error("Cannot settle more than the reserved task amount");
  if (actualRwf > reservedRwf) throw new Error("Actual usage exceeds the step reservation");
  if (budget.spentRwf + actualRwf > budget.maxRwf) throw new Error("Actual usage exceeds the approved task cap");
  return { ...budget, reservedRwf: budget.reservedRwf - reservedRwf, spentRwf: budget.spentRwf + actualRwf };
}
