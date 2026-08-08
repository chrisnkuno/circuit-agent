"use node";

import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { createExaClient } from "../packages/agent-core/src/providers/exa";
import {
  extractWanderTopic,
  gatherWanderEvidence,
  wanderTopicHash,
} from "../lib/wander-research";
import { isWanderObjective } from "../packages/agent-core/src/wander";

/**
 * Prefetch Exa evidence once for a Wander run. Safe to call repeatedly: returns the stored brief,
 * serves the topic cache (0 Exa calls), or performs exactly one search and persists both the run
 * brief and the topic cache. Never invoked from a model tool loop.
 */
export const prefetchForRun = internalAction({
  args: { runId: v.id("agentRuns") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, { runId }): Promise<string | null> => {
    const nudgeDispatch = async (): Promise<void> => {
      try {
        await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
      } catch {
        // Cron still picks the run up.
      }
    };

    const state: { objective: string; researchBrief: string | null } | null = await ctx.runQuery(
      internal.wanderEvidence.getRunEvidenceState,
      { runId },
    );
    if (!state || !isWanderObjective(state.objective)) return null;
    if (state.researchBrief?.trim()) {
      await nudgeDispatch();
      return state.researchBrief;
    }

    const topic = extractWanderTopic(state.objective);
    if (!topic) {
      await nudgeDispatch();
      return null;
    }

    const topicHash = wanderTopicHash(topic);
    const cached: {
      briefMarkdown: string;
      fetchedAt: number;
      sourceCount: number;
      query: string;
      exaRequestId: string | null;
    } | null = await ctx.runQuery(internal.wanderEvidence.getCachedEvidence, { topicHash });
    const client = createExaClient(process.env as { EXA_API_KEY?: string });
    if (!client) {
      await ctx.runMutation(internal.wanderEvidence.attachResearchBrief, {
        runId,
        researchBrief: [
          "# Literature briefing (Wander lab)",
          "",
          `Role: Literature scout`,
          `Topic: ${topic}`,
          "",
          "_EXA_API_KEY is not configured on this deployment. No live sources were fetched._",
          "_The lab proceeds with careful prior knowledge only; keep claims mostly speculative; never invent citations._",
          "",
        ].join("\n"),
        message: "Wander literature briefing skipped — EXA_API_KEY is not configured.",
      });
    } else {
      try {
        const dossier = await gatherWanderEvidence({ topic, client, cached });
        if (dossier.exaCalls > 0) {
          await ctx.runMutation(internal.wanderEvidence.upsertCachedEvidence, {
            topicHash,
            topic: dossier.topic,
            query: dossier.query,
            briefMarkdown: dossier.briefMarkdown,
            sourceCount: dossier.sourceCount,
            exaRequestId: dossier.exaRequestId ?? undefined,
            fetchedAt: dossier.fetchedAt,
          });
        }
        const message =
          dossier.exaCalls === 0
            ? `Wander literature reused from topic cache (${dossier.sourceCount} sources, 0 Exa calls).`
            : `Wander literature scouted once via Exa (${dossier.sourceCount} sources, 1 search).`;
        await ctx.runMutation(internal.wanderEvidence.attachResearchBrief, {
          runId,
          researchBrief: dossier.briefMarkdown,
          message,
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : "unknown error";
        await ctx.runMutation(internal.wanderEvidence.attachResearchBrief, {
          runId,
          researchBrief: [
            "# Literature briefing (Wander lab)",
            "",
            `Role: Literature scout`,
            `Topic: ${topic}`,
            "",
            `_Exa prefetch failed: ${detail.slice(0, 240)}_`,
            "_The lab proceeds with careful prior knowledge only; keep claims mostly speculative; never invent citations._",
            "",
          ].join("\n"),
          message: `Wander literature prefetch failed: ${detail.slice(0, 180)}`,
        });
      }
    }

    const refreshed: { objective: string; researchBrief: string | null } | null = await ctx.runQuery(
      internal.wanderEvidence.getRunEvidenceState,
      { runId },
    );
    // Nudge dispatch after evidence is durable so Wander steps are not claimed under-reserved
    // (prompt size includes the dossier) and so quote-approval does not race an empty brief.
    await nudgeDispatch();
    return refreshed?.researchBrief ?? null;
  },
});
