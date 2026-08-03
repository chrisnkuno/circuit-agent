import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { CodingWorkerControl } from "../../lib/coding-worker";

/** Bridges the worker's heartbeat/cancellation checkpoints to the lease-owning Convex mutations. */
export function createWorkerControl(ctx: ActionCtx, params: { runId: Id<"agentRuns">; workerId: string; leaseMs: number }): CodingWorkerControl {
  return {
    async heartbeat(stepId: string): Promise<void> {
      await ctx.runMutation(internal.agentRuns.heartbeatStep, {
        runId: params.runId,
        stepId: stepId as Id<"agentSteps">,
        workerId: params.workerId,
        leaseMs: params.leaseMs,
      });
    },
    async isCancellationRequested(runId: string): Promise<boolean> {
      return ctx.runQuery(internal.agentRuns.isRunCancelled, { runId: runId as Id<"agentRuns"> });
    },
  };
}
