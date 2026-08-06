import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { nextCronOccurrence } from "../lib/schedule";

/**
 * A parallel claim path scoped to the "coding-task" template, deliberately not merged into
 * googleCalendarModel.ts's claimDueSchedules/completeScheduleRun: those are proven and
 * deployed for the calendar digest, and this stays isolated so nothing here can regress that
 * path. Both share the same generic agentSchedules/connectorScheduleRuns tables.
 */
export const claimDueCodingSchedules = internalMutation({
  args: { now: v.number(), workerId: v.string(), leaseMs: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.leaseMs) || args.leaseMs < 30_000 || args.leaseMs > 10 * 60_000) throw new Error("Schedule lease must be between 30 seconds and 10 minutes");
    if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 20) throw new Error("Schedule claim limit must be between 1 and 20");
    const expired = await ctx.db.query("connectorScheduleRuns").withIndex("by_status_lease", (q) => q.eq("status", "claimed").lte("leaseExpiresAt", args.now)).take(args.limit);
    for (const run of expired) await ctx.db.patch(run._id, { status: "failed", summary: "Schedule worker lease expired before completion.", completedAt: args.now });

    const due = await ctx.db.query("agentSchedules").withIndex("by_status_next_run", (q) => q.eq("status", "active").lte("nextRunAt", args.now)).take(args.limit);
    const claims: Array<{ runId: import("./_generated/dataModel").Id<"connectorScheduleRuns">; organizationId: import("./_generated/dataModel").Id<"organizations">; objective: string }> = [];
    for (const schedule of due) {
      if (schedule.nextRunAt === undefined || schedule.workflowTemplate !== "coding-task" || !schedule.objective) continue;
      const dueAt = schedule.nextRunAt;
      const idempotencyKey = `${schedule._id}:${dueAt}`;
      const replay = await ctx.db.query("connectorScheduleRuns").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", idempotencyKey)).unique();
      const nextRunAt = nextCronOccurrence(schedule.cronExpression, schedule.timezone, dueAt);
      if (replay) {
        await ctx.db.patch(schedule._id, { nextRunAt, updatedAt: args.now });
        continue;
      }
      const runId = await ctx.db.insert("connectorScheduleRuns", { organizationId: schedule.organizationId, scheduleId: schedule._id, dueAt, idempotencyKey, status: "claimed", claimedBy: args.workerId, leaseExpiresAt: args.now + args.leaseMs, attempts: 1, createdAt: args.now });
      await ctx.db.patch(schedule._id, { claimedBy: args.workerId, claimExpiresAt: args.now + args.leaseMs, nextRunAt, updatedAt: args.now });
      claims.push({ runId, organizationId: schedule.organizationId, objective: schedule.objective });
    }
    return claims;
  },
});

export const completeCodingScheduleRun = internalMutation({
  args: { runId: v.id("connectorScheduleRuns"), workerId: v.string(), status: v.union(v.literal("completed"), v.literal("failed")), summary: v.string() },
  handler: async (ctx, args) => {
    const run = await ctx.db.get(args.runId);
    if (!run || run.status !== "claimed" || run.claimedBy !== args.workerId || run.leaseExpiresAt <= Date.now()) throw new Error("Schedule worker does not own an active claim");
    const schedule = await ctx.db.get(run.scheduleId);
    const now = Date.now();
    await ctx.db.patch(run._id, { status: args.status, summary: args.summary, completedAt: now });
    if (schedule) await ctx.db.patch(schedule._id, { claimedBy: undefined, claimExpiresAt: undefined, lastRunAt: now, updatedAt: now });
    await ctx.db.insert("connectorEvents", { organizationId: run.organizationId, type: `coding_schedule_${args.status}`, message: args.summary, createdAt: now });
  },
});
