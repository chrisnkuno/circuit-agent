"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { planDispatch, qualifiedStepId, toDispatchPlan } from "../lib/dispatcher";
import type { AgentRunPlan } from "../lib/agent-orchestration";
import type { TaskBudget } from "../lib/agent-budget";
import { CodingAgentWorker, estimateCodingPlanReservation } from "../lib/coding-worker";
import { createCodingModelProvider, createE2BProvider, createModelPriceCatalog } from "../lib/providers/factory";
import type { CodingModelProvider, CodingPlanRequest } from "../lib/providers/model";
import type { CodingSandboxProvider } from "../lib/providers/contracts";
import type { ModelPriceCatalog } from "../lib/model-cost";
import { createConvexArtifactStore } from "./lib/artifactStore";
import { createWorkerControl } from "./lib/workerControl";
import { classifyWorkerFailure, retryDelayForFailure, summarizeWorkerError } from "../lib/worker-runtime";

const REPOSITORY_CONTEXT = "No repository is connected yet. There is no existing codebase to inspect; work only within the provided workspace using the allowed commands.";
// The worker only heartbeats once before the model call and then again per sandbox command
// (see lib/coding-worker.ts) — nothing renews the lease while the model call itself is in
// flight. The lease must comfortably outlast the model timeout below plus sandbox setup and
// verification time, or a slow-but-legitimate model response can race its own lease expiry.
const CLAIM_LEASE_MS = 180_000;
// Shared with lease recovery (crons.ts) so a step gets one attempt budget in total, whether an
// attempt died loudly with a transient error or silently by letting its lease lapse.
const MAX_STEP_ATTEMPTS = 3;
const SANDBOX_RUNTIME_SECONDS = 300;

function buildStepRequest(taskTitle: string, runObjective: string, taskId: string, stepId: string): CodingPlanRequest {
  return {
    taskId,
    stepId,
    objective: `${taskTitle}. ${runObjective}`.slice(0, 4_000),
    repositoryContext: REPOSITORY_CONTEXT,
    workspaceRoot: "/workspace/repo",
    maxCommands: 6,
    // A reasoning model spends output tokens on reasoning before it emits a single character of
    // the plan JSON, and the provider fails the step closed on a truncated plan rather than
    // execute half of one. 4,000 was not enough headroom: a live "reproduce" step died on
    // "finish reason length". The extra ceiling only costs what is actually generated, and the
    // per-step reservation it implies still sits far inside a standard task cap.
    maxOutputTokens: 8_000,
    // A reasoning-capable model's response time varies a lot with how much it "thinks" —
    // one observed live call used 1024 reasoning tokens and still finished in ~14s, but the
    // same depth under worse conditions (provider load, a harder objective) can comfortably
    // exceed 60s. 60s produced a real "Request was aborted" failure in production.
    timeoutMs: 90_000,
    reasoningEffort: "low",
    safetyIdentifier: `org_${taskId}`.slice(0, 64),
  };
}

type StepRunParams = {
  runId: Id<"agentRuns">;
  stepId: Id<"agentSteps">;
  workerId: string;
  reservationRwf: number;
  request: CodingPlanRequest;
  reuseSandboxId?: string;
  model: CodingModelProvider;
  sandbox: CodingSandboxProvider;
  prices: ModelPriceCatalog;
  providerName: string;
  /** Attempts already consumed by this step, including the current one (set at claim time). */
  attempts: number;
};

async function runCodingStep(ctx: ActionCtx, params: StepRunParams): Promise<void> {
  const worker = new CodingAgentWorker({
    model: params.model,
    sandbox: params.sandbox,
    artifacts: createConvexArtifactStore(ctx, params.workerId),
    control: createWorkerControl(ctx, { runId: params.runId, workerId: params.workerId, leaseMs: CLAIM_LEASE_MS }),
    prices: params.prices,
  });

  let result;
  try {
    result = await worker.execute({
      ...params.request,
      reuseSandboxId: params.reuseSandboxId,
      runId: params.runId,
      sandboxRuntimeSeconds: SANDBOX_RUNTIME_SECONDS,
      modelReservationRwf: params.reservationRwf,
    });
  } catch (error) {
    // A thrown error is an infrastructure failure — the worker never reached a verdict on the
    // work itself. If it looks transient, hand the step back for another attempt instead of
    // failing the run over a provider hiccup. (A worker that *does* reach a verdict returns
    // status "failed" below; that is a real answer about the work and is never retried.)
    if (classifyWorkerFailure(error) === "transient" && params.attempts < MAX_STEP_ATTEMPTS) {
      const released = await ctx.runMutation(internal.agentRuns.releaseStepForRetry, {
        runId: params.runId,
        stepId: params.stepId,
        workerId: params.workerId,
        reason: summarizeWorkerError(error),
        retryAfterMs: retryDelayForFailure(error, params.attempts),
      });
      if (released.released) return;
    }
    await ctx.runMutation(internal.agentRuns.recordStepOutcome, {
      runId: params.runId,
      stepId: params.stepId,
      workerId: params.workerId,
      actualRwf: 0n,
      provider: params.providerName,
      meter: "worker_error",
      quantity: 0,
      usageIdempotencyKey: `error_${params.stepId}_${params.workerId}`,
      outcome: "failed",
      summary: summarizeWorkerError(error),
      artifactReferences: [],
    });
    return;
  }

  // A cancelled run already transitioned the step's status via requestCancellation;
  // the lease is no longer "running", so there is nothing further to settle here.
  if (result.status === "cancelled") return;

  await ctx.runMutation(internal.agentRuns.recordStepOutcome, {
    runId: params.runId,
    stepId: params.stepId,
    workerId: params.workerId,
    actualRwf: BigInt(result.actualModelRwf),
    provider: params.providerName,
    meter: "model_tokens",
    quantity: result.modelUsage.totalTokens,
    usageIdempotencyKey: `usage_${params.stepId}_${params.workerId}`,
    outcome: result.status === "completed" ? "completed" : "failed",
    summary: result.summary,
    artifactReferences: result.artifactReferences.map((artifact) => artifact.reference),
  });
}

/**
 * Executes one already-claimed step, in its own action.
 *
 * Scheduled transactionally by `agentRuns.claimStep` the moment a claim commits, rather than
 * awaited inline by the dispatch tick. That separation is what makes the executor concurrent:
 * scheduled actions run in parallel, so N claimed steps genuinely run at once instead of
 * queueing behind each other in a single tick. It also bounds blast radius — one step that
 * hangs against a slow provider stalls only itself, not every other tenant's work — and keeps
 * any single action far away from Convex's 10-minute action limit, which four sequential steps
 * at a 90s model timeout plus sandbox time could otherwise approach.
 *
 * The step is already claimed and its lease is already ticking, so this action must always
 * reach a terminal record for it: complete, fail, or release it for retry.
 */
export const executeClaimedStep = internalAction({
  args: {
    runId: v.id("agentRuns"),
    stepId: v.id("agentSteps"),
    workerId: v.string(),
    reservationRwf: v.number(),
    attempts: v.number(),
    reuseSandboxId: v.optional(v.string()),
    taskId: v.id("tasks"),
    taskTitle: v.string(),
    runObjective: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const env = process.env as Record<string, string | undefined>;
    const prices = createModelPriceCatalog(env);
    const model = createCodingModelProvider(env);
    const sandbox = createE2BProvider(env);
    if (!prices || !model || !sandbox) {
      // Providers were readable when the step was claimed, so this only happens if configuration
      // changed underneath the claim. Hand the step back rather than burning its attempt budget.
      await ctx.runMutation(internal.agentRuns.releaseStepForRetry, {
        runId: args.runId,
        stepId: args.stepId,
        workerId: args.workerId,
        reason: "Execution providers are not configured on this deployment.",
        retryAfterMs: 60_000,
      });
      return null;
    }
    await runCodingStep(ctx, {
      runId: args.runId,
      stepId: args.stepId,
      workerId: args.workerId,
      reservationRwf: args.reservationRwf,
      request: buildStepRequest(args.taskTitle, args.runObjective, args.taskId, args.stepId),
      reuseSandboxId: args.reuseSandboxId,
      attempts: args.attempts,
      model,
      sandbox,
      prices,
      providerName: env.CODING_MODEL_PROVIDER ?? "unknown",
    });
    return null;
  },
});

/**
 * Auditable dispatch tick: combines validated run graphs, fair global scheduling,
 * provider readiness, approval gates, and per-run budgets into an explicit decision
 * before claiming any step. Claiming is all it does — execution is handed to a
 * per-step scheduled action (see executeClaimedStep), so the tick itself stays a short,
 * predictable control loop no matter how slow the work it releases turns out to be.
 * Only "coding" role steps currently execute; other roles remain queued as
 * needs_configuration until their workers exist.
 */
export const dispatchTick = internalAction({
  args: {},
  returns: v.object({ decided: v.number(), dispatched: v.number() }),
  handler: async (ctx) => {
    const env = process.env as Record<string, string | undefined>;
    const prices = createModelPriceCatalog(env);
    const model = createCodingModelProvider(env);
    const sandbox = createE2BProvider(env);
    const codingExecutionReady = Boolean(prices && model && sandbox);
    const providerName = env.CODING_MODEL_PROVIDER ?? "unknown";

    const snapshot = await ctx.runQuery(internal.agentRuns.getDispatchSnapshot, {});

    const plans: AgentRunPlan[] = snapshot.map(({ run, steps }) => toDispatchPlan({
      runId: run._id,
      title: run.objective,
      maxParallelism: run.maxParallelism,
      capabilityIds: run.capabilityIds,
      steps: steps.map((step) => ({
        stepKey: step.stepKey,
        title: step.title,
        role: step.role,
        dependsOn: step.dependsOn,
        status: step.status,
        requiresApproval: step.requiresApproval,
        sandboxTemplate: step.sandboxTemplate,
        capabilityIds: step.capabilityIds,
      })),
    }));

    const budgetsByRun: Record<string, TaskBudget | undefined> = {};
    const estimatedRwfByStep: Record<string, number | undefined> = {};
    const requestByStepId = new Map<string, CodingPlanRequest>();

    for (const { run, task, steps } of snapshot) {
      if (!task) continue;
      budgetsByRun[run._id] = { maxRwf: Number(task.maxRwf), spentRwf: Number(task.spentRwf), reservedRwf: Number(task.reservedRwf) };
      if (!prices) continue;
      for (const step of steps) {
        if (step.role !== "coding") continue;
        const request = buildStepRequest(task.title, run.objective, task._id, step._id);
        requestByStepId.set(qualifiedStepId(run._id, step.stepKey), request);
        estimatedRwfByStep[qualifiedStepId(run._id, step.stepKey)] = estimateCodingPlanReservation(request, prices).maximumRwf;
      }
    }

    const decisions = planDispatch({ plans, globalParallelism: 4, codingExecutionReady, budgetsByRun, estimatedRwfByStep });
    const stepById = new Map(snapshot.flatMap(({ run, steps }) => steps.map((step) => [qualifiedStepId(run._id, step.stepKey), step] as const)));

    let dispatched = 0;
    for (const decision of decisions) {
      if (decision.action !== "dispatch" || !decision.step) continue;
      const stepDoc = stepById.get(decision.step.id);
      if (!stepDoc) continue;
      const workerId = `dispatcher_${crypto.randomUUID()}`;
      const claim = await ctx.runMutation(internal.agentRuns.claimStep, {
        runId: decision.runId as Id<"agentRuns">,
        stepId: stepDoc._id,
        workerId,
        estimatedRwf: BigInt(decision.reservationRwf),
        leaseMs: CLAIM_LEASE_MS,
      });
      // A successful claim already scheduled its own execution inside the same transaction,
      // so there is nothing to await here — the tick moves straight on to the next decision.
      if (claim.status !== "claimed") continue;
      dispatched += 1;
    }

    return { decided: decisions.length, dispatched };
  },
});
