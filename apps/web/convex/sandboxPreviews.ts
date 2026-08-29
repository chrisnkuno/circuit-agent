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
/** One probe of the sandbox's own port 3000. Any HTTP status means a server is listening. */
async function portAnswers(sandbox: Sandbox): Promise<boolean> {
  const probe = await sandbox.commands
    .run("curl -s -o /dev/null -w '%{http_code}' --max-time 3 http://127.0.0.1:3000", { timeoutMs: 8_000 })
    .catch(() => null);
  const code = probe?.stdout.trim() ?? "";
  return /^[1-5]\d\d$/.test(code) && code !== "000";
}

async function waitForPort(sandbox: Sandbox): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (await portAnswers(sandbox)) return;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
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

    // A sandbox can still be reachable while its workspace is gone: a run that failed before it
    // wrote anything, or one whose sandbox has been recycled and re-provisioned bare. Every path
    // below runs a command with `cwd` set to the workspace, and E2B rejects the call outright when
    // that directory does not exist — so check once, here, and say what actually happened.
    const workspaceReady = await sandbox.files.exists(WORKSPACE).catch(() => false);
    if (!workspaceReady) {
      throw new Error("This run has no built workspace to preview — it may not have produced files, or the sandbox has been recycled. Run the task again for a fresh preview.");
    }

    // A previous preview of this same run often left its server up, and resuming a sandbox does
    // not kill it. Re-spawning would collide on port 3000 and, worse, make the person wait through
    // a second cold start for a server that is already answering. Probe first; skip everything
    // below when something already responds.
    if (!(await portAnswers(sandbox))) {
      // Not every build leaves a Node project behind. A plain workspace produces static files, and
      // `npm run dev` there exits instantly, leaving nothing on port 3000 — the iframe then shows a
      // bare 502, which reads as "the preview is broken" rather than "this output is static".
      const hasNodeProject = await sandbox.files.exists(`${WORKSPACE}/package.json`).catch(() => false);
      // A finished `next build` leaves `.next/BUILD_ID`. When it is there, `next start` serves the
      // already-compiled app in a second or two and emits real <link> stylesheets in its SSR HTML;
      // `next dev` would recompile the whole app from scratch — tens of seconds — for nothing.
      const built = hasNodeProject && (await sandbox.files.exists(`${WORKSPACE}/.next/BUILD_ID`).catch(() => false));
      const command = !hasNodeProject
        ? "python3 -m http.server 3000 --bind 0.0.0.0"
        : built
          ? "npm run start -- --hostname 0.0.0.0 --port 3000"
          : "npm run dev -- --hostname 0.0.0.0 --port 3000";
      await sandbox.commands.run(command, { cwd: WORKSPACE, background: true, timeoutMs: 20_000 });

      // Returning the URL the instant the process is spawned hands the browser a URL that is not
      // listening yet: a dev server needs seconds to compile, and the iframe renders that race as a
      // 502 the user has no way to retry except by guessing. Wait for the port to actually answer.
      await waitForPort(sandbox);
    }

    const url = `https://${sandbox.getHost(3000)}`;

    // The port answering *inside* the sandbox is not the same as the app being reachable through
    // E2B's public edge — a just-resumed sandbox commonly 502s at the edge for another 10-20s
    // while the process finishes binding. Handing that URL to the iframe is exactly when it goes
    // blank with nothing in the console. Confirm the public URL returns real HTML first; if it
    // will not within a reasonable window, say so instead of returning a URL that renders nothing.
    const publicDeadline = Date.now() + 30_000;
    let lastStatus = 0;
    while (Date.now() < publicDeadline) {
      const probe = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(8_000) }).catch(() => null);
      if (probe) {
        lastStatus = probe.status;
        const contentType = probe.headers.get("content-type") ?? "";
        if (probe.ok && contentType.includes("text/html")) return { url, expiresAt: Date.now() + 10 * 60_000 };
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(
      `The app is running in the sandbox but E2B's public URL is not serving it yet (last status ${lastStatus || "no response"}). This usually clears in a few seconds — try Live preview again, or open it full screen.`,
    );
  },
});
