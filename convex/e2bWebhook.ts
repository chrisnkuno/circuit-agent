import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Applies one verified E2B sandbox lifecycle delivery.
 *
 * Deliberately observational: it records what happened to the sandbox and stops. It does **not**
 * decide the step's fate, because a kill is not evidence of failure. The worker stops its own
 * sandbox in a `finally` block *before* it records the step outcome, so a normal, successful step
 * always emits `sandbox.lifecycle.killed` while its step row is still "running". Retrying on that
 * signal would re-run work that had already succeeded, and would do it while the original worker
 * was still writing its result.
 *
 * What it does fix is a real blind spot: a sandbox that dies without its lease lapsing used to
 * leave the task list showing a live sandbox for up to the full lease. Clearing the recorded
 * sandbox id makes that honest immediately. Failure itself stays with the two mechanisms that can
 * actually distinguish it — the worker's own outcome, and lease recovery.
 */
export const applySandboxLifecycleEvent = internalMutation({
  args: {
    deliveryId: v.string(),
    eventId: v.string(),
    eventType: v.string(),
    sandboxId: v.string(),
    terminated: v.boolean(),
  },
  returns: v.object({ status: v.union(v.literal("applied"), v.literal("duplicate"), v.literal("unknown_sandbox")) }),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_provider_delivery", (q) => q.eq("provider", "e2b").eq("deliveryId", args.deliveryId))
      .first();
    if (existing) return { status: "duplicate" as const };
    await ctx.db.insert("webhookDeliveries", { provider: "e2b", deliveryId: args.deliveryId, eventType: args.eventType, receivedAt: Date.now() });

    // The payload names a sandbox; it never names a step, run, or organization. Resolving it
    // against a sandbox id this system recorded itself is what keeps a forged or replayed
    // delivery from touching anything — the signature scheme alone is not strong enough to rely on.
    const step = await ctx.db.query("agentSteps").withIndex("by_sandbox", (q) => q.eq("sandboxId", args.sandboxId)).first();
    if (!step) return { status: "unknown_sandbox" as const };

    if (args.terminated) {
      await ctx.db.patch(step._id, { sandboxId: undefined });
      await ctx.db.insert("agentRunEvents", {
        runId: step.runId,
        type: "sandbox_terminated",
        message: `The execution sandbox for ${step.title} has stopped.`,
        createdAt: Date.now(),
      });
    }
    return { status: "applied" as const };
  },
});
