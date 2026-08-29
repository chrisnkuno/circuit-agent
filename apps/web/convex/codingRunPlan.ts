"use node";

import { api, internal } from "./_generated/api";
import { buildTaskPlan } from "../lib/agent-orchestration";
import { estimateTaskCost } from "../lib/task-cost";
import { isWanderObjective } from "@circuit-nova/nova-core/wander";
import { inferWorkspacePresetId } from "@circuit-nova/nova-core/sandbox-templates";
import { createCodingModelProvider } from "@circuit-nova/nova-core/providers/factory";
import { applyCodingModelEnv } from "../lib/coding-model-env";
import type { Id } from "./_generated/dataModel";
import type { ActionCtx } from "./_generated/server";

export type RunQuote = { estimateLowRwf: number; estimateHighRwf: number; maxRwf: number; confidence: "high" | "medium" | "low"; assumptions: string[] };
export type StartCodingRunResult = { taskId: Id<"tasks">; runId: Id<"agentRuns">; quote: RunQuote; awaitingCostApproval: boolean };

/**
 * Shared orchestration behind every real coding-run entry point: the web terminal, Telegram,
 * and scheduled runs. `authorization` picks which mutation variant creates the task/run —
 * "session" for an authenticated web caller (identity-checked public mutations, which still
 * run their own permission check as defense in depth) or "trusted-organization" for a caller
 * that already resolved and verified organizationId itself (a channel link, a due schedule)
 * and goes through the internal variants instead. What gets built and how it's dispatched
 * afterward — the plan, the coding-only step filter, the dispatch nudge — is identical.
 */
export async function startCodingRun(
  ctx: ActionCtx,
  args: {
    organizationId: Id<"organizations">;
    objective: string;
    idempotencyKey: string;
    authorization: "session" | "trusted-organization";
    /**
     * "required" quotes the work and stops: the task, its quote, and its run are persisted, but
     * the run stays approval-gated, so nothing can dispatch until a person accepts the price
     * (convex/approvals.ts, kind "task_start"). "pre-authorized" is for entry points where the
     * person already agreed to the work at setup time and has no surface to accept a quote in
     * — a recurring schedule they created, a linked Telegram channel.
     */
    costApproval: "required" | "pre-authorized";
    /** Which prebuilt workspace image this run should execute in (lib/sandbox-templates.ts). */
    workspacePresetId?: string;
  },
): Promise<StartCodingRunResult> {
  if (process.env.ALLOW_TERMINAL_LIVE_EXECUTION !== "true") {
    throw new Error("Live execution is disabled. Set ALLOW_TERMINAL_LIVE_EXECUTION=true on this deployment to enable it.");
  }
  const objective = args.objective.trim();
  if (!objective || objective.length > 500) throw new Error("objective must contain 1 to 500 characters");

  const useInternal = args.authorization === "trusted-organization";
  const workspacePresetId = args.workspacePresetId ?? inferWorkspacePresetId(objective);
  // Both reads only feed decisions taken after the task is created, so run them together rather
  // than paying two serial Convex round-trips on the query→sandbox hot path.
  const [preferences, hasExistingCodebase] = await Promise.all([
    ctx.runQuery(internal.settings.getNovaPreferencesInternal, { organizationId: args.organizationId }),
    ctx.runQuery(internal.githubModel.hasConnectedRepository, { organizationId: args.organizationId }),
  ]);
  const modelProvider = preferences?.provider === "deployment" || !preferences?.provider ? undefined : preferences.provider;
  const modelId = preferences?.modelId?.trim() || undefined;
  if (modelProvider) {
    // Validated against the same resolution the dispatcher will use, so a run is never accepted
    // on one model and then executed on another.
    const env = applyCodingModelEnv(process.env as Record<string, string | undefined>, { provider: modelProvider, modelId });
    if (!createCodingModelProvider(env)) throw new Error(`The selected ${modelProvider} provider/model is not configured on this deployment.`);
  }
  const quote = estimateTaskCost({ kind: "coding", quality: "fast", attachmentCount: 0, requiresBrowser: false, requiresSandbox: true });
  const taskId: Id<"tasks"> = await ctx.runMutation(useInternal ? internal.tasks.createQuotedTaskInternal : api.tasks.createQuotedTask, {
    organizationId: args.organizationId,
    title: objective.slice(0, 120),
    kind: "coding",
    quality: "fast",
    estimateLowRwf: BigInt(quote.estimateLowRwf),
    estimateHighRwf: BigInt(quote.estimateHighRwf),
    maxRwf: BigInt(quote.maxRwf),
    confidence: quote.confidence,
    assumptions: quote.assumptions,
    idempotencyKey: args.idempotencyKey,
  });

  // Pre-authorized entry points record the internal execution budget immediately. Under
  // "required", dispatch is deliberately deferred until the person accepts the quote.
  if (args.costApproval === "pre-authorized") {
    await ctx.runMutation(useInternal ? internal.devPayment.authorizeDevelopmentPaymentInternal : api.devPayment.authorizeDevelopmentPayment, { taskId });
  }

  // The graph's shape follows the workspace: with no repository connected there is nothing to
  // inspect and no prior behaviour to reproduce, so those steps would each spend a full model call
  // redoing the objective from scratch. Resolved above (in parallel with preferences) rather than
  // taken on trust from the caller.
  const plan = buildTaskPlan({ runId: "run", title: `Coding: ${objective}`, kind: "coding", requiresBrowserVerification: false, hasExistingCodebase });
  // The dispatcher only has a live worker for the "coding" role today (see docs/planning/gap-register.md
  // — reviewer/research/operator workers are not built yet). The plan's trailing approval-gated
  // review step would sit forever with no executor once approved, so every real entry point runs
  // only the coding steps, which is the whole graph minus that review. Nothing downstream depended
  // on it, so this stays a valid graph in either shape.
  const steps = plan.steps
    .filter((step) => step.role === "coding")
    .map((step) => ({
      stepKey: step.id.replace(/^run:/, ""),
      title: step.title,
      role: step.role,
      dependsOn: step.dependsOn.map((dependency) => dependency.replace(/^run:/, "")),
      requiresApproval: step.requiresApproval ?? false,
      sandboxTemplate: step.sandboxTemplate,
      capabilityIds: step.capabilityIds,
    }));
  const runId: Id<"agentRuns"> = await ctx.runMutation(useInternal ? internal.agentRuns.createTaskRunInternal : api.agentRuns.createTaskRun, {
    taskId, kind: "coding", maxParallelism: plan.maxParallelism, objective, steps, workspacePresetId, modelProvider, modelId,
  });

  const runQuote: RunQuote = {
    estimateLowRwf: quote.estimateLowRwf,
    estimateHighRwf: quote.estimateHighRwf,
    maxRwf: quote.maxRwf,
    confidence: quote.confidence,
    assumptions: quote.assumptions,
  };

  // The run is already durably queued once its approval/prefetch below completes, and the cron
  // ticks every minute, so a nudge that fails is a latency problem and never a correctness one.
  // One retry because the scheduled tick from settleApproval is the true fallback and a single
  // transient RPC failure should not cost ~60s of waiting for the cron. claimStep is safe to race.
  const nudgeDispatch = async () => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await ctx.runAction(internal.dispatcher.dispatchTick, {});
        return;
      } catch {
        // fall through to one retry, then leave it to the scheduled tick / cron
      }
    }
  };

  if (args.costApproval === "required") {
    // The durable record of "this costs X — may I?". Until it is decided, the run sits queued
    // behind its approval gate and no worker, model, or sandbox is ever touched.
    // Wander Exa prefetch waits for approval so a declined quote never spends a search.
    const approval = await ctx.runMutation(internal.approvals.requestTaskStartApproval, { taskId, runId, requestedRwf: BigInt(quote.maxRwf) });
    // Auto-approved within the ceiling: settleApproval already scheduled a dispatch tick, but run
    // one inline as well so the happy path does not wait a scheduler hop to start.
    if (approval.autoApproved && !isWanderObjective(objective)) await nudgeDispatch();
    return { taskId, runId, quote: runQuote, awaitingCostApproval: !approval.autoApproved };
  }

  // Prefetch Wander evidence before the first coding step so the planner sees the dossier on
  // attempt one. Awaited (not merely scheduled) so dispatch reserves against the real prompt size.
  // Idempotent and topic-cached — repeated calls do not spend another Exa search.
  if (isWanderObjective(objective)) {
    try {
      await ctx.runAction(internal.wanderEvidenceActions.prefetchForRun, { runId });
    } catch {
      // Prefetch also schedules a dispatch nudge; the ensure path in executeClaimedStep is backup.
    }
  } else {
    await nudgeDispatch();
  }
  return { taskId, runId, quote: runQuote, awaitingCostApproval: false };
}
