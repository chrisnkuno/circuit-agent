import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { formatRwf } from "../lib/task-cost";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";

/**
 * Pending approvals for one organization, each carried with the context a person needs to
 * decide it — the bare approval row names only ids, which is not enough to answer "approve
 * what?" in any surface that shows it.
 */
export const listPending = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "approval:decide");
    const pending = await ctx.db.query("approvals").withIndex("by_status", (q) => q.eq("status", "pending")).collect();
    const decorated = [];
    for (const approval of pending) {
      const task = await ctx.db.get(approval.taskId);
      if (task?.organizationId !== organizationId) continue;
      const [run, step, quote] = await Promise.all([
        approval.runId ? ctx.db.get(approval.runId) : null,
        approval.stepId ? ctx.db.get(approval.stepId) : null,
        // A cost gate has to show the price range it is gating, not just the cap.
        approval.kind === "task_start" ? ctx.db.query("taskQuotes").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first() : null,
      ]);
      decorated.push({
        ...approval,
        taskTitle: task.title,
        runObjective: run?.objective ?? null,
        stepTitle: step?.title ?? null,
        estimateLowRwf: quote?.estimateLowRwf ?? null,
        estimateHighRwf: quote?.estimateHighRwf ?? null,
      });
    }
    return decorated;
  },
});

/**
 * Records the cost gate for a freshly quoted run. Internal because the only legitimate caller is
 * the run-creation path that just wrote the task and its quote (convex/codingRunPlan.ts) — a
 * client cannot invent an approval for work that was never priced.
 */
export const requestTaskStartApproval = internalMutation({
  args: { taskId: v.id("tasks"), runId: v.id("agentRuns"), requestedRwf: v.int64() },
  returns: v.id("approvals"),
  handler: async (ctx, { taskId, runId, requestedRwf }) => {
    const now = Date.now();
    // Held out of the dispatch snapshot entirely rather than left queued: a queued run gets
    // claimed, bounces off the unauthorized payment hold, and logs a payment warning that
    // duplicates the quote the person is already looking at.
    await ctx.db.patch(runId, { status: "awaiting_approval" });
    await ctx.db.insert("agentRunEvents", { runId, type: "quote_pending", message: `Quoted at up to ${formatRwf(Number(requestedRwf))}. Nothing runs until the quote is accepted.`, createdAt: now });
    return ctx.db.insert("approvals", { taskId, runId, kind: "task_start", status: "pending", requestedRwf, requestedAt: now });
  },
});

/**
 * Commits the money for an accepted quote. This is the moment a person's "yes, that price is
 * fine" becomes an authorized hold — before it, the task is priced but nothing can be spent.
 */
async function authorizeAcceptedQuote(ctx: MutationCtx, task: Doc<"tasks">, now: number): Promise<void> {
  const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first();
  if (!hold || hold.status === "authorized") return;
  // Same honesty as an approved overage: Circuit Pay's real authorization contract is not
  // verified yet (docs/gap-register.md), so outside the development bypass the hold stays
  // pending and the run stays blocked rather than pretending money was reserved.
  if (process.env.ALLOW_DEV_PAYMENT_BYPASS === "true") {
    await ctx.db.patch(hold._id, { status: "authorized", providerReference: `dev-bypass-${now}` });
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "quote_accepted", message: `The quote was accepted and a hold of ${formatRwf(Number(hold.amountRwf))} was authorized.`, createdAt: now });
  } else {
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "payment_authorization_required", message: "The quote was accepted. Execution waits for a Circuit Pay authorization covering the task cap.", createdAt: now });
  }
}

/**
 * Raises the task cap an approved overage asked for, and keeps the payment hold consistent
 * with it. Without this the run deadlocks: claimStep refuses to dispatch while the authorized
 * hold is smaller than the cap, so a cap raised on its own leaves the run blocked behind a
 * payment gate that has no approval record left to decide.
 */
async function applyApprovedOverage(ctx: MutationCtx, task: Doc<"tasks">, requestedRwf: bigint, now: number): Promise<void> {
  await ctx.db.patch(task._id, { maxRwf: requestedRwf });
  await ctx.db.insert("taskEvents", { taskId: task._id, type: "budget_cap_approved", message: `A new total task cap of ${formatRwf(Number(requestedRwf))} was approved.`, createdAt: now });
  const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first();
  if (!hold) return;
  // Circuit Pay's real re-authorization contract is not verified yet (see docs/gap-register.md).
  // With the development bypass on, the expanded hold is authorized directly so the pipeline can
  // be exercised end to end; without it the hold returns to pending and execution stays blocked
  // until a real authorization covers the new cap — never silently authorized.
  if (process.env.ALLOW_DEV_PAYMENT_BYPASS === "true") {
    await ctx.db.patch(hold._id, { amountRwf: requestedRwf, status: "authorized", providerReference: `dev-bypass-${now}` });
  } else {
    await ctx.db.patch(hold._id, { amountRwf: requestedRwf, status: "pending" });
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "payment_authorization_required", message: "The approved cap needs a Circuit Pay authorization covering the new amount before execution resumes.", createdAt: now });
  }
}

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
    if (decision === "approved" && approval.kind === "task_start") {
      await authorizeAcceptedQuote(ctx, task, now);
    }
    if (decision === "approved" && approval.kind === "budget_overage" && approval.requestedRwf && approval.requestedRwf > task.maxRwf) {
      await applyApprovedOverage(ctx, task, approval.requestedRwf, now);
    }
    // A declined quote is not a failure to investigate — the work simply never started, so the
    // task is cancelled rather than blocked. Every other rejection stops work that was already
    // under way, which is a blocked task someone may want to look at.
    const declinedQuote = decision === "rejected" && approval.kind === "task_start";
    if (approval.stepId) await ctx.db.patch(approval.stepId, { approvalStatus: decision, status: decision === "approved" ? "pending" : "cancelled" });
    if (approval.runId) await ctx.db.patch(approval.runId, { status: decision === "approved" ? "queued" : declinedQuote ? "cancelled" : "blocked", ...(declinedQuote ? { completedAt: now } : {}) });
    if (approval.actionIntentId) await ctx.db.patch(approval.actionIntentId, { status: decision === "approved" ? "approved" : "cancelled", updatedAt: now });
    if (decision === "rejected") {
      await ctx.db.patch(task._id, { status: declinedQuote ? "cancelled" : "blocked" });
      await ctx.db.insert("taskEvents", {
        taskId: task._id,
        type: declinedQuote ? "quote_declined" : "approval_rejected",
        message: declinedQuote ? "The quote was declined before any work started. Nothing was spent." : "A required agent action was rejected.",
        createdAt: now,
      });
    }
    if (decision === "approved" && approval.runId) {
      // A queued run otherwise waits for the next cron tick; an approval is a person waiting
      // in front of the terminal, so pick the work up immediately instead.
      await ctx.db.insert("agentRunEvents", { runId: approval.runId, type: "approval_granted", message: `${approval.kind.replaceAll("_", " ")} approved. The run returns to the dispatch queue.`, createdAt: now });
      await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
    }
  },
});
