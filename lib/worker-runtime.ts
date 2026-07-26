export type RecoverableStep = {
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  attempts: number;
  leaseExpiresAt?: number;
  reservedRwf: number;
  runCancelled?: boolean;
};

export type LeaseRecoveryDecision = {
  action: "none" | "retry" | "fail" | "cancel";
  releaseRwf: number;
  retryAfterMs?: number;
};

export function retryDelayMs(attempt: number, baseMs = 1_000, maximumMs = 60_000): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
  return Math.min(maximumMs, baseMs * 2 ** (attempt - 1));
}

/** Determines how an expired worker lease is recovered without duplicating its reservation. */
export function recoverExpiredLease(step: RecoverableStep, now: number, maxAttempts = 3): LeaseRecoveryDecision {
  if (!Number.isSafeInteger(step.reservedRwf) || step.reservedRwf < 0) throw new Error("reservedRwf must be a non-negative integer");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("maxAttempts must be a positive integer");
  if (step.status !== "running" || step.leaseExpiresAt === undefined || step.leaseExpiresAt > now) return { action: "none", releaseRwf: 0 };
  if (step.runCancelled) return { action: "cancel", releaseRwf: step.reservedRwf };
  if (step.attempts >= maxAttempts) return { action: "fail", releaseRwf: step.reservedRwf };
  return { action: "retry", releaseRwf: step.reservedRwf, retryAfterMs: retryDelayMs(step.attempts) };
}

export type StepOutcome = {
  outcome: "completed" | "failed";
  summary: string;
  artifactReferences: string[];
  reservedRwf: number;
  actualRwf: number;
};

/** Validates the evidence and accounting required before accepting a worker outcome. */
export function validateStepOutcome(outcome: StepOutcome): void {
  if (!outcome.summary.trim()) throw new Error("A worker outcome requires a non-empty summary");
  if (!Number.isSafeInteger(outcome.reservedRwf) || outcome.reservedRwf < 0) throw new Error("reservedRwf must be a non-negative integer");
  if (!Number.isSafeInteger(outcome.actualRwf) || outcome.actualRwf < 0) throw new Error("actualRwf must be a non-negative integer");
  if (outcome.actualRwf > outcome.reservedRwf) throw new Error("Actual usage exceeds the step reservation");
  if (outcome.outcome === "completed" && outcome.artifactReferences.length === 0) {
    throw new Error("Completed work requires at least one evidence reference");
  }
}
