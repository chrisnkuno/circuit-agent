"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { createE2BProvider } from "@circuit-nova/nova-core/providers/factory";

/**
 * Destroys one sandbox. Scheduled by whichever transition ended the run that owned it.
 *
 * Best-effort on purpose: the run has already reached its truthful terminal state, and a provider
 * that is briefly unreachable must not undo that. Anything missed here is caught by the reaper
 * below, which is the backstop for every path that never gets to schedule this at all — a worker
 * killed mid-step, a deploy during a run, a lost lease.
 */
export const destroySandbox = internalAction({
  args: { sandboxId: v.string(), runId: v.optional(v.id("agentRuns")) },
  returns: v.object({ destroyed: v.boolean() }),
  handler: async (_ctx, args): Promise<{ destroyed: boolean }> => {
    const sandbox = createE2BProvider(process.env as Record<string, string | undefined>);
    if (!sandbox) return { destroyed: false };
    try {
      await sandbox.stopSandbox(args.sandboxId);
      return { destroyed: true };
    } catch {
      return { destroyed: false };
    }
  },
});

/**
 * Reaps sandboxes that outlived the run they belong to.
 *
 * A suspended sandbox is kept by the provider indefinitely, and a sandbox whose timeout expires is
 * suspended rather than destroyed — so anything the normal path fails to release stays forever.
 * This asks the provider what actually exists, keeps only sandboxes this system created (its own
 * metadata), and destroys the ones whose run is no longer live. The provider's own record is the
 * authority here: a sandbox missing from the database is exactly the case worth catching.
 */
export const reapAbandonedSandboxes = internalAction({
  args: { olderThanMinutes: v.optional(v.number()) },
  returns: v.object({ inspected: v.number(), destroyed: v.number() }),
  handler: async (ctx, args): Promise<{ inspected: number; destroyed: number }> => {
    const sandbox = createE2BProvider(process.env as Record<string, string | undefined>);
    if (!sandbox || !sandbox.listOwnedSandboxes) return { inspected: 0, destroyed: 0 };
    // Old enough that no in-flight step could still be using it: a claim lease is three minutes.
    const minimumAgeMs = Math.max(5, args.olderThanMinutes ?? 15) * 60_000;
    const cutoff = Date.now() - minimumAgeMs;

    const owned = await sandbox.listOwnedSandboxes();
    let destroyed = 0;
    for (const candidate of owned) {
      if (candidate.startedAtMs > cutoff) continue;
      const live: boolean = await ctx.runQuery(internal.sandboxCleanupModel.isSandboxLive, { sandboxId: candidate.sandboxId });
      if (live) continue;
      try {
        await sandbox.stopSandbox(candidate.sandboxId);
        destroyed += 1;
      } catch {
        // Next tick will try again; a sandbox that cannot be reached is not costing anything.
      }
    }
    return { inspected: owned.length, destroyed };
  },
});
