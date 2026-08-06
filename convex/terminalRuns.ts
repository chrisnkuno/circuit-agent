"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { startCodingRun, type StartCodingRunResult } from "./codingRunPlan";

/**
 * The terminal's one real entry point. Every downstream mutation still runs its own real
 * authorization check against the caller's identity — this action adds no privilege of its
 * own, it only picks which mutation variant startCodingRun uses.
 */
export const startLiveCodingRun = action({
  args: { organizationId: v.id("organizations"), objective: v.string(), idempotencyKey: v.string() },
  returns: v.object({
    taskId: v.id("tasks"),
    runId: v.id("agentRuns"),
    quote: v.object({
      estimateLowRwf: v.number(),
      estimateHighRwf: v.number(),
      maxRwf: v.number(),
      confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
      assumptions: v.array(v.string()),
    }),
    awaitingCostApproval: v.boolean(),
  }),
  // Quotes the work and stops there: a person types a command, sees what it will cost, and
  // decides. Nothing is charged and no worker starts until they accept the price.
  handler: async (ctx, args): Promise<StartCodingRunResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    return startCodingRun(ctx, { organizationId: args.organizationId, objective: args.objective, idempotencyKey: args.idempotencyKey, authorization: "session", costApproval: "required" });
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
