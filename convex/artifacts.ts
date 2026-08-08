import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";
import { isWanderObjective } from "../packages/agent-core/src/wander";

const MAX_LISTED_ARTIFACTS = 200;
/** Keep in sync with lib/wander-report.ts — do not import that module here (Node crypto). */
const WANDER_REPORT_PATH = "wander/REPORT.html";

/**
 * Everything a task produced, ready to read.
 *
 * Scoped by task rather than by run so a person sees the work, not the plumbing: a task's files are
 * what they asked for, and which run or step wrote them is detail. Each row carries a short-lived
 * URL for its stored content — the bytes are served by Convex storage rather than inlined here, so
 * listing a task with large files stays cheap and the panel fetches only what someone opens.
 *
 * Rows written before content was persisted have no `url`; they are still listed, because silently
 * hiding evidence that exists but cannot be read would misrepresent what a run produced.
 */
export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:read");

    const stored = await ctx.db.query("agentArtifacts").withIndex("by_task", (q) => q.eq("taskId", taskId)).take(MAX_LISTED_ARTIFACTS);
    // Steps of one run share a workspace, so every step captures every file — four steps means
    // four copies of the same `main.py`. Only the newest version of each path is the result; the
    // rest are intermediate states of a file that still exists, not separate work.
    const newestByPath = new Map<string, (typeof stored)[number]>();
    const artifacts = [];
    for (const artifact of stored) {
      if (artifact.kind !== "workspace_file" || !artifact.path) {
        artifacts.push(artifact);
        continue;
      }
      const existing = newestByPath.get(artifact.path);
      if (!existing || artifact.createdAt > existing.createdAt) newestByPath.set(artifact.path, artifact);
    }
    artifacts.push(...newestByPath.values());
    // Resolved per distinct step, not per artifact: a step writes several artifacts, and a task can
    // span more than one run, so keying off any single run would mislabel the rest.
    const stepIds = [...new Set(artifacts.map((artifact) => artifact.stepId))];
    const steps = new Map(
      (await Promise.all(stepIds.map((stepId) => ctx.db.get(stepId))))
        .filter((step): step is NonNullable<typeof step> => step !== null)
        .map((step) => [step._id, step]),
    );

    return Promise.all(
      artifacts.map(async (artifact) => ({
        id: artifact._id,
        kind: artifact.kind,
        path: artifact.path ?? null,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        stepTitle: steps.get(artifact.stepId)?.title ?? null,
        createdAt: artifact.createdAt,
        url: artifact.storageId ? await ctx.storage.getUrl(artifact.storageId) : null,
      })),
    );
  },
});

/**
 * Harvestable Wander report for a finished lab run. Available only when the run completed and
 * the worker assembled wander/REPORT.html — never while research is still in flight.
 */
export const getWanderHarvest = query({
  args: { runId: v.id("agentRuns") },
  returns: v.object({
    available: v.boolean(),
    url: v.union(v.string(), v.null()),
    filename: v.union(v.string(), v.null()),
    topic: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, { runId }) => {
    const unavailable = { available: false, url: null, filename: null, topic: null };
    const run = await ctx.db.get(runId);
    if (!run || run.status !== "completed" || !isWanderObjective(run.objective)) return unavailable;
    const task = await ctx.db.get(run.taskId);
    if (!task) return unavailable;
    await requireOrganizationPermission(ctx, task.organizationId, "task:read");

    const stored = await ctx.db.query("agentArtifacts").withIndex("by_run", (q) => q.eq("runId", runId)).take(MAX_LISTED_ARTIFACTS);
    const report = stored
      .filter((artifact) => artifact.kind === "workspace_file" && artifact.path === WANDER_REPORT_PATH && artifact.storageId)
      .sort((left, right) => right.createdAt - left.createdAt)[0];
    if (!report?.storageId) return unavailable;

    const topicMatch = run.objective.match(/\[Wander\]\s+Topic:\s*(.+?)\.\s+/i);
    const topic = topicMatch?.[1]?.trim() || "Wander research";
    const slug = topic
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "report";
    return {
      available: true,
      url: await ctx.storage.getUrl(report.storageId),
      filename: `wander-report-${slug}.html`,
      topic,
    };
  },
});
