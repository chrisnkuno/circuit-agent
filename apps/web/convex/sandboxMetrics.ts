"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { Sandbox } from "e2b";

/**
 * Live CPU, memory, and disk for an organization's sandboxes.
 *
 * E2B collects metrics every five seconds and returns an empty array until the first sample
 * exists, so a missing entry means "not measured yet", never "idle".
 * https://docs.e2b.dev/sandbox/metrics
 */

const sample = v.object({
  sandboxId: v.string(),
  timestamp: v.number(),
  cpuUsedPct: v.number(),
  cpuCount: v.number(),
  memUsed: v.number(),
  memTotal: v.number(),
  diskUsed: v.number(),
  diskTotal: v.number(),
});

type Sample = {
  sandboxId: string;
  timestamp: number;
  cpuUsedPct: number;
  cpuCount: number;
  memUsed: number;
  memTotal: number;
  diskUsed: number;
  diskTotal: number;
};

async function latestFor(sandboxId: string, apiKey: string): Promise<Sample | null> {
  try {
    const samples = await Sandbox.getMetrics(sandboxId, { apiKey });
    const newest = samples.at(-1);
    if (!newest) return null;
    return {
      sandboxId,
      timestamp: new Date(newest.timestamp).getTime(),
      cpuUsedPct: newest.cpuUsedPct,
      cpuCount: newest.cpuCount,
      memUsed: Number(newest.memUsed),
      memTotal: Number(newest.memTotal),
      diskUsed: Number(newest.diskUsed),
      diskTotal: Number(newest.diskTotal),
    };
  } catch {
    // A paused, expired, or already-destroyed sandbox has no metrics. That is a normal state,
    // not an error worth failing the panel over.
    return null;
  }
}

/**
 * Every live sandbox in one call.
 *
 * The command center shows a whole fleet, and one action per sandbox per tick would multiply
 * both round trips and provider requests by the number of machines running. The permission-checked
 * query is the authorization boundary: sandbox ids are read from the caller's own records and
 * never accepted from the browser.
 */
export const fleet = action({
  args: { organizationId: v.id("organizations") },
  returns: v.array(sample),
  handler: async (ctx, { organizationId }) => {
    const apiKey = process.env.E2B_API_KEY?.trim();
    if (!apiKey) return [];
    const live: { sandboxId: string }[] = await ctx.runQuery(api.sandboxes.listForOrganization, { organizationId });
    const ids = [...new Set(live.map((entry) => entry.sandboxId))];
    const samples = await Promise.all(ids.map((id) => latestFor(id, apiKey)));
    return samples.filter((entry): entry is Sample => entry !== null);
  },
});
