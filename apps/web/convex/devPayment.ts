import { v } from "convex/values";
import { internalMutation, mutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOrganizationPermission } from "./lib/authz";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

async function authorize(ctx: MutationCtx, taskId: Id<"tasks">): Promise<void> {
  const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", taskId)).order("desc").first();
  if (!hold) throw new Error("No payment hold found for task");
  if (hold.status === "authorized") return;
  if (hold.status !== "pending") throw new Error(`Payment hold cannot be authorized from status ${hold.status}`);
  await ctx.db.patch(hold._id, { status: "authorized", providerReference: `execution-budget-${Date.now()}` });
}

/**
 * Authorizes a task's internal execution budget. The row retains its historical name for schema
 * compatibility, but this workflow does not contact or wait for Circuit Pay.
 */
export const authorizeDevelopmentPayment = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "billing:manage");
    await authorize(ctx, taskId);
  },
});

/** Internal-only: same budget authorization, reached through an already-verified channel link. */
export const authorizeDevelopmentPaymentInternal = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => authorize(ctx, taskId),
});

/**
 * One-shot repair for runs approved while the obsolete external-payment gate was active.
 * Pending user approvals are deliberately untouched: only a previously approved task_start may
 * be returned to the dispatch queue.
 */
export const releaseApprovedPaymentBlockedRuns = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ repaired: v.number(), examined: v.number() }),
  handler: async (ctx, { limit }) => {
    const batch = Math.min(Math.max(limit ?? 100, 1), 500);
    const holds = await ctx.db.query("paymentHolds").filter((q) => q.eq(q.field("status"), "pending")).take(batch);
    let repaired = 0;
    for (const hold of holds) {
      const approvals = await ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", hold.taskId)).collect();
      const acceptedStart = approvals.find((approval) => approval.kind === "task_start" && approval.status === "approved" && approval.runId);
      if (!acceptedStart?.runId) continue;
      const run = await ctx.db.get(acceptedStart.runId);
      if (!run || run.status !== "awaiting_approval") continue;
      const now = Date.now();
      await ctx.db.patch(hold._id, { status: "authorized", providerReference: `execution-budget-${now}` });
      await ctx.db.patch(run._id, { status: "queued" });
      await ctx.db.insert("agentRunEvents", {
        runId: run._id,
        type: "execution_budget_repaired",
        message: "The obsolete payment gate was removed. This approved run returned to the dispatch queue.",
        createdAt: now,
      });
      repaired += 1;
    }
    if (repaired > 0) await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
    return { repaired, examined: holds.length };
  },
});
