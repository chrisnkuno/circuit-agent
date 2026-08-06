"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { startCodingRun } from "./codingRunPlan";

/**
 * The terminal's one real entry point. Every downstream mutation still runs its own real
 * authorization check against the caller's identity — this action adds no privilege of its
 * own, it only picks which mutation variant startCodingRun uses.
 */
export const startLiveCodingRun = action({
  args: { organizationId: v.id("organizations"), objective: v.string(), idempotencyKey: v.string() },
  returns: v.object({ taskId: v.id("tasks"), runId: v.id("agentRuns") }),
  handler: async (ctx, args): Promise<{ taskId: Id<"tasks">; runId: Id<"agentRuns"> }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return startCodingRun(ctx, { organizationId: args.organizationId, objective: args.objective, idempotencyKey: args.idempotencyKey, authorization: "session" });
  },
});

/** Lets the terminal trigger an immediate dispatch tick (e.g. right after an approval) instead of waiting for the cron. */
export const nudgeDispatch = action({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    await ctx.runAction(internal.dispatcher.dispatchTick, {});
    return null;
  },
});
