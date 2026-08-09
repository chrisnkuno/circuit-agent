import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { formatRwf } from "../lib/task-cost";
import { isWanderObjective } from "../packages/agent-core/src/wander";
import { internal } from "./_generated/api";
import { approvedRunEffect, type PaymentAuthorization } from "../lib/approval-decision";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

/** More than this waiting at once is a queue to triage elsewhere, not a terminal dock to render. */
const MAX_PENDING_APPROVALS = 50;

type NewApproval = {
  taskId: Id<"tasks">;
  kind: Doc<"approvals">["kind"];
  runId?: Id<"agentRuns">;
  stepId?: Id<"agentSteps">;
  actionIntentId?: Id<"connectorActionIntents">;
  requestedRwf?: bigint;
};

/**
 * The only way to raise an approval. Every approval must carry the organization that owns it or
 * it is invisible to the tenant-scoped index that lists it — an approval nobody can see is a run
 * stopped forever. Deriving that from the task here means a new approval kind cannot forget it;
 * the first version of this change did exactly that at one of five call sites, and the gate went
 * silently undecidable.
 */
export async function createApproval(ctx: MutationCtx, approval: NewApproval): Promise<Id<"approvals">> {
  const task = await ctx.db.get(approval.taskId);
  if (!task) throw new Error("Task not found");
  return ctx.db.insert("approvals", { ...approval, organizationId: task.organizationId, status: "pending", requestedAt: Date.now() });
}

/**
 * Pending approvals for one organization, each carried with the context a person needs to
 * decide it — the bare approval row names only ids, which is not enough to answer "approve
 * what?" in any surface that shows it.
 */
export const listPending = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "approval:decide");
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_organization_status", (q) => q.eq("organizationId", organizationId).eq("status", "pending"))
      .take(MAX_PENDING_APPROVALS);
    const decorated = [];
    for (const approval of pending) {
      const task = await ctx.db.get(approval.taskId);
      // The index is denormalized, so the owning task stays the authority on tenancy.
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
 * One-shot backfill for approvals written before `organizationId` existed on the row. The
 * by_organization_status index cannot see them, so without this they would be invisible to the
 * organization that owns them. Idempotent and bounded: run it until it reports 0 remaining.
 */
export const backfillApprovalOrganizations = internalMutation({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ patched: v.number(), remaining: v.number() }),
  handler: async (ctx, { limit }) => {
    const batch = Math.min(Math.max(limit ?? 200, 1), 500);
    const candidates = await ctx.db
      .query("approvals")
      .withIndex("by_organization_status", (q) => q.eq("organizationId", undefined))
      .take(batch + 1);
    let patched = 0;
    for (const approval of candidates.slice(0, batch)) {
      const task = await ctx.db.get(approval.taskId);
      if (!task) continue;
      await ctx.db.patch(approval._id, { organizationId: task.organizationId });
      patched += 1;
    }
    return { patched, remaining: candidates.length > batch ? 1 : 0 };
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
    return createApproval(ctx, { taskId, runId, kind: "task_start", requestedRwf });
  },
});

/**
 * Commits the money for an accepted quote. This is the moment a person's "yes, that price is
 * fine" becomes an authorized hold — before it, the task is priced but nothing can be spent.
 */
async function authorizeAcceptedQuote(ctx: MutationCtx, task: Doc<"tasks">, now: number): Promise<PaymentAuthorization> {
  const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first();
  if (!hold) throw new Error("No payment hold found for this task");
  if (hold.status === "authorized" || hold.status === "captured") return "authorized";
  if (hold.status !== "pending") throw new Error(`Payment hold cannot be authorized from status ${hold.status}`);
  // Same honesty as an approved overage: Circuit Pay's real authorization contract is not
  // verified yet (docs/gap-register.md), so outside the development bypass the hold stays
  // pending and the run stays blocked rather than pretending money was reserved.
  if (process.env.ALLOW_DEV_PAYMENT_BYPASS === "true") {
    await ctx.db.patch(hold._id, { status: "authorized", providerReference: `dev-bypass-${now}` });
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "quote_accepted", message: `The quote was accepted and a hold of ${formatRwf(Number(hold.amountRwf))} was authorized.`, createdAt: now });
    return "authorized";
  } else {
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "payment_authorization_required", message: "The quote was accepted. Execution waits for a Circuit Pay authorization covering the task cap.", createdAt: now });
    return "payment_authorization_required";
  }
}

/**
 * Raises the task cap an approved overage asked for, and keeps the payment hold consistent
 * with it. Without this the run deadlocks: claimStep refuses to dispatch while the authorized
 * hold is smaller than the cap, so a cap raised on its own leaves the run blocked behind a
 * payment gate that has no approval record left to decide.
 */
async function applyApprovedOverage(ctx: MutationCtx, task: Doc<"tasks">, requestedRwf: bigint, now: number): Promise<PaymentAuthorization> {
  const hold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first();
  if (!hold) throw new Error("No payment hold found for this task");
  await ctx.db.patch(task._id, { maxRwf: requestedRwf });
  await ctx.db.insert("taskEvents", { taskId: task._id, type: "budget_cap_approved", message: `A new total task cap of ${formatRwf(Number(requestedRwf))} was approved.`, createdAt: now });
  // Circuit Pay's real re-authorization contract is not verified yet (see docs/gap-register.md).
  // With the development bypass on, the expanded hold is authorized directly so the pipeline can
  // be exercised end to end; without it the hold returns to pending and execution stays blocked
  // until a real authorization covers the new cap — never silently authorized.
  if (process.env.ALLOW_DEV_PAYMENT_BYPASS === "true") {
    await ctx.db.patch(hold._id, { amountRwf: requestedRwf, status: "authorized", providerReference: `dev-bypass-${now}` });
    return "authorized";
  } else {
    await ctx.db.patch(hold._id, { amountRwf: requestedRwf, status: "pending" });
    await ctx.db.insert("taskEvents", { taskId: task._id, type: "payment_authorization_required", message: "The approved cap needs a Circuit Pay authorization covering the new amount before execution resumes.", createdAt: now });
    return "payment_authorization_required";
  }
}

export const decide = mutation({
  args: { approvalId: v.id("approvals"), decision: v.union(v.literal("approved"), v.literal("rejected")) },
  returns: v.object({ outcome: v.union(v.literal("started"), v.literal("approved"), v.literal("rejected"), v.literal("payment_authorization_required")) }),
  handler: async (ctx, { approvalId, decision }) => {
    const approval = await ctx.db.get(approvalId);
    if (!approval || approval.status !== "pending") throw new Error("Pending approval not found");
    const task = await ctx.db.get(approval.taskId);
    if (!task) throw new Error("Task not found");
    // Cancellation withdraws pending approvals, but a client that was already showing one can
    // still submit it. Approving here would authorize money against a task nobody expects to
    // run, so a terminal task refuses the decision outright rather than trusting the caller's view.
    if (["completed", "cancelled"].includes(task.status)) throw new Error("This task is no longer active");
    const { identity } = await requireOrganizationPermission(ctx, task.organizationId, "approval:decide");
    const now = Date.now();
    let paymentAuthorization: PaymentAuthorization = "authorized";
    if (decision === "approved" && approval.kind === "task_start") {
      paymentAuthorization = await authorizeAcceptedQuote(ctx, task, now);
    }
    if (decision === "approved" && approval.kind === "budget_overage" && approval.requestedRwf && approval.requestedRwf > task.maxRwf) {
      paymentAuthorization = await applyApprovedOverage(ctx, task, approval.requestedRwf, now);
    }
    await ctx.db.patch(approvalId, { status: decision, decidedAt: now, decidedBy: identity.subject });
    // A declined quote is not a failure to investigate — the work simply never started, so the
    // task is cancelled rather than blocked. Every other rejection stops work that was already
    // under way, which is a blocked task someone may want to look at.
    const declinedQuote = decision === "rejected" && approval.kind === "task_start";
    const runEffect = approvedRunEffect(paymentAuthorization);
    if (approval.stepId) await ctx.db.patch(approval.stepId, { approvalStatus: decision, status: decision === "approved" ? "pending" : "cancelled" });
    if (approval.runId) await ctx.db.patch(approval.runId, {
      status: decision === "approved"
        ? runEffect.runStatus
        : declinedQuote ? "cancelled" : "blocked",
      ...(declinedQuote ? { completedAt: now } : {}),
    });
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
    if (decision === "approved" && approval.runId && runEffect.shouldDispatch) {
      // A queued run otherwise waits for the next cron tick; an approval is a person waiting
      // in front of the terminal, so pick the work up immediately instead.
      await ctx.db.insert("agentRunEvents", { runId: approval.runId, type: "approval_granted", message: `${approval.kind.replaceAll("_", " ")} approved. The run returns to the dispatch queue.`, createdAt: now });
      // Quote acceptance is the first moment a terminal Wander run may spend Exa. Prefetch
      // chains its own dispatch nudge so we do not race an empty literature brief.
      if (approval.kind === "task_start") {
        const run = await ctx.db.get(approval.runId);
        if (run && isWanderObjective(run.objective)) {
          await ctx.scheduler.runAfter(0, internal.wanderEvidenceActions.prefetchForRun, { runId: approval.runId });
        } else {
          await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
        }
      } else {
        await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
      }
    }
    if (decision === "approved" && approval.runId && paymentAuthorization === "payment_authorization_required") {
      await ctx.db.insert("agentRunEvents", {
        runId: approval.runId,
        type: "payment_authorization_required",
        message: "Spending was approved, but execution remains stopped until an authorized payment hold covers the cap.",
        createdAt: now,
      });
    }
    return {
      outcome: decision === "rejected"
        ? "rejected" as const
        : approval.runId ? runEffect.outcome : "approved" as const,
    };
  },
});
