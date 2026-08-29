/**
 * Whether a coding step that stopped only because it ran out of wall-clock should be resumed.
 *
 * A step runs inside one Convex action, hard-capped at ten minutes. A large build (a full plan
 * call plus a production build plus a repair or two) can legitimately need more than that, so a
 * step that self-stops with a valid partial workspace is checkpointed and handed back to the queue
 * to continue in the same sandbox — rather than being failed. This is bounded so a genuinely
 * unbounded task cannot resume forever, and it never runs past the money the task was approved for.
 *
 * Deliberately dependency-free: it is imported by both the Node-runtime dispatcher and the
 * plain-V8 Convex mutation that settles step outcomes.
 */

export const MAX_STEP_RESUMES = 5;

export type StepResumeDecision = { action: "resume" | "finalize"; reason: string };

export function decideStepResume(input: {
  /** Timed resumes this step has already taken, before this one. */
  resumes: number;
  /** Task spend after this checkpoint's own usage is settled. */
  spentRwf: number;
  /** Task reserved balance after this step's reservation is released. */
  reservedRwf: number;
  /** The task's approved ceiling. */
  maxRwf: number;
  /** A conservative reservation for one more attempt. */
  nextAttemptEstimateRwf: number;
  runCancelled: boolean;
}): StepResumeDecision {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === "number" && (!Number.isFinite(value) || value < 0)) throw new Error(`${name} must be a non-negative finite number`);
  }
  if (input.runCancelled) return { action: "finalize", reason: "the run was cancelled" };
  if (input.resumes >= MAX_STEP_RESUMES) {
    return { action: "finalize", reason: `stopped after ${MAX_STEP_RESUMES} timed resumes — the work is larger than one task can complete; narrow the objective or split it` };
  }
  if (input.spentRwf + input.reservedRwf + input.nextAttemptEstimateRwf > input.maxRwf) {
    return { action: "finalize", reason: "not enough budget remains for another attempt; re-run with a higher ceiling to continue" };
  }
  return { action: "resume", reason: `checkpointed with work still to do (resume ${input.resumes + 1}/${MAX_STEP_RESUMES})` };
}
