import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** Read the fields needed to prefetch (or skip) Wander evidence for a run. */
export const getRunEvidenceState = internalQuery({
  args: { runId: v.id("agentRuns") },
  returns: v.union(
    v.null(),
    v.object({
      objective: v.string(),
      researchBrief: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    return { objective: run.objective, researchBrief: run.researchBrief ?? null };
  },
});

export const getCachedEvidence = internalQuery({
  args: { topicHash: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      briefMarkdown: v.string(),
      fetchedAt: v.number(),
      sourceCount: v.number(),
      query: v.string(),
      exaRequestId: v.union(v.string(), v.null()),
    }),
  ),
  handler: async (ctx, { topicHash }) => {
    const row = await ctx.db
      .query("wanderEvidenceCache")
      .withIndex("by_topic_hash", (q) => q.eq("topicHash", topicHash))
      .unique();
    if (!row) return null;
    return {
      briefMarkdown: row.briefMarkdown,
      fetchedAt: row.fetchedAt,
      sourceCount: row.sourceCount,
      query: row.query,
      exaRequestId: row.exaRequestId ?? null,
    };
  },
});

export const upsertCachedEvidence = internalMutation({
  args: {
    topicHash: v.string(),
    topic: v.string(),
    query: v.string(),
    briefMarkdown: v.string(),
    sourceCount: v.number(),
    exaRequestId: v.optional(v.string()),
    fetchedAt: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("wanderEvidenceCache")
      .withIndex("by_topic_hash", (q) => q.eq("topicHash", args.topicHash))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        topic: args.topic,
        query: args.query,
        briefMarkdown: args.briefMarkdown,
        sourceCount: args.sourceCount,
        exaRequestId: args.exaRequestId,
        fetchedAt: args.fetchedAt,
      });
    } else {
      await ctx.db.insert("wanderEvidenceCache", args);
    }
    return null;
  },
});

export const attachResearchBrief = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    researchBrief: v.string(),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { runId, researchBrief, message }) => {
    const run = await ctx.db.get(runId);
    if (!run) return null;
    // Idempotent: the first writer wins so concurrent prefetchers cannot overwrite a finished brief.
    if (run.researchBrief?.trim()) return null;
    await ctx.db.patch(runId, { researchBrief });
    await ctx.db.insert("agentRunEvents", {
      runId,
      type: "wander_evidence_ready",
      message,
      createdAt: Date.now(),
    });
    return null;
  },
});
