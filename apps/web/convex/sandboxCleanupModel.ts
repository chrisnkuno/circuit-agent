import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

/**
 * Whether a sandbox still belongs to a run that could legitimately be using it.
 *
 * Deliberately conservative: anything the database still associates with a non-terminal run is
 * live, so the reaper never destroys a workspace out from under a step that is merely slow.
 */
export const isSandboxLive = internalQuery({
  args: { sandboxId: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { sandboxId }) => {
    const run = await ctx.db.query("agentRuns").withIndex("by_sandbox", (q) => q.eq("sandboxId", sandboxId)).first();
    if (!run) return false;
    return !["completed", "failed", "cancelled"].includes(run.status);
  },
});
