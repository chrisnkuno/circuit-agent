import { findWorkspacePreset, presetPrograms } from "@circuit-nova/nova-core/sandbox-templates";
import { isWanderObjective, resolveExecutionSession } from "@circuit-nova/nova-core/wander";
import { wanderRepositoryContext } from "./wander-research";
import type { CodingPlanRequest } from "@circuit-nova/nova-core/providers/model";

const REPOSITORY_CONTEXT = "No repository is connected yet. There is no existing codebase to inspect; work only within the provided workspace using the allowed commands.";
/**
 * Extra contract for the prepared Next.js workspace.
 *
 * The App Router rule is here because it is the way generated apps actually fail: a plan writes
 * `<style jsx>` or a hook into a page that is a Server Component by default, and `npm run build`
 * dies with "'styled-jsx' cannot be imported from a Server Component module" after the sandbox has
 * already done all of its work. The model cannot infer the boundary from the file tree, so it is
 * stated rather than discovered.
 *
 * The "do not re-emit the scaffolding" rule is here for a budget reason, not a style one. This
 * text used to say the starter was already present and, in the next breath, that the final source
 * "must include package.json and its lockfile" — so plans dutifully wrote the scaffolding back
 * out. A Next.js lockfile alone can consume the entire single-step output allowance, and the step
 * then dies with a truncated plan having built nothing. Deployability is a property the finished
 * workspace must have, not a list of files the plan has to reproduce.
 */
const DEPLOYABLE_APP_CONTEXT = `A reviewed Next.js starter is already in the workspace, with package.json, its lockfile, dependencies, build and start scripts, and config files all present and working. Do not rewrite, regenerate or re-emit any of them, and never output a lockfile. Write only the files this feature actually needs — typically a page, its styles, and any sample data — plus DEPLOYMENT.md with exact build/start/environment instructions, and .env.example only if configuration is genuinely needed. Keep the result production-deployable and never include secret values. This is the Next.js App Router: every file is a Server Component unless its first line is the 'use client' directive. Any file using styled-jsx (<style jsx>), useState, useEffect, other React hooks, event handlers, or browser APIs must start with 'use client'. Prefer a CSS module or plain CSS file over styled-jsx. Run the production build before declaring the work complete, and fix any build failure rather than reporting success.`;

/**
 * Builds the model/sandbox request for a coding (or Wander) step. Session budgets come from
 * `resolveExecutionSession` so Wander can take ~8 minutes without widening everyday coding.
 */
export function buildStepRequest(
  taskTitle: string,
  runObjective: string,
  taskId: string,
  stepId: string,
  workspacePresetId?: string,
  researchBrief?: string | null,
): CodingPlanRequest {
  const preset = findWorkspacePreset(workspacePresetId);
  const wander = isWanderObjective(runObjective);
  const session = resolveExecutionSession(runObjective);
  return {
    // What this workspace actually ships, so the planner is never offered a tool the image lacks.
    templatePrograms: presetPrograms(preset),
    taskId,
    stepId,
    objective: `${taskTitle}. ${runObjective}`.slice(0, 4_000),
    repositoryContext: wander ? wanderRepositoryContext(researchBrief) : `${REPOSITORY_CONTEXT}${preset.id === "next-app" ? `\n${DEPLOYABLE_APP_CONTEXT}` : ""}`,
    // Seed the lab notebook so scientists can read the briefing as a file, not only in the prompt.
    ...(wander && researchBrief?.trim()
      ? { workspaceSeedFiles: [{ path: "wander/EVIDENCE.md", content: researchBrief }] }
      : {}),
    workspaceRoot: "/workspace/repo",
    maxCommands: session.maxCommands,
    // A reasoning model spends output tokens on reasoning before it emits a single character of
    // the plan JSON, and the provider fails the step closed on a truncated plan rather than
    // execute half of one. Wander notebooks need more headroom than a typical coding plan.
    maxOutputTokens: session.maxOutputTokens,
    // The worker only heartbeats once before the model call and then again per sandbox command
    // — nothing renews the lease while the model call itself is in flight, so timeout + sandbox
    // work must fit inside the session claim lease.
    timeoutMs: session.modelTimeoutMs,
    // What the streaming adapter actually enforces: a long plan is fine, silence is not.
    idleTimeoutMs: session.modelIdleTimeoutMs,
    reasoningEffort: session.reasoningEffort,
    safetyIdentifier: `org_${taskId}`.slice(0, 64),
  };
}
