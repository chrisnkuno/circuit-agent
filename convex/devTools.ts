import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * TEST-ONLY: marks a task's latest payment hold as authorized without any real Circuit
 * Pay transaction. Circuit Pay activation itself remains unimplemented (see docs/gap-register.md);
 * this exists solely to exercise the dispatcher/worker pipeline end-to-end in development,
 * and is internal-only so no client UI can reach it.
 */
export const devAuthorizePaymentHold = internalMutation({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", taskId)).order("desc").first();
    if (!hold) throw new Error("No payment hold found for task");
    await ctx.db.patch(hold._id, { status: "authorized", providerReference: "dev-test-authorization" });
  },
});
