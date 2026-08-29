import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import type { CodingWorkerControl } from "../../lib/coding-worker";

/** Bridges the worker's heartbeat/cancellation checkpoints to the lease-owning Convex mutations. */
export function createWorkerControl(ctx: ActionCtx, params: { runId: Id<"agentRuns">; workerId: string; leaseMs: number }): CodingWorkerControl {
  return {
    async heartbeat(stepId: string, sandboxId?: string): Promise<void> {
      await ctx.runMutation(internal.agentRuns.heartbeatStep, {
        runId: params.runId,
        stepId: stepId as Id<"agentSteps">,
        workerId: params.workerId,
        sandboxId,
        leaseMs: params.leaseMs,
      });
    },
    async reportPhase(stepId: string, phase: "planning" | "building", detail?: { planBytes?: number }): Promise<void> {
      // Rides the same lease-owning mutation as heartbeat: reporting progress during a long plan
      // call also keeps the lease warm, which it otherwise would not be until the first command.
      await ctx.runMutation(internal.agentRuns.heartbeatStep, {
        runId: params.runId,
        stepId: stepId as Id<"agentSteps">,
        workerId: params.workerId,
        leaseMs: params.leaseMs,
        phase,
        planBytes: detail?.planBytes,
      });
    },
    async reportActivity(stepId: string, type: string, message: string): Promise<void> {
      await ctx.runMutation(internal.agentRuns.recordWorkerActivity, {
        runId: params.runId,
        stepId: stepId as Id<"agentSteps">,
        workerId: params.workerId,
        type,
        message,
      });
    },
    async isCancellationRequested(runId: string): Promise<boolean> {
      return ctx.runQuery(internal.agentRuns.isRunCancelled, { runId: runId as Id<"agentRuns"> });
    },
  };
}
