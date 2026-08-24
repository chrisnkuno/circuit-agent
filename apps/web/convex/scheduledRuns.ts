"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { startCodingRun } from "./codingRunPlan";
import { expandWanderObjective } from "@circuit-nova/nova-core/wander";

/** Ticked by cron: claims every due "coding-task" schedule and starts one real run per occurrence. */
export const runDueCodingSchedules = internalAction({
  args: {},
  returns: v.object({ claimed: v.number(), completed: v.number(), failed: v.number() }),
  handler: async (ctx): Promise<{ claimed: number; completed: number; failed: number }> => {
    const workerId = `coding_schedule_${crypto.randomUUID()}`;
    const claims: Array<{ runId: any; organizationId: any; objective: string }> = await ctx.runMutation(internal.scheduledRunsModel.claimDueCodingSchedules, { now: Date.now(), workerId, leaseMs: 180_000, limit: 5 });
    let completed = 0;
    let failed = 0;
    for (const claim of claims) {
      try {
        // Wander daily/weekly schedules store a random-topic marker; expand it per occurrence so
        // each tick discovers something new instead of repeating one frozen objective forever.
        const objective = expandWanderObjective(claim.objective, `${claim.runId}`);
        const result = await startCodingRun(ctx, { organizationId: claim.organizationId, objective, idempotencyKey: `${claim.runId}`, authorization: "trusted-organization", costApproval: "pre-authorized" });
        await ctx.runMutation(internal.scheduledRunsModel.completeCodingScheduleRun, { runId: claim.runId, workerId, status: "completed", summary: `Started task ${result.taskId} for "${objective}".` });
        completed += 1;
      } catch (error) {
        await ctx.runMutation(internal.scheduledRunsModel.completeCodingScheduleRun, { runId: claim.runId, workerId, status: "failed", summary: error instanceof Error ? error.message.slice(0, 500) : "Scheduled coding run failed to start" });
        failed += 1;
      }
    }
    return { claimed: claims.length, completed, failed };
  },
});
