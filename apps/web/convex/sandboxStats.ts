import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { billingEfficiency, mean, quantile, runStatistics, usdForBilledMs, usdPerHour, DEFAULT_SHAPE } from "../lib/sandbox-metrics";

/**
 * The measured state of an organization's sandbox fleet, computed where the data already is.
 *
 * Every figure here is an aggregate over rows the browser would otherwise have to download to add
 * up itself: doing the arithmetic in the query keeps one round trip instead of hundreds of
 * documents, and it keeps the definitions (in ../lib/sandbox-metrics) identical to the ones the
 * panel uses for live provider samples.
 */

/**
 * How much history the aggregate covers. Bounded on purpose: a command center reports on current
 * operations, and an unbounded scan would grow slower for every workspace that has ever run a task.
 */
const TASK_WINDOW = 40;

export const forOrganization = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({
    runs: v.number(),
    activeRuns: v.number(),
    sandboxes: v.number(),
    billedMs: v.number(),
    reportedMs: v.number(),
    uptimeMs: v.number(),
    billingEfficiency: v.number(),
    usdSpent: v.number(),
    usdPerHourLive: v.number(),
    steps: v.object({
      total: v.number(),
      completed: v.number(),
      failed: v.number(),
      running: v.number(),
      meanStepMs: v.number(),
      p95StepMs: v.number(),
      throughputPerHour: v.number(),
      successRate: v.number(),
      retryRate: v.number(),
      progress: v.number(),
    }),
    meanRunMs: v.number(),
    p95RunMs: v.number(),
  }),
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const now = Date.now();
    const tasks = await ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").take(TASK_WINDOW);

    let runs = 0;
    let activeRuns = 0;
    let billedMs = 0;
    let reportedMs = 0;
    let uptimeMs = 0;
    const sandboxIds = new Set<string>();
    const runDurations: number[] = [];
    const steps: { status: string; attempts: number; claimedAt?: number; completedAt?: number }[] = [];
    // The window every throughput figure is measured over: the oldest run still in the sample.
    let earliestStart = now;

    for (const task of tasks) {
      for (const run of await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect()) {
        runs += 1;
        const started = run.startedAt ?? run.createdAt;
        earliestStart = Math.min(earliestStart, started);
        billedMs += run.sandboxMs ?? 0;
        reportedMs += run.sandboxReportedMs ?? 0;
        uptimeMs += Math.max(0, (run.completedAt ?? now) - started);
        if (run.completedAt !== undefined) runDurations.push(Math.max(0, run.completedAt - started));
        if (["queued", "running"].includes(run.status)) activeRuns += 1;
        if (run.sandboxId) sandboxIds.add(run.sandboxId);
        for (const step of await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).take(128)) {
          steps.push({ status: step.status, attempts: step.attempts, claimedAt: step.claimedAt, completedAt: step.completedAt });
        }
      }
    }

    return {
      runs,
      activeRuns,
      sandboxes: sandboxIds.size,
      billedMs,
      reportedMs,
      uptimeMs,
      billingEfficiency: billingEfficiency(billedMs, uptimeMs),
      usdSpent: usdForBilledMs(billedMs),
      // What the fleet costs while every active sandbox is executing — a ceiling on the current
      // burn rate, not a prediction: idle sandboxes in between steps are billed nothing.
      usdPerHourLive: activeRuns * usdPerHour({ cpuCount: DEFAULT_SHAPE.cpuCount, memGib: DEFAULT_SHAPE.memGib }),
      steps: runStatistics(steps, Math.max(1, now - earliestStart)),
      meanRunMs: mean(runDurations),
      p95RunMs: quantile(runDurations, 0.95),
    };
  },
});
