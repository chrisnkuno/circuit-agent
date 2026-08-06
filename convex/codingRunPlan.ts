"use node";

import { api, internal } from "./_generated/api";
import { buildTaskPlan } from "../lib/agent-orchestration";
import { estimateTaskCost } from "../lib/task-cost";
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
     * the payment hold stays pending, so nothing can dispatch until a person accepts the price
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

  // Authorizing here is what commits the money. Under "required" it is deliberately deferred to
  // the person accepting the quote, so a run can be created and inspected without any spend.
  if (args.costApproval === "pre-authorized") {
    await ctx.runMutation(useInternal ? internal.devPayment.authorizeDevelopmentPaymentInternal : api.devPayment.authorizeDevelopmentPayment, { taskId });
  }

  const plan = buildTaskPlan({ runId: "run", title: `Coding: ${objective}`, kind: "coding", requiresBrowserVerification: false });
  // The dispatcher only has a live worker for the "coding" role today (see docs/gap-register.md
  // — reviewer/research/operator workers are not built yet). The standard plan's trailing
  // approval-gated review step would sit forever with no executor once approved, so every real
  // entry point runs only the steps that can actually complete: inspect, reproduce, implement,
  // checks. Nothing downstream depended on the review step, so this stays a valid graph.
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
    taskId, kind: "coding", maxParallelism: plan.maxParallelism, objective, steps, workspacePresetId: args.workspacePresetId,
  });

  const runQuote: RunQuote = {
    estimateLowRwf: quote.estimateLowRwf,
    estimateHighRwf: quote.estimateHighRwf,
    maxRwf: quote.maxRwf,
    confidence: quote.confidence,
    assumptions: quote.assumptions,
  };

  if (args.costApproval === "required") {
    // The durable record of "this costs X — may I?". Until it is decided, the run sits queued
    // behind an unauthorized payment hold and no worker, model, or sandbox is ever touched.
    await ctx.runMutation(internal.approvals.requestTaskStartApproval, { taskId, runId, requestedRwf: BigInt(quote.maxRwf) });
    return { taskId, runId, quote: runQuote, awaitingCostApproval: true };
  }

  // The run is already durably queued, and the cron ticks every minute. A nudge that fails is
  // therefore a latency problem, never a correctness one — letting it reject here would report
  // a run that genuinely exists and will still execute as a failed start.
  try {
    await ctx.runAction(internal.dispatcher.dispatchTick, {});
  } catch {
    // Intentionally swallowed: the cron picks the run up on its next tick.
  }
  return { taskId, runId, quote: runQuote, awaitingCostApproval: false };
}
