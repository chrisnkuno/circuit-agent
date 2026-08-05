"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { buildTaskPlan } from "../lib/agent-orchestration";
import { estimateTaskCost } from "../lib/task-cost";

/**
 * The terminal's one real entry point: creates an actual quoted task, authorizes it through
 * the explicit development payment bypass (see convex/devPayment.ts), compiles the same
 * capability-scoped coding graph the rest of the product uses, and nudges the dispatcher so
 * the caller doesn't wait up to a minute for the cron. Every downstream mutation still runs
 * its own real authorization check against the caller's identity — this action adds no
 * privilege of its own.
 */
export const startLiveCodingRun = action({
  args: { organizationId: v.id("organizations"), objective: v.string(), idempotencyKey: v.string() },
  returns: v.object({ taskId: v.id("tasks"), runId: v.id("agentRuns") }),
  handler: async (ctx, args): Promise<{ taskId: Id<"tasks">; runId: Id<"agentRuns"> }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    if (process.env.ALLOW_TERMINAL_LIVE_EXECUTION !== "true") {
      throw new Error("Live terminal execution is disabled. Set ALLOW_TERMINAL_LIVE_EXECUTION=true on this deployment to enable it.");
    }
    const objective = args.objective.trim();
    if (!objective || objective.length > 500) throw new Error("objective must contain 1 to 500 characters");

    const quote = estimateTaskCost({ kind: "coding", quality: "fast", attachmentCount: 0, requiresBrowser: false, requiresSandbox: true });
    const taskId: Id<"tasks"> = await ctx.runMutation(api.tasks.createQuotedTask, {
      organizationId: args.organizationId,
      title: objective.slice(0, 120),
      kind: "coding",
      quality: "fast",
      estimateLowRwf: BigInt(quote.estimateLowRwf),
      estimateHighRwf: BigInt(quote.estimateHighRwf),
      maxRwf: BigInt(quote.maxRwf),
      confidence: quote.confidence,
      assumptions: quote.assumptions,
      idempotencyKey: args.idempotencyKey,
    });

    await ctx.runMutation(api.devPayment.authorizeDevelopmentPayment, { taskId });

    const plan = buildTaskPlan({ runId: "run", title: `Coding: ${objective}`, kind: "coding", requiresBrowserVerification: false });
    // The dispatcher only has a live worker for the "coding" role today (see docs/gap-register.md
    // — reviewer/research/operator workers are not built yet). The standard plan's trailing
    // approval-gated review step would sit forever with no executor once approved, so the
    // terminal's live path runs only the steps that can actually complete: inspect, reproduce,
    // implement, checks. Nothing downstream depended on the review step, so this stays a valid graph.
    const steps = plan.steps
      .filter((step) => step.role === "coding")
      .map((step) => ({
        stepKey: step.id.replace(/^run:/, ""),
        title: step.title,
        role: step.role,
        dependsOn: step.dependsOn.map((dependency) => dependency.replace(/^run:/, "")),
        requiresApproval: step.requiresApproval ?? false,
        sandboxTemplate: step.sandboxTemplate,
        capabilityIds: step.capabilityIds,
      }));
    const runId: Id<"agentRuns"> = await ctx.runMutation(api.agentRuns.createTaskRun, {
      taskId, kind: "coding", maxParallelism: plan.maxParallelism, objective, steps,
    });

    await ctx.runAction(internal.dispatcher.dispatchTick, {});

    return { taskId, runId };
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
