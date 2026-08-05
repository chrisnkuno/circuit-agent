import { v } from "convex/values";
import { mutation } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

/**
 * Authorizes a task's payment hold without a real Circuit Pay transaction. This exists so
 * an authenticated organization owner can exercise the real dispatcher/worker pipeline end
 * to end before Circuit Pay's real API contract is verified (see docs/gap-register.md). It
 * is disabled unless ALLOW_DEV_PAYMENT_BYPASS=true is set on the deployment, requires the
 * same billing:manage permission a real authorization would, and can only ever touch a hold
 * that already belongs to the caller's own organization.
 */
export const authorizeDevelopmentPayment = mutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    if (process.env.ALLOW_DEV_PAYMENT_BYPASS !== "true") {
      throw new Error("Development payment bypass is disabled. Set ALLOW_DEV_PAYMENT_BYPASS=true on this deployment to enable it.");
    }
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "billing:manage");
    const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", taskId)).order("desc").first();
    if (!hold) throw new Error("No payment hold found for task");
    if (hold.status === "authorized") return;
    if (hold.status !== "pending") throw new Error(`Payment hold cannot be authorized from status ${hold.status}`);
    await ctx.db.patch(hold._id, { status: "authorized", providerReference: `dev-bypass-${Date.now()}` });
  },
});
