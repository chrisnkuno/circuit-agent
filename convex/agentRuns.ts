import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { validateTaskGraph } from "../lib/agent-orchestration";
import { capabilityRegistry } from "../lib/capability-registry";
import { requireOrganizationPermission } from "./lib/authz";
import { internal } from "./_generated/api";
import { formatRwf } from "../lib/task-cost";
import { createApproval } from "./approvals";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";

const role = v.union(v.literal("planner"), v.literal("coding"), v.literal("reviewer"), v.literal("research"), v.literal("operator"));
const template = v.union(v.literal("coding"), v.literal("browser"), v.literal("data"));
const taskKind = v.union(v.literal("coding"), v.literal("research"), v.literal("writing"), v.literal("operations"));
const leadRole = { coding: "coding", research: "research", writing: "operator", operations: "operator" } as const;

// Bounds for the live run subscription. A coding run has 4-6 steps and roughly a dozen events,
// so these are generous ceilings for real runs rather than limits anyone should hit.
const RUN_EVENT_WINDOW = 200;
const MAX_RUN_STEPS = 64;
const MAX_RUN_ARTIFACTS = 200;

const taskRunArgs = {
  taskId: v.id("tasks"), kind: v.optional(taskKind), maxParallelism: v.number(), objective: v.string(), workspacePresetId: v.optional(v.string()),
  steps: v.array(v.object({ stepKey: v.string(), title: v.string(), role, dependsOn: v.array(v.string()), requiresApproval: v.boolean(), sandboxTemplate: v.optional(template), capabilityIds: v.optional(v.array(v.string())) })),
};

type TaskRunArgs = {
  taskId: Id<"tasks">; kind?: "coding" | "research" | "writing" | "operations"; maxParallelism: number; objective: string; workspacePresetId?: string;
  steps: Array<{ stepKey: string; title: string; role: "planner" | "coding" | "reviewer" | "research" | "operator"; dependsOn: string[]; requiresApproval: boolean; sandboxTemplate?: "coding" | "browser" | "data"; capabilityIds?: string[] }>;
};

/** Shared insert logic behind both the authenticated public mutation and the internal, channel-authorized variant. `task` is passed in already-fetched since every caller needs it for its own kind/status checks first. */
export async function insertTaskRun(ctx: MutationCtx, task: Doc<"tasks">, args: TaskRunArgs): Promise<Id<"agentRuns">> {
  const kind = args.kind ?? "coding";
  if (task.kind !== kind) throw new Error(`Run kind ${kind} does not match task kind ${task.kind}`);
  if (task.status === "completed" || task.status === "cancelled") throw new Error("Task is already terminal");
  if (!Number.isInteger(args.maxParallelism) || args.maxParallelism < 1 || args.maxParallelism > 8) throw new Error("maxParallelism must be between 1 and 8");
  if (!args.objective.trim() || args.objective.length > 4_000) throw new Error("objective must contain 1 to 4000 characters");
  const graphIssues = validateTaskGraph({
    runId: "new-run",
    title: "New coding run",
    maxParallelism: args.maxParallelism,
    steps: args.steps.map((step) => ({
      id: step.stepKey,
      title: step.title,
      role: step.role,
      dependsOn: step.dependsOn,
      status: "pending",
      requiresApproval: step.requiresApproval,
      sandboxTemplate: step.sandboxTemplate,
      capabilityIds: step.capabilityIds,
    })),
  });
  if (graphIssues.length > 0) throw new Error(`Invalid task graph: ${graphIssues.map((issue) => issue.message).join("; ")}`);
  const capabilityIds = [...new Set(args.steps.flatMap((step) => step.capabilityIds ?? []))];
  capabilityRegistry.resolve(kind, capabilityIds);
  for (const step of args.steps) {
    const requiresCapabilityApproval = (step.capabilityIds ?? []).some((id) => capabilityRegistry.get(id)?.requiresApproval);
    if (requiresCapabilityApproval && !step.requiresApproval) throw new Error(`Step ${step.stepKey} must require approval for its capabilities`);
  }
  const now = Date.now();
  const runId = await ctx.db.insert("agentRuns", { taskId: args.taskId, kind, role: leadRole[kind], status: "queued", objective: args.objective, capabilityIds, maxParallelism: args.maxParallelism, workspacePresetId: args.workspacePresetId, createdAt: now });
  for (const step of args.steps) {
    const stepId = await ctx.db.insert("agentSteps", { ...step, runId, status: "pending", approvalStatus: step.requiresApproval ? "pending" : "not_required", attempts: 0, createdAt: now });
    if (step.requiresApproval) {
      await createApproval(ctx, { taskId: task._id, runId, stepId, kind: "execute_step" });
    }
  }
  await ctx.db.insert("agentRunEvents", { runId, type: "run_created", message: `${kind} run created with ${capabilityIds.length} scoped capabilities. Execution awaits the required providers and approvals.`, createdAt: now });
  return runId;
}

/** Creates an auditable capability-scoped run. Workers still fail closed until their runtime is configured. */
export const createTaskRun = mutation({
  args: taskRunArgs,
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "agent:run");
    return insertTaskRun(ctx, task, args);
  },
});

/** Internal-only: the caller already resolved and trusts the task's organization via a verified channel link (see convex/channels.ts) — there is no better-auth session to check here. */
export const createTaskRunInternal = internalMutation({
  args: taskRunArgs,
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    return insertTaskRun(ctx, task, args);
  },
});

/** Backward-compatible endpoint name for existing coding clients. */
export const createCodingRun = createTaskRun;

export const listForTask = query({
  args: { taskId: v.id("tasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:read");
    return ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", args.taskId)).collect();
  },
});

export const getRunDetail = query({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Agent run not found");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:read");
    // Every new event re-runs this subscription and re-sends whatever it returns, so an
    // unbounded .collect() here costs O(events²) bandwidth over a run and hits Convex's
    // 1024-document ceiling on a long one. Only the most recent slice is ever needed: clients
    // render an append-only log and de-duplicate by event id, so a bounded window shows the
    // same thing for any realistic run and degrades honestly instead of failing on a huge one.
    const [steps, recentEvents, artifacts] = await Promise.all([
      ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).take(MAX_RUN_STEPS),
      ctx.db.query("agentRunEvents").withIndex("by_run", (q) => q.eq("runId", run._id)).order("desc").take(RUN_EVENT_WINDOW),
      ctx.db.query("agentArtifacts").withIndex("by_run", (q) => q.eq("runId", run._id)).take(MAX_RUN_ARTIFACTS),
    ]);
    return { run, steps, events: recentEvents.reverse(), artifacts, eventsTruncated: recentEvents.length === RUN_EVENT_WINDOW };
  },
});

/**
 * Soft-cancels one run: it stops at the next worker checkpoint rather than being killed
 * mid-command, so a sandbox is never abandoned with work half-applied and the run's evidence
 * stays truthful about how far it actually got.
 */
async function cancelRun(ctx: MutationCtx, run: Doc<"agentRuns">, task: Doc<"tasks">): Promise<boolean> {
  if (["completed", "failed", "cancelled"].includes(run.status)) return false;
  const now = Date.now();
  await ctx.db.patch(run._id, { status: "cancelled", cancelRequestedAt: now, completedAt: now });
  const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
  for (const step of steps) {
    if (["pending", "ready", "awaiting_approval"].includes(step.status)) await ctx.db.patch(step._id, { status: "cancelled" });
  }
  const taskRuns = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
  const allRunsTerminal = taskRuns.every((candidate) => candidate._id === run._id || ["completed", "failed", "blocked", "cancelled"].includes(candidate.status));
  if (allRunsTerminal) {
    const hasFailedRun = taskRuns.some((candidate) => candidate._id !== run._id && (candidate.status === "failed" || candidate.status === "blocked"));
    await ctx.db.patch(task._id, { status: hasFailedRun ? "blocked" : "cancelled" });
  }
  // Withdraw anything still asking to be approved for this run. A pending gate outliving its
  // run is not merely stale UI: deciding it would re-queue a cancelled run and authorize real
  // money against a task the person just stopped.
  await expirePendingApprovals(ctx, task._id, (approval) => approval.runId === run._id);
  await releaseRunSandbox(ctx, run);
  await ctx.db.insert("agentRunEvents", { runId: run._id, type: "cancellation_requested", message: "Run cancelled. Active workers must stop at their next safe checkpoint.", createdAt: now });
  await ctx.scheduler.runAfter(0, internal.emailActions.notifyRunLifecycle, {
    organizationId: task.organizationId,
    event: "cancelled",
    taskTitle: task.title,
    objective: run.objective,
    spentRwf: Number(task.spentRwf),
    maxRwf: Number(task.maxRwf),
  });
  return true;
}

/** Marks matching pending approvals for a task as expired, so nothing can be decided after the fact. */
async function expirePendingApprovals(ctx: MutationCtx, taskId: Id<"tasks">, matches: (approval: Doc<"approvals">) => boolean): Promise<number> {
  const approvals = await ctx.db.query("approvals").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect();
  let expired = 0;
  for (const approval of approvals) {
    if (approval.status !== "pending" || !matches(approval)) continue;
    await ctx.db.patch(approval._id, { status: "expired", decidedAt: Date.now() });
    expired += 1;
  }
  return expired;
}


/**
 * Destroys the sandbox a finished run was working in.
 *
 * Reuse makes this obligatory rather than tidy: a suspended sandbox is kept indefinitely by the
 * provider, so a run that ends without this leaves a workspace nobody will ever collect. It is
 * best-effort and always clears the record — a sandbox that is already gone is exactly the state
 * this is trying to reach, and failing here must never hold up the run's own terminal transition.
 */
async function releaseRunSandbox(ctx: MutationCtx, run: Doc<"agentRuns">): Promise<void> {
  if (!run.sandboxId) return;
  await ctx.db.patch(run._id, { sandboxId: undefined });
  await ctx.scheduler.runAfter(0, internal.sandboxCleanup.destroySandbox, { sandboxId: run.sandboxId, runId: run._id });
}


/**
 * Holds a run without giving it up. The step in flight finishes — there is no safe way to stop a
 * worker mid-command, and killing one would strand its sandbox and its reservation — but nothing
 * further is claimed until the run is resumed. The sandbox stays suspended in the meantime, which
 * costs nothing and keeps the workspace exactly as the paused step left it.
 */
export const pauseRun = mutation({
  args: { runId: v.id("agentRuns") },
  returns: v.object({ paused: v.boolean(), stepInFlight: v.boolean() }),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Agent run not found");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:cancel");
    if (!["queued", "running"].includes(run.status)) return { paused: false, stepInFlight: false };
    const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    const stepInFlight = steps.some((step) => step.status === "running");
    await ctx.db.patch(runId, { status: "paused" });
    await ctx.db.insert("agentRunEvents", {
      runId,
      type: "run_paused",
      message: stepInFlight
        ? "Run paused. The step already running will finish, and nothing further will start until you resume."
        : "Run paused. Nothing will start until you resume.",
      createdAt: Date.now(),
    });
    return { paused: true, stepInFlight };
  },
});

/** Returns a paused run to the queue and picks it up immediately rather than waiting for the cron. */
export const resumeRun = mutation({
  args: { runId: v.id("agentRuns") },
  returns: v.object({ resumed: v.boolean() }),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Agent run not found");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "agent:run");
    if (run.status !== "paused") return { resumed: false };
    await ctx.db.patch(runId, { status: "queued" });
    await ctx.db.insert("agentRunEvents", { runId, type: "run_resumed", message: "Run resumed. Its workspace is exactly as the paused step left it.", createdAt: Date.now() });
    await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
    return { resumed: true };
  },
});

export const requestCancellation = mutation({
  args: { runId: v.id("agentRuns") },
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (!run) throw new Error("Agent run not found");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:cancel");
    await cancelRun(ctx, run, task);
  },
});

/**
 * Stops a task from the task list, where a person thinks in tasks and has no run id to hand.
 * A task can own more than one run, so every non-terminal one is cancelled — stopping "the
 * task" while a second run of it kept spending would be a lie.
 */
export const requestTaskCancellation = mutation({
  args: { taskId: v.id("tasks") },
  returns: v.object({ cancelledRuns: v.number() }),
  handler: async (ctx, { taskId }) => {
    const task = await ctx.db.get(taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "task:cancel");
    const runs = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect();
    let cancelledRuns = 0;
    for (const run of runs) {
      if (await cancelRun(ctx, run, task)) cancelledRuns += 1;
    }
    // A task with no run at all (quoted, never accepted) still has to become stoppable.
    if (cancelledRuns === 0 && !["completed", "cancelled"].includes(task.status)) {
      await ctx.db.patch(taskId, { status: "cancelled" });
      await ctx.db.insert("taskEvents", { taskId, type: "task_cancelled", message: "The task was stopped before any run started.", createdAt: Date.now() });
    }
    // Anything still pending against this task — including gates that never named a run — goes
    // with it, so a stopped task leaves nothing decidable behind.
    await expirePendingApprovals(ctx, taskId, () => true);
    return { cancelledRuns };
  },
});

export const claimStep = internalMutation({
  args: { runId: v.id("agentRuns"), stepId: v.id("agentSteps"), workerId: v.string(), estimatedRwf: v.int64(), leaseMs: v.number() },
  handler: async (ctx, args) => {
    if (args.estimatedRwf <= 0n) throw new Error("estimatedRwf must be a positive integer RWF amount");
    if (!Number.isInteger(args.leaseMs) || args.leaseMs < 5_000 || args.leaseMs > 5 * 60_000) {
      throw new Error("leaseMs must be an integer between 5 seconds and 5 minutes");
    }
    const run = await ctx.db.get(args.runId);
    const step = await ctx.db.get(args.stepId);
    if (!run || !step || step.runId !== args.runId) throw new Error("Run step not found");
    // Everything below is a lost race, not a caller mistake: dispatch ticks overlap by design
    // (the cron ticks every minute and every new run nudges one), so between a tick's snapshot
    // and its claim another tick can legitimately have taken this step, finished a dependency,
    // filled the parallelism budget, or moved the run out of a dispatchable state. Reporting
    // that as a status lets the loser skip the step; throwing aborted the entire tick — and
    // surfaced as a spurious "run failed" to whoever happened to start a run at that moment.
    if (run.status !== "queued" && run.status !== "running") return { status: "not_claimable" as const };
    if (step.status !== "pending" && step.status !== "ready") return { status: "not_claimable" as const };
    const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect();
    const completedKeys = new Set(steps.filter((candidate) => candidate.status === "completed").map((candidate) => candidate.stepKey));
    if (!step.dependsOn.every((dependency) => completedKeys.has(dependency))) return { status: "not_claimable" as const };
    if (steps.filter((candidate) => candidate.status === "running").length >= run.maxParallelism) return { status: "not_claimable" as const };
    if (step.requiresApproval && step.approvalStatus !== "approved") {
      await ctx.db.patch(step._id, { status: "awaiting_approval" });
      await ctx.db.patch(run._id, { status: "awaiting_approval" });
      return { status: "awaiting_approval" as const };
    }
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    const paymentHold = await ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", task._id)).order("desc").first();
    if (!paymentHold || paymentHold.status !== "authorized" || paymentHold.amountRwf < task.maxRwf) {
      await ctx.db.patch(run._id, { status: "awaiting_approval" });
      await ctx.db.insert("agentRunEvents", { runId: run._id, type: "payment_authorization_required", message: "Execution is blocked until the authorized Circuit Pay hold covers the approved task cap.", createdAt: Date.now() });
      return { status: "payment_authorization_required" as const };
    }
    if (task.spentRwf + task.reservedRwf + args.estimatedRwf > task.maxRwf) {
      const requestedTotalCapRwf = task.spentRwf + task.reservedRwf + args.estimatedRwf;
      await createApproval(ctx, { taskId: task._id, runId: run._id, stepId: step._id, kind: "budget_overage", requestedRwf: requestedTotalCapRwf });
      await ctx.db.patch(run._id, { status: "awaiting_approval" });
      return { status: "budget_approval_required" as const };
    }
    const now = Date.now();
    await ctx.db.patch(task._id, { reservedRwf: task.reservedRwf + args.estimatedRwf });
    await ctx.db.patch(task._id, { status: "running" });
    await ctx.db.patch(step._id, { status: "running", claimedBy: args.workerId, claimedAt: now, heartbeatAt: now, leaseExpiresAt: now + args.leaseMs, reservedRwf: args.estimatedRwf, attempts: step.attempts + 1 });
    await ctx.db.patch(run._id, { status: "running", startedAt: run.startedAt ?? now });
    await ctx.db.insert("agentRunEvents", { runId: run._id, type: "step_claimed", message: `${step.title} claimed by a worker.`, createdAt: now });
    // Only the transition into running is a "started" event. Every later step claim is progress
    // within a run that already announced itself, and mailing each one would be noise.
    if (!run.startedAt) {
      await ctx.scheduler.runAfter(0, internal.emailActions.notifyRunLifecycle, {
        organizationId: task.organizationId,
        event: "started",
        taskTitle: task.title,
        objective: run.objective,
        spentRwf: Number(task.spentRwf),
        maxRwf: Number(task.maxRwf),
      });
    }
    // Scheduled from inside the claim transaction: if the claim commits, the executor is
    // guaranteed to run, and if it rolls back nothing was ever claimed. Scheduling from the
    // calling action instead would leave a window where a step is claimed and leased but has
    // no executor, recoverable only by waiting out its lease.
    if (step.role === "coding") {
      await ctx.scheduler.runAfter(0, internal.dispatcher.executeClaimedStep, {
        runId: run._id,
        stepId: step._id,
        workerId: args.workerId,
        reservationRwf: Number(args.estimatedRwf),
        attempts: step.attempts + 1,
        reuseSandboxId: run.sandboxId,
        workspacePresetId: run.workspacePresetId,
        taskId: task._id,
        taskTitle: task.title,
        runObjective: run.objective,
      });
    }
    return { status: "claimed" as const };
  },
});

/**
 * Hands a claimed step back to the queue after an infrastructure failure, instead of failing the
 * whole run. A provider timeout, a socket reset, or a bot-challenge page says nothing about
 * whether the work is achievable — only that this attempt could not reach the provider — so the
 * step releases its reservation and waits out a backoff rather than burning the run.
 *
 * The step keeps the attempt it already consumed at claim time, so this shares one attempt budget
 * with lease recovery and cannot loop forever.
 */
export const releaseStepForRetry = internalMutation({
  args: { runId: v.id("agentRuns"), stepId: v.id("agentSteps"), workerId: v.string(), reason: v.string(), retryAfterMs: v.number() },
  returns: v.object({ released: v.boolean() }),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.retryAfterMs) || args.retryAfterMs < 0 || args.retryAfterMs > 10 * 60_000) {
      throw new Error("retryAfterMs must be an integer between 0 and 10 minutes");
    }
    const [run, step] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.stepId)]);
    if (!run || !step || step.runId !== run._id) throw new Error("Run step not found");
    // Lost the lease (recovery already reclaimed it, or the run was cancelled): whoever owns it
    // now is responsible for its outcome, so this attempt must not write over them.
    if (step.status !== "running" || step.claimedBy !== args.workerId) return { released: false };
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    const now = Date.now();
    const reservationRwf = step.reservedRwf ?? 0n;
    if (reservationRwf > task.reservedRwf) throw new Error("Step reservation exceeds task reserved balance");
    await ctx.db.patch(task._id, { reservedRwf: task.reservedRwf - reservationRwf });
    await ctx.db.patch(step._id, { status: "pending", claimedBy: undefined, claimedAt: undefined, leaseExpiresAt: undefined, heartbeatAt: undefined, sandboxId: undefined, reservedRwf: undefined });
    if (run.status !== "cancelled") {
      const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
      const othersRunning = steps.some((candidate) => candidate._id !== step._id && candidate.status === "running");
      await ctx.db.patch(run._id, { status: othersRunning ? "running" : "queued" });
    }
    await ctx.db.insert("agentRunEvents", { runId: run._id, type: "step_retry_scheduled", message: `${step.title} will be retried after a transient failure: ${args.reason}`, createdAt: now });
    if (run.status !== "cancelled") await ctx.scheduler.runAfter(args.retryAfterMs, internal.dispatcher.dispatchTick, {});
    return { released: true };
  },
});

export const heartbeatStep = internalMutation({
  args: { runId: v.id("agentRuns"), stepId: v.id("agentSteps"), workerId: v.string(), sandboxId: v.optional(v.string()), leaseMs: v.number() },
  returns: v.object({ continueExecution: v.boolean(), leaseExpiresAt: v.number() }),
  handler: async (ctx, args) => {
    if (!Number.isInteger(args.leaseMs) || args.leaseMs < 5_000 || args.leaseMs > 5 * 60_000) {
      throw new Error("leaseMs must be an integer between 5 seconds and 5 minutes");
    }
    const [run, step] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.stepId)]);
    if (!run || !step || step.runId !== run._id || step.status !== "running" || step.claimedBy !== args.workerId) {
      throw new Error("Worker does not own this running step lease");
    }
    const now = Date.now();
    if (!step.leaseExpiresAt || step.leaseExpiresAt <= now) throw new Error("Worker step lease has expired");
    const leaseExpiresAt = now + args.leaseMs;
    if (run.status === "cancelled") return { continueExecution: false, leaseExpiresAt: step.leaseExpiresAt };
    await ctx.db.patch(step._id, { heartbeatAt: now, leaseExpiresAt, sandboxId: args.sandboxId ?? step.sandboxId });
    // The run, not just the step, remembers the sandbox: the step clears its own on completion,
    // and the run is what hands the workspace to the next step and destroys it at the end.
    if (args.sandboxId && run.sandboxId !== args.sandboxId) await ctx.db.patch(run._id, { sandboxId: args.sandboxId });
    return { continueExecution: true, leaseExpiresAt };
  },
});

export const recordArtifact = internalMutation({
  args: {
    runId: v.id("agentRuns"),
    stepId: v.id("agentSteps"),
    workerId: v.string(),
    kind: v.union(v.literal("model_plan"), v.literal("command_log"), v.literal("patch"), v.literal("test_log"), v.literal("review_summary")),
    mediaType: v.string(),
    reference: v.string(),
    sha256: v.string(),
    byteLength: v.number(),
  },
  returns: v.id("agentArtifacts"),
  handler: async (ctx, args) => {
    if (!args.reference.trim() || !/^[a-f0-9]{64}$/.test(args.sha256)) throw new Error("Artifact reference and SHA-256 are required");
    if (!Number.isSafeInteger(args.byteLength) || args.byteLength < 1 || args.byteLength > 2_000_000) throw new Error("Artifact byteLength is invalid");
    const [run, step] = await Promise.all([ctx.db.get(args.runId), ctx.db.get(args.stepId)]);
    if (!run || !step || step.runId !== run._id || step.status !== "running" || step.claimedBy !== args.workerId) {
      throw new Error("Worker does not own this running step lease");
    }
    const now = Date.now();
    if (run.status === "cancelled") throw new Error("Run is cancelled");
    if (!step.leaseExpiresAt || step.leaseExpiresAt <= now) throw new Error("Worker step lease has expired");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    const existing = await ctx.db.query("agentArtifacts").withIndex("by_reference", (q) => q.eq("reference", args.reference)).first();
    if (existing) {
      if (existing.stepId !== step._id || existing.sha256 !== args.sha256) throw new Error("Artifact reference collision");
      return existing._id;
    }
    return ctx.db.insert("agentArtifacts", {
      taskId: task._id,
      runId: run._id,
      stepId: step._id,
      kind: args.kind,
      mediaType: args.mediaType,
      reference: args.reference,
      sha256: args.sha256,
      byteLength: args.byteLength,
      createdAt: now,
    });
  },
});

export const recordStepOutcome = internalMutation({
  args: {
    runId: v.id("agentRuns"), stepId: v.id("agentSteps"), workerId: v.string(),
    actualRwf: v.int64(), provider: v.string(), meter: v.string(), quantity: v.number(),
    usageIdempotencyKey: v.string(), outcome: v.union(v.literal("completed"), v.literal("failed")),
    summary: v.string(), artifactReferences: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.actualRwf < 0n) throw new Error("actualRwf must be a non-negative integer RWF amount");
    if (!Number.isFinite(args.quantity) || args.quantity < 0) throw new Error("quantity must be a non-negative finite number");
    if (!args.summary.trim()) throw new Error("A worker outcome requires a non-empty summary");
    if (args.outcome === "completed" && args.artifactReferences.length === 0) throw new Error("Completed work requires at least one evidence reference");
    const run = await ctx.db.get(args.runId);
    const step = await ctx.db.get(args.stepId);
    if (!run || !step || step.runId !== args.runId) throw new Error("Run step not found");
    const existingUsage = await ctx.db.query("usageLedger").withIndex("by_idempotency_key", (q) => q.eq("idempotencyKey", args.usageIdempotencyKey)).first();
    if (existingUsage) {
      if (existingUsage.taskId !== run.taskId || existingUsage.runId !== args.runId || existingUsage.stepId !== args.stepId || existingUsage.amountRwf !== args.actualRwf) {
        throw new Error("Usage idempotency key collision");
      }
      return;
    }
    if (step.status !== "running" || step.claimedBy !== args.workerId) {
      throw new Error("Worker does not own this running step lease");
    }
    const now = Date.now();
    if (!step.leaseExpiresAt || step.leaseExpiresAt <= now) throw new Error("Worker step lease has expired");
    if (run.status === "cancelled") throw new Error("Run is cancelled");
    const task = await ctx.db.get(run.taskId);
    if (!task) throw new Error("Task not found");
    const reservationRwf = step.reservedRwf ?? 0n;
    if (reservationRwf > task.reservedRwf) throw new Error("Step reservation exceeds task reserved balance");
    if (args.actualRwf > reservationRwf) throw new Error("Actual usage exceeds the step reservation");
    if (task.spentRwf + args.actualRwf > task.maxRwf) throw new Error("Usage exceeds approved task cap");
    await ctx.db.patch(task._id, { reservedRwf: task.reservedRwf - reservationRwf, spentRwf: task.spentRwf + args.actualRwf });
    const artifacts = await ctx.db.query("agentArtifacts").withIndex("by_step", (q) => q.eq("stepId", step._id)).collect();
    const recordedReferences = new Set(artifacts.map((artifact) => artifact.reference));
    if (args.outcome === "completed" && args.artifactReferences.some((reference) => !recordedReferences.has(reference))) {
      throw new Error("Completed work references an artifact that was not recorded for this step");
    }
    await ctx.db.patch(step._id, { status: args.outcome, completedAt: now, summary: args.summary, artifactReferences: args.artifactReferences, leaseExpiresAt: undefined, heartbeatAt: undefined, sandboxId: undefined, reservedRwf: undefined });
    await ctx.db.insert("usageLedger", { taskId: task._id, runId: run._id, stepId: step._id, provider: args.provider, meter: args.meter, quantity: args.quantity, amountRwf: args.actualRwf, idempotencyKey: args.usageIdempotencyKey, createdAt: now });
    await ctx.db.insert("agentRunEvents", { runId: run._id, type: `step_${args.outcome}`, message: args.summary, createdAt: now });
    if (args.outcome === "failed") {
      await ctx.db.patch(run._id, { status: "failed", completedAt: now });
      await releaseRunSandbox(ctx, run);
      await ctx.db.patch(task._id, { status: "blocked" });
      await ctx.scheduler.runAfter(0, internal.telegramActions.notifyLinkedChannels, {
        organizationId: task.organizationId,
        message: `❌ "${task.title}" failed — spent ${formatRwf(Number(task.spentRwf + args.actualRwf))} of ${formatRwf(Number(task.maxRwf))} cap. ${args.summary}`,
      });
      await ctx.scheduler.runAfter(0, internal.emailActions.notifyRunLifecycle, {
        organizationId: task.organizationId,
        event: "failed",
        taskTitle: task.title,
        objective: run.objective,
        spentRwf: Number(task.spentRwf + args.actualRwf),
        maxRwf: Number(task.maxRwf),
        detail: args.summary,
      });
    } else {
      const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).collect();
      const effectiveStatuses = steps.map((candidate) => candidate._id === step._id ? "completed" : candidate.status);
      const runIsComplete = effectiveStatuses.every((status) => status === "completed");
      const nextRunStatus = runIsComplete
        ? "completed"
        : effectiveStatuses.some((status) => status === "running" || status === "ready")
          ? "running"
          : effectiveStatuses.some((status) => status === "awaiting_approval")
            ? "awaiting_approval"
            : "queued";
      await ctx.db.patch(run._id, runIsComplete ? { status: nextRunStatus, completedAt: now } : { status: nextRunStatus });
      if (runIsComplete) await releaseRunSandbox(ctx, run);
      // The step that just finished is usually what unblocks the next one, so release it now
      // instead of leaving it to the one-minute cron. Waiting for the cron added up to a minute
      // of dead time between every pair of steps — the dominant cost of a short run, which spent
      // roughly three minutes of wall-clock on well under one minute of actual work.
      if (!runIsComplete && (nextRunStatus === "queued" || nextRunStatus === "running")) {
        await ctx.scheduler.runAfter(0, internal.dispatcher.dispatchTick, {});
      }
      if (runIsComplete) {
        const taskRuns = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
        const allRunsComplete = taskRuns.every((candidate) => candidate._id === run._id || candidate.status === "completed");
        if (allRunsComplete) {
          await ctx.db.patch(task._id, { status: "completed" });
          await ctx.db.insert("taskEvents", { taskId: task._id, type: "task_completed", message: "All agent runs completed.", createdAt: now });
          await ctx.scheduler.runAfter(0, internal.telegramActions.notifyLinkedChannels, {
            organizationId: task.organizationId,
            message: `✅ "${task.title}" completed — spent ${formatRwf(Number(task.spentRwf + args.actualRwf))} of ${formatRwf(Number(task.maxRwf))} cap.`,
          });
          await ctx.scheduler.runAfter(0, internal.emailActions.notifyRunLifecycle, {
            organizationId: task.organizationId,
            event: "completed",
            taskTitle: task.title,
            objective: run.objective,
            spentRwf: Number(task.spentRwf + args.actualRwf),
            maxRwf: Number(task.maxRwf),
            detail: args.summary,
          });
        }
      }
    }
  },
});

export const recoverExpiredLeases = internalMutation({
  args: { maxAttempts: v.number() },
  handler: async (ctx, { maxAttempts }) => {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) throw new Error("maxAttempts must be an integer between 1 and 10");
    const now = Date.now();
    const expired = await ctx.db.query("agentSteps").withIndex("by_status_lease", (q) => q.eq("status", "running").lt("leaseExpiresAt", now)).take(100);
    let retried = 0;
    let failed = 0;
    let cancelled = 0;
    for (const step of expired) {
      const run = await ctx.db.get(step.runId);
      if (!run) continue;
      const task = await ctx.db.get(run.taskId);
      if (!task) continue;
      const reservationRwf = step.reservedRwf ?? 0n;
      if (reservationRwf > task.reservedRwf) throw new Error("Expired step reservation exceeds task balance");
      await ctx.db.patch(task._id, { reservedRwf: task.reservedRwf - reservationRwf });
      if (run.status === "cancelled") {
        await ctx.db.patch(step._id, { status: "cancelled", completedAt: now, summary: "Worker lease expired after the run was cancelled.", leaseExpiresAt: undefined, heartbeatAt: undefined, sandboxId: undefined, reservedRwf: undefined });
        cancelled += 1;
      } else if (step.attempts >= maxAttempts) {
        await ctx.db.patch(step._id, { status: "failed", completedAt: now, summary: "Worker lease expired after the retry limit.", leaseExpiresAt: undefined, heartbeatAt: undefined, sandboxId: undefined, reservedRwf: undefined });
        await ctx.db.patch(run._id, { status: "failed", completedAt: now });
        await ctx.db.patch(task._id, { status: "blocked" });
        await releaseRunSandbox(ctx, run);
        failed += 1;
      } else {
        await ctx.db.patch(step._id, { status: "pending", claimedBy: undefined, claimedAt: undefined, leaseExpiresAt: undefined, heartbeatAt: undefined, sandboxId: undefined, reservedRwf: undefined });
        await ctx.db.patch(run._id, { status: "queued" });
        retried += 1;
      }
      const message = run.status === "cancelled"
        ? "Step released its reservation after the cancelled run's worker lease expired."
        : step.attempts >= maxAttempts
          ? "Step failed after its worker lease expired repeatedly."
          : "Step returned to the queue after its worker lease expired.";
      await ctx.db.insert("agentRunEvents", { runId: run._id, type: "lease_expired", message, createdAt: now });
    }
    return { scanned: expired.length, retried, failed, cancelled };
  },
});

/** Cancellation checkpoint polled by the coding worker; never exposed to clients. */
export const isRunCancelled = internalQuery({
  args: { runId: v.id("agentRuns") },
  returns: v.boolean(),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    return run?.status === "cancelled";
  },
});

/** Internal snapshot consumed by the dispatcher action; never exposed to clients. */
export const getDispatchSnapshot = internalQuery({
  args: {},
  handler: async (ctx) => {
    const queued = await ctx.db.query("agentRuns").withIndex("by_status", (q) => q.eq("status", "queued")).take(50);
    const running = await ctx.db.query("agentRuns").withIndex("by_status", (q) => q.eq("status", "running")).take(50);
    const runs = [...queued, ...running];
    return Promise.all(runs.map(async (run) => {
      const [task, steps, paymentHold] = await Promise.all([
        ctx.db.get(run.taskId),
        ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).collect(),
        ctx.db.query("paymentHolds").withIndex("by_task", (q) => q.eq("taskId", run.taskId)).order("desc").first(),
      ]);
      return { run, task, steps, paymentHold };
    }));
  },
});
