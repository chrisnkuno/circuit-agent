import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

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
        // A run that has been approved but has no sandbox id yet is provisioning, and it belongs
        // here: skipping it left the panel saying "no sandboxes running" for the half-minute E2B
        // takes to hand one back, which is exactly when a person is watching hardest.
        if (!run.sandboxId && !["queued", "running"].includes(run.status)) continue;
        const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).take(64);
        const running = steps.find((step) => step.status === "running");
        live.push({
          runId: run._id,
          taskId: task._id,
          sandboxId: run.sandboxId ?? "",
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
