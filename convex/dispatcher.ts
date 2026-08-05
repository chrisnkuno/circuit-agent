"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { planDispatch } from "../lib/dispatcher";
import type { AgentRunPlan, AgentStep } from "../lib/agent-orchestration";
import type { TaskBudget } from "../lib/agent-budget";
import { CodingAgentWorker, estimateCodingPlanReservation } from "../lib/coding-worker";
import { createCodingModelProvider, createE2BProvider, createModelPriceCatalog } from "../lib/providers/factory";
import type { CodingModelProvider, CodingPlanRequest } from "../lib/providers/model";
import type { CodingSandboxProvider } from "../lib/providers/contracts";
import type { ModelPriceCatalog } from "../lib/model-cost";
import { createConvexArtifactStore } from "./lib/artifactStore";
import { createWorkerControl } from "./lib/workerControl";
import { summarizeWorkerError } from "../lib/worker-runtime";

const REPOSITORY_CONTEXT = "No repository is connected yet. There is no existing codebase to inspect; work only within the provided workspace using the allowed commands.";
const CLAIM_LEASE_MS = 120_000;
const SANDBOX_RUNTIME_SECONDS = 300;

function buildStepRequest(taskTitle: string, runObjective: string, taskId: string, stepId: string): CodingPlanRequest {
  return {
    taskId,
    stepId,
    objective: `${taskTitle}. ${runObjective}`.slice(0, 4_000),
    repositoryContext: REPOSITORY_CONTEXT,
    workspaceRoot: "/workspace/repo",
    maxCommands: 6,
    maxOutputTokens: 4_000,
    timeoutMs: 60_000,
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
  model: CodingModelProvider;
  sandbox: CodingSandboxProvider;
  prices: ModelPriceCatalog;
  providerName: string;
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
      runId: params.runId,
      sandboxRuntimeSeconds: SANDBOX_RUNTIME_SECONDS,
      modelReservationRwf: params.reservationRwf,
    });
  } catch (error) {
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
 * Auditable dispatch tick: combines validated run graphs, fair global scheduling,
 * provider readiness, approval gates, and per-run budgets into an explicit decision
 * before claiming or executing any step. Only "coding" role steps currently execute;
 * other roles remain queued as needs_configuration until their workers exist.
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

    const plans: AgentRunPlan[] = snapshot.map(({ run, steps }) => ({
      runId: run._id,
      title: run.objective,
      maxParallelism: run.maxParallelism,
      capabilityIds: run.capabilityIds,
      steps: steps.map((step): AgentStep => ({
        id: step.stepKey,
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
    const requestByStepKey = new Map<string, CodingPlanRequest>();

    for (const { run, task, steps } of snapshot) {
      if (!task) continue;
      budgetsByRun[run._id] = { maxRwf: Number(task.maxRwf), spentRwf: Number(task.spentRwf), reservedRwf: Number(task.reservedRwf) };
      if (!prices) continue;
      for (const step of steps) {
        if (step.role !== "coding") continue;
        const request = buildStepRequest(task.title, run.objective, task._id, step._id);
        requestByStepKey.set(step.stepKey, request);
        estimatedRwfByStep[step.stepKey] = estimateCodingPlanReservation(request, prices).maximumRwf;
      }
    }

    const decisions = planDispatch({ plans, globalParallelism: 4, codingExecutionReady, budgetsByRun, estimatedRwfByStep });
    const stepByKey = new Map(snapshot.flatMap(({ steps }) => steps.map((step) => [step.stepKey, step] as const)));

    let dispatched = 0;
    for (const decision of decisions) {
      if (decision.action !== "dispatch" || !decision.step) continue;
      const stepDoc = stepByKey.get(decision.step.id);
      if (!stepDoc) continue;
      const workerId = `dispatcher_${crypto.randomUUID()}`;
      const claim = await ctx.runMutation(internal.agentRuns.claimStep, {
        runId: decision.runId as Id<"agentRuns">,
        stepId: stepDoc._id,
        workerId,
        estimatedRwf: BigInt(decision.reservationRwf),
        leaseMs: CLAIM_LEASE_MS,
      });
      if (claim.status !== "claimed") continue;
      dispatched += 1;

      if (stepDoc.role === "coding" && model && sandbox && prices) {
        const request = requestByStepKey.get(stepDoc.stepKey);
        if (request) {
          await runCodingStep(ctx, {
            runId: decision.runId as Id<"agentRuns">,
            stepId: stepDoc._id,
            workerId,
            reservationRwf: decision.reservationRwf,
            request,
            model,
            sandbox,
            prices,
            providerName,
          });
        }
      }
    }

    return { decided: decisions.length, dispatched };
  },
});
