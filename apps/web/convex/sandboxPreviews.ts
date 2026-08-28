"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { Sandbox } from "e2b";

export const start = action({
  args: { runId: v.id("agentRuns") },
  returns: v.object({ url: v.string(), expiresAt: v.number() }),
  handler: async (ctx, { runId }): Promise<{ url: string; expiresAt: number }> => {
    // This authenticated query is the authorization boundary: an action never receives an
    // arbitrary sandbox id from the browser.
    const detail: { run: { sandboxId?: string } } = await ctx.runQuery(api.agentRuns.getRunDetail, { runId });
    if (!detail.run.sandboxId) throw new Error("This run has no resumable sandbox.");
    const apiKey = process.env.E2B_API_KEY?.trim();
    if (!apiKey) throw new Error("E2B preview is not configured on this deployment.");
    const sandbox: Sandbox = await Sandbox.connect(detail.run.sandboxId, { apiKey, timeoutMs: 10 * 60_000 });
    await sandbox.commands.run("npm run dev -- --hostname 0.0.0.0 --port 3000", {
      cwd: "/workspace/repo",
      background: true,
      timeoutMs: 20_000,
    });
    return { url: `https://${sandbox.getHost(3000)}`, expiresAt: Date.now() + 10 * 60_000 };
  },
});
