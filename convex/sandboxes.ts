import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

/**
 * Total sandbox runtime for an organization, the figure to compare against the provider's own
 * dashboard. Counted only while a sandbox was actually running — suspended sandboxes are free and
 * are not billed — so this is deliberately far smaller than the elapsed wall time of the runs that
 * produced it, and neither number can be inferred from the other.
 */
export const usageForOrganization = query({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ sandboxMs: v.number(), reportedMs: v.number(), runs: v.number(), estimatedUsd: v.number() }),
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const tasks = await ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).take(100);
    let sandboxMs = 0;
    let reportedMs = 0;
    let runs = 0;
    for (const task of tasks) {
      for (const run of await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect()) {
        if (!run.sandboxMs && !run.sandboxReportedMs) continue;
        sandboxMs += run.sandboxMs ?? 0;
        reportedMs += run.sandboxReportedMs ?? 0;
        runs += 1;
      }
    }
    // The provider's published rate for the default 2 vCPU / 512 MiB shape: vCPU at $0.000014 per
    // second and RAM at $0.0000045 per GiB-second. Shown so a number of seconds means something.
    const seconds = sandboxMs / 1_000;
    const estimatedUsd = seconds * (2 * 0.000014 + 0.5 * 0.0000045);
    return { sandboxMs, reportedMs, runs, estimatedUsd };
  },
});

/**
 * The sandboxes an organization currently owns, read from this system's own records rather than
 * from the provider.
 *
 * Deliberately not a provider listing: the E2B account is shared with other projects, and a panel
 * that offered a kill button for every sandbox on the account would let one project destroy
 * another's work. What a person can see and act on here is exactly what their own runs created.
 */
export const listForOrganization = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const tasks = await ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").take(20);
    const live = [];
    for (const task of tasks) {
      if (["completed", "cancelled"].includes(task.status)) continue;
      const runs = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
      for (const run of runs) {
        if (!run.sandboxId) continue;
        const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).take(64);
        const running = steps.find((step) => step.status === "running");
        live.push({
          runId: run._id,
          taskId: task._id,
          sandboxId: run.sandboxId,
          taskTitle: task.title,
          runStatus: run.status,
          workspacePresetId: run.workspacePresetId ?? null,
          // Suspended between steps is the normal resting state, not an anomaly: a sandbox is only
          // executing while a step actually holds it.
          activeStepTitle: running?.title ?? null,
          heartbeatAt: running?.heartbeatAt ?? null,
          sandboxMs: run.sandboxMs ?? 0,
          startedAt: run.startedAt ?? run.createdAt,
        });
      }
    }
    return live;
  },
});
