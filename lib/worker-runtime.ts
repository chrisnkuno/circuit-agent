import { truncateEvidence } from "./artifacts";

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

/**
 * Some providers fail with an HTML error page (a WAF/bot-challenge block, a gateway
 * timeout page) instead of a JSON API error. Storing that raw markup verbatim as a
 * permanent step/event record is unreadable and unbounded, so it gets recognized and
 * replaced with a short, honest summary; every other error is just length-capped.
 */
export function summarizeWorkerError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Worker execution failed";
  const looksLikeHtml = /<!DOCTYPE html|<html[\s>]/i.test(message);
  return truncateEvidence(looksLikeHtml ? "Provider returned an HTML error page instead of a JSON response (likely a gateway or bot-protection block)." : message, 500);
}

/**
 * Separates "this attempt could not reach the provider" from "this work does not succeed".
 *
 * Only the first is worth another attempt. Retrying the second wastes real money on an outcome
 * that is already decided: a refusal, a schema the model will not produce, or a command the
 * sandbox policy forbids will fail identically every time. The default is deliberately
 * *permanent* — an unrecognized failure is not retried, so a new failure mode cannot silently
 * start costing three times as much.
 */
const TRANSIENT_FAILURE_PATTERNS = [
  /\baborted\b/i,
  /\btimed?\s?out\b/i,
  /\btimeout\b/i,
  /socket hang up/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/,
  /\bnetwork\b.*\b(error|failure)\b/i,
  /\bfetch failed\b/i,
  /\b(429|500|502|503|504)\b/,
  /rate.?limit/i,
  /\btemporarily\b/i,
  /\bunavailable\b/i,
  /\boverloaded\b/i,
  /bot-protection|bot challenge|HTML error page/i,
  /sandbox (start|create|connect)\w* failed/i,
];

/**
 * Provider-side spending capacity, which behaves unlike either category above.
 *
 * The model provider reserves each request's *maximum* possible cost before running it, so
 * concurrent requests hold that ceiling simultaneously. Once steps execute in parallel rather
 * than one at a time, a step can be refused for funds that a sibling step is merely holding and
 * will release when it finishes — the same work would have succeeded moments later. That is
 * worth waiting for, but not worth hammering: a genuinely empty account fails the same way every
 * time, so these retries are spaced far apart and still bounded by the shared attempt limit.
 */
const CAPACITY_FAILURE_PATTERNS = [
  /insufficient funds/i,
  /\b402\b/,
  /payment required/i,
  /quota exceeded/i,
  /\bcredit\b.*\b(exhaust|deplet|insufficient)/i,
];

const CAPACITY_RETRY_BASE_MS = 30_000;

export function classifyWorkerFailure(error: unknown): "transient" | "permanent" {
  const message = error instanceof Error ? error.message : String(error ?? "");
  if (CAPACITY_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "transient";
  return TRANSIENT_FAILURE_PATTERNS.some((pattern) => pattern.test(message)) ? "transient" : "permanent";
}

/** How long to wait before re-attempting a failure, given what kind of failure it was. */
export function retryDelayForFailure(error: unknown, attempt: number): number {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const isCapacity = CAPACITY_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
  return retryDelayMs(attempt, isCapacity ? CAPACITY_RETRY_BASE_MS : 1_000, isCapacity ? 120_000 : 60_000);
}

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
