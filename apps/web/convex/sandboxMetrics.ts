"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { Sandbox } from "e2b";
import type { Id } from "./_generated/dataModel";

/**
 * The most recent CPU, memory, and disk sample E2B has for a run's sandbox.
 *
 * E2B collects metrics every five seconds and returns an empty array until the first sample
 * exists, so a null result means "not measured yet", never "idle".
 * https://docs.e2b.dev/sandbox/metrics
 */
export const latest = action({
  args: { runId: v.id("agentRuns") },
  returns: v.union(v.null(), v.object({
    timestamp: v.number(),
    cpuUsedPct: v.number(),
    cpuCount: v.number(),
    memUsed: v.number(),
    memTotal: v.number(),
    diskUsed: v.number(),
    diskTotal: v.number(),
  })),
  handler: async (ctx, { runId }) => {
    // The permission-checked query is the authorization boundary: a sandbox id never arrives
    // from the browser.
    const detail: { run: { sandboxId?: string; status: string } } = await ctx.runQuery(api.agentRuns.getRunDetail, { runId });
    const sandboxId = detail.run.sandboxId;
    const apiKey = process.env.E2B_API_KEY?.trim();
    if (!sandboxId || !apiKey) return null;
    try {
      const samples = await Sandbox.getMetrics(sandboxId, { apiKey });
      const sample = samples.at(-1);
      if (!sample) return null;
      return {
        timestamp: new Date(sample.timestamp).getTime(),
        cpuUsedPct: sample.cpuUsedPct,
        cpuCount: sample.cpuCount,
        memUsed: Number(sample.memUsed),
        memTotal: Number(sample.memTotal),
        diskUsed: Number(sample.diskUsed),
        diskTotal: Number(sample.diskTotal),
      };
    } catch {
      // A paused, expired, or already-destroyed sandbox has no metrics. That is a normal state,
      // not an error worth failing the panel over.
      return null;
    }
  },
});
