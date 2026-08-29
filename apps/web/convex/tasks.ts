import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import { quoteReplayMatches, validateQuotedTaskContract } from "../lib/task-contract";
import { requireOrganizationPermission } from "./lib/authz";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const taskKind = v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations"));
const quality = v.union(v.literal("fast"), v.literal("balanced"), v.literal("expert"));

const quotedTaskArgs = {
  organizationId: v.id("organizations"),
  title: v.string(), kind: taskKind, quality,
  estimateLowRwf: v.int64(), estimateHighRwf: v.int64(), maxRwf: v.int64(),
  confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
  assumptions: v.array(v.string()), idempotencyKey: v.string(),
  expectedOutput: v.optional(v.string()),
};

type QuotedTaskArgs = {
  organizationId: Id<"organizations">;
  title: string; kind: "coding" | "research" | "writing" | "operations"; quality: "fast" | "balanced" | "expert";
  estimateLowRwf: bigint; estimateHighRwf: bigint; maxRwf: bigint;
  confidence: "high" | "medium" | "low"; assumptions: string[]; idempotencyKey: string;
  expectedOutput?: string;
};

/**
 * Shared insert logic behind both the authenticated public mutation and the internal,
 * channel-authorized variant — the only difference between callers is how they establish the
 * right to act on `organizationId`, never what gets written once they have.
 */
export async function insertQuotedTask(ctx: MutationCtx, args: QuotedTaskArgs): Promise<Id<"tasks">> {
  validateQuotedTaskContract(args);
  const now = Date.now();
  const scopedIdempotencyKey = `${args.organizationId}:${args.idempotencyKey}`;
  const existingHold = await ctx.db.query("paymentHolds").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", scopedIdempotencyKey)).first();
  if (existingHold) {
    const [existingTask, existingQuote] = await Promise.all([
      ctx.db.get(existingHold.taskId),
      ctx.db.query("taskQuotes").withIndex("by_task", (q) => q.eq("taskId", existingHold.taskId)).order("desc").first(),
    ]);
    if (!existingTask || !existingQuote || !quoteReplayMatches(args, {
      title: existingTask.title,
      kind: existingTask.kind,
      quality: existingTask.quality,
      estimateLowRwf: existingQuote.estimateLowRwf,
      estimateHighRwf: existingQuote.estimateHighRwf,
      maxRwf: existingQuote.maxRwf,
    })) {
      throw new Error("Idempotency key was already used with a different quote payload");
    }
    return existingHold.taskId;
  }
  const taskId = await ctx.db.insert("tasks", { organizationId: args.organizationId, title: args.title, kind: args.kind, quality: args.quality, maxRwf: args.maxRwf, spentRwf: 0n, reservedRwf: 0n, expectedOutput: args.expectedOutput, status: "awaiting_approval", createdAt: now });
  await ctx.db.insert("taskQuotes", { taskId, version: 1, estimateLowRwf: args.estimateLowRwf, estimateHighRwf: args.estimateHighRwf, maxRwf: args.maxRwf, confidence: args.confidence, assumptions: args.assumptions, estimatorVersion: "rules-v1", createdAt: now });
  // The product currently uses RWF as an execution budget, not as a Circuit Pay checkout.
  // Keep the existing hold row as the idempotent budget reservation record, but authorize it
  // locally so a requested task cannot deadlock behind a payment provider that is not part of
  // this workflow. Approval policy and the task cap still decide whether work may start.
  await ctx.db.insert("paymentHolds", {
    taskId,
    amountRwf: args.maxRwf,
    provider: "circuit_pay",
    providerReference: `execution-budget-${now}`,
    status: "authorized",
    idempotencyKey: scopedIdempotencyKey,
    createdAt: now,
  });
  await ctx.db.insert("taskEvents", { taskId, type: "quote_created", message: "Task quote created with an internal execution budget. No payment authorization is required.", createdAt: now });
  return taskId;
}

export const createQuotedTask = mutation({
  args: quotedTaskArgs,
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "task:create");
    return insertQuotedTask(ctx, args);
  },
});

/** Internal-only: the organizationId is trusted because the caller already resolved it from a verified channel link (see convex/channels.ts) — there is no better-auth session to check here. */
export const createQuotedTaskInternal = internalMutation({
  args: quotedTaskArgs,
  handler: async (ctx, args) => insertQuotedTask(ctx, args),
});

/**
 * Recent tasks, each carrying the live execution state of its running step when it has one:
 * which step is in flight, the real E2B sandbox the worker reported on its last heartbeat, and
 * when that heartbeat was. Without this the task list can only repeat a stored status, which
 * says "running" just as confidently for a healthy worker as for one whose lease is about to
 * lapse.
 *
 * The per-task lookups are deliberately restricted to tasks whose status is actually "running"
 * — normally none or one — so a list that is mostly history stays a single indexed read.
 */
export const listRecent = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const tasks = await ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").take(20);
    return Promise.all(tasks.map(async (task) => {
      if (task.status !== "running") return { ...task, execution: null };
      const runs = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
      const activeRun = runs.find((run) => run.status === "running" || run.status === "queued");
      if (!activeRun) return { ...task, execution: null };
      const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", activeRun._id)).take(64);
      const runningStep = steps.find((step) => step.status === "running");
      return {
        ...task,
        execution: {
          runId: activeRun._id,
          completedSteps: steps.filter((step) => step.status === "completed").length,
          totalSteps: steps.length,
          stepTitle: runningStep?.title ?? null,
          // Recorded by the worker's own heartbeat, so it reflects a sandbox that answered
          // recently rather than one Convex merely believes should exist.
          sandboxId: runningStep?.sandboxId ?? null,
          heartbeatAt: runningStep?.heartbeatAt ?? null,
          leaseExpiresAt: runningStep?.leaseExpiresAt ?? null,
        },
      };
    }));
  },
});
