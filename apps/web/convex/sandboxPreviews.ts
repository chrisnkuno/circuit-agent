"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { api } from "./_generated/api";
import { Sandbox } from "e2b";


const WORKSPACE = "/workspace/repo";

/**
 * Polls the sandbox's own port 3000 until something answers.
 *
 * Checked from inside the sandbox rather than over the public host, so a slow edge or a cold DNS
 * entry cannot be mistaken for an application that never came up. Any HTTP status counts as ready
 * — a 404 still proves a server is listening, and which page exists is the app's business.
 */
async function waitForPort(sandbox: Sandbox): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const probe = await sandbox.commands
      .run("curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000", { timeoutMs: 8_000 })
      .catch(() => null);
    if (probe && /^[1-5]\d\d$/.test(probe.stdout.trim()) && probe.stdout.trim() !== "000") return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

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
    // A build sandbox only outlives its run by a few minutes, so "connect failed" is overwhelmingly
    // "you clicked Preview after it shut down" — a normal thing to do, not a fault. Raw E2B text
    // ("sandbox was not found") reads like a bug in the product, so say what happened and what
    // actually gets a preview back.
    const sandbox: Sandbox = await Sandbox.connect(detail.run.sandboxId, { apiKey, timeoutMs: 10 * 60_000 })
      .catch(() => {
        throw new Error("This sandbox has already shut down — sandboxes stay up for a few minutes after a build. Run the task again to get a fresh one to preview.");
      });

    // Not every build leaves a Node project behind. A plain workspace produces static files, and
    // `npm run dev` there exits instantly, leaving nothing on port 3000 — the iframe then shows a
    // bare 502, which reads as "the preview is broken" rather than "this output is static".
    const hasNodeProject = await sandbox.files.exists(`${WORKSPACE}/package.json`).catch(() => false);
    const command = hasNodeProject
      ? "npm run dev -- --hostname 0.0.0.0 --port 3000"
      : "python3 -m http.server 3000 --bind 0.0.0.0";
    await sandbox.commands.run(command, { cwd: WORKSPACE, background: true, timeoutMs: 20_000 });

    // Returning the URL the instant the process is spawned hands the browser a URL that is not
    // listening yet: a dev server needs seconds to compile, and the iframe renders that race as a
    // 502 the user has no way to retry except by guessing. Wait for the port to actually answer.
    await waitForPort(sandbox);
    return { url: `https://${sandbox.getHost(3000)}`, expiresAt: Date.now() + 10 * 60_000 };
  },
});
