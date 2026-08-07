import { v } from "convex/values";
import { query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

const MAX_LISTED_ARTIFACTS = 200;

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
