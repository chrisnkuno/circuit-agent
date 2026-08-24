import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/** Events that mean the sandbox started burning time, and events that mean it stopped. */
const STARTS_RUNNING = new Set(["sandbox.lifecycle.created", "sandbox.lifecycle.resumed"]);
const STOPS_RUNNING = new Set(["sandbox.lifecycle.paused", "sandbox.lifecycle.killed", "sandbox.lifecycle.checkpointed"]);

/**
 * Applies one verified E2B sandbox lifecycle delivery.
 *
 * Two jobs, both observational. Neither decides a step's fate: a kill is not evidence of failure,
 * because the worker stops its own sandbox in a `finally` *before* it records the step outcome, so
 * every healthy step emits a kill while its row still reads "running". Retrying on that signal
 * would re-run work that had already succeeded, while the original worker was still writing its
 * result. Failure stays with the worker's own verdict and lease recovery, which can tell the
 * difference.
 *
 * 1. Runtime accounting. A sandbox is billed only while running, which is exactly the interval
 *    between a create/resume and the next pause/kill. Measuring those intervals from the
 *    provider's own event stream gives a figure comparable with its dashboard, and it is the only
 *    way to see the cost of work that is otherwise invisible — suspended sandboxes are free, so
 *    total runtime is far smaller than elapsed run time and cannot be inferred from either.
 * 2. Truthfulness of what the UI claims. A sandbox that is gone stops being shown as live
 *    immediately, instead of lingering until its lease lapses.
 */
export const applySandboxLifecycleEvent = internalMutation({
  args: {
    deliveryId: v.string(),
    eventId: v.string(),
    eventType: v.string(),
    sandboxId: v.string(),
    terminated: v.boolean(),
    /** When the provider says it happened, which is authoritative over when we received it. */
    occurredAt: v.number(),
    reportedExecutionMs: v.optional(v.number()),
  },
  returns: v.object({ status: v.union(v.literal("applied"), v.literal("duplicate"), v.literal("unknown_sandbox")) }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_provider_delivery", (q) => q.eq("provider", "e2b").eq("deliveryId", args.deliveryId))
      .first();
    // Retries are routine (three attempts, ten seconds apart), and counting one twice would
    // inflate the runtime figure this exists to make trustworthy.
    if (existing) return { status: "duplicate" as const };
    await ctx.db.insert("webhookDeliveries", {
      provider: "e2b",
      deliveryId: args.deliveryId,
      eventType: args.eventType,
      sandboxId: args.sandboxId,
      reportedExecutionMs: args.reportedExecutionMs,
      receivedAt: Date.now(),
    });

    // The payload names a sandbox; it never names a step, run, or organization. Resolving it
    // against a sandbox id this system recorded itself is what keeps a forged or replayed
    // delivery from touching anything — the signature scheme alone is not strong enough to rely on.
    const run = await ctx.db.query("agentRuns").withIndex("by_sandbox", (q) => q.eq("sandboxId", args.sandboxId)).first();
    if (!run) return { status: "unknown_sandbox" as const };

    if (STARTS_RUNNING.has(args.eventType)) {
      // Never overwrite an open interval: a duplicate start would move the clock forward and
      // silently discard the time already accrued.
      if (run.sandboxRunningSince === undefined) await ctx.db.patch(run._id, { sandboxRunningSince: args.occurredAt });
    } else if (STOPS_RUNNING.has(args.eventType)) {
      const since = run.sandboxRunningSince;
      const elapsed = since === undefined ? 0 : Math.max(0, args.occurredAt - since);
      await ctx.db.patch(run._id, {
        sandboxMs: (run.sandboxMs ?? 0) + elapsed,
        sandboxReportedMs: (run.sandboxReportedMs ?? 0) + (args.reportedExecutionMs ?? 0),
        sandboxRunningSince: undefined,
      });
    }

    if (args.terminated) {
      const step = await ctx.db.query("agentSteps").withIndex("by_sandbox", (q) => q.eq("sandboxId", args.sandboxId)).first();
      if (step) await ctx.db.patch(step._id, { sandboxId: undefined });
      await ctx.db.insert("agentRunEvents", {
        runId: run._id,
        type: "sandbox_terminated",
        message: "The execution sandbox has stopped.",
        createdAt: Date.now(),
      });
    }
    return { status: "applied" as const };
  },
});
