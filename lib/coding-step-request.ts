import { findWorkspacePreset, presetPrograms } from "../packages/agent-core/src/sandbox-templates";
import { isWanderObjective, resolveExecutionSession } from "../packages/agent-core/src/wander";
import { wanderRepositoryContext } from "./wander-research";
import type { CodingPlanRequest } from "../packages/agent-core/src/providers/model";

const REPOSITORY_CONTEXT = "No repository is connected yet. There is no existing codebase to inspect; work only within the provided workspace using the allowed commands.";

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
    repositoryContext: wander ? wanderRepositoryContext(researchBrief) : REPOSITORY_CONTEXT,
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
