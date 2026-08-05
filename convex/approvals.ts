import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

export const listPending = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "approval:decide");
    const pending = await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", "pending")).collect();
    const tasks = new Map();
    for (const approval of pending) {
      const task = await ctx.db.get(approval.taskId);
      if (task?.organizationId === organizationId) tasks.set(approval._id, approval);
    }
    return Array.from(tasks.values());
  },
});

export const decide = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("approved"), v.literal("rejected")) },
  handler: async (ctx, { approvalId, decision }) => {
    const approval = await ctx.db.get(approvalId);
    if (!approval || approval.status !== "pending") throw new Error("Pending approval not found");
    const task = await ctx.db.get(approval.taskId);
    if (!task) throw new Error("Task not found");
    const { identity } = await requireOrganizationPermission(ctx, task.organizationId, "approval:decide");
    const now = Date.now();
    await ctx.db.patch(approvalId, { status: decision, decidedAt: now, decidedBy: identity.subject });
    if (decision === "approved" && approval.kind === "budget_overage" && approval.requestedRwf && approval.requestedRwf > task.maxRwf) {
      await ctx.db.patch(task._id, { maxRwf: approval.requestedRwf });
      await ctx.db.insert("taskEvents", { taskId: task._id, type: "budget_cap_approved", message: "A new total RWF task cap was approved. Payment authorization must be expanded before execution.", createdAt: now });
    }
    if (approval.stepId) await ctx.db.patch(approval.stepId, { approvalStatus: decision, status: decision === "approved" ? "pending" : "cancelled" });
    if (approval.runId) await ctx.db.patch(approval.runId, { status: decision === "approved" ? "queued" : "blocked" });
    if (approval.actionIntentId) await ctx.db.patch(approval.actionIntentId, { status: decision === "approved" ? "approved" : "cancelled", updatedAt: now });
    if (decision === "rejected") {
      await ctx.db.patch(task._id, { status: "blocked" });
      await ctx.db.insert("taskEvents", { taskId: task._id, type: "approval_rejected", message: "A required agent action was rejected.", createdAt: now });
    }
  },
});
