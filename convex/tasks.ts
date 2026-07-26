import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { quoteReplayMatches, validateQuotedTaskContract } from "../lib/task-contract";
import { requireOrganizationPermission } from "./lib/authz";

const taskKind = v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations"));
const quality = v.union(v.literal("fast"), v.literal("balanced"), v.literal("expert"));

export const createQuotedTask = mutation({
  args: {
    organizationId: v.id("organizations"),
    title: v.string(), kind: taskKind, quality,
    estimateLowRwf: v.int64(), estimateHighRwf: v.int64(), maxRwf: v.int64(),
    confidence: v.union(v.literal("high"), v.literal("medium"), v.literal("low")),
    assumptions: v.array(v.string()), idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "task:create");
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
    const taskId = await ctx.db.insert("tasks", { organizationId: args.organizationId, title: args.title, kind: args.kind, quality: args.quality, maxRwf: args.maxRwf, spentRwf: 0n, reservedRwf: 0n, status: "awaiting_approval", createdAt: now });
    await ctx.db.insert("taskQuotes", { taskId, version: 1, estimateLowRwf: args.estimateLowRwf, estimateHighRwf: args.estimateHighRwf, maxRwf: args.maxRwf, confidence: args.confidence, assumptions: args.assumptions, estimatorVersion: "rules-v1", createdAt: now });
    await ctx.db.insert("paymentHolds", { taskId, amountRwf: args.maxRwf, provider: "circuit_pay", status: "pending", idempotencyKey: scopedIdempotencyKey, createdAt: now });
    await ctx.db.insert("taskEvents", { taskId, type: "quote_created", message: "Task quote created. Payment authorization is required before execution.", createdAt: now });
    return taskId;
  },
});

export const listRecent = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").take(20);
  },
});
