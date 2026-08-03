import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { validateTaskGraph } from "../lib/agent-orchestration";
import { requireOrganizationPermission } from "./lib/authz";

const role = v.union(v.literal("planner"), v.literal("coding"), v.literal("reviewer"), v.literal("research"), v.literal("operator"));
const template = v.union(v.literal("coding"), v.literal("browser"), v.literal("data"));

/** Creates an auditable coding run. External E2B/model execution is scheduled only after provider activation. */
export const createCodingRun = mutation({
  args: {
    taskId: v.id("tasks"), maxParallelism: v.number(), objective: v.string(),
    steps: v.array(v.object({ stepKey: v.string(), title: v.string(), role, dependsOn: v.array(v.string()), requiresApproval: v.boolean(), sandboxTemplate: v.optional(template) })),
  },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task) throw new Error("Task not found");
    await requireOrganizationPermission(ctx, task.organizationId, "agent:run");
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
      })),
    });
    if (graphIssues.length > 0) throw new Error(`Invalid task graph: ${graphIssues.map((issue) => issue.message).join("; ")}`);
    const now = Date.now();
    const runId = await ctx.db.insert("agentRuns", { taskId: args.taskId, role: "coding", status: "queued", objective: args.objective, maxParallelism: args.maxParallelism, createdAt: now });
    for (const step of args.steps) {
      const stepId = await ctx.db.insert("agentSteps", { ...step, runId, status: "pending", approvalStatus: step.requiresApproval ? "pending" : "not_required", attempts: 0, createdAt: now });
      if (step.requiresApproval) {
        await ctx.db.insert("approvals", {
          taskId: task._id,
          runId,
          stepId,
          kind: "execute_step",
          status: "pending",
          requestedAt: now,
        });
      }
    }
    await ctx.db.insert("agentRunEvents", { runId, type: "run_created", message: "Coding run created. Execution awaits an enabled E2B and model provider.", createdAt: now });
    return runId;
  },
});

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
    const [steps, events, artifacts] = await Promise.all([
      ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", run._id)).collect(),
      ctx.db.query("agentRunEvents").withIndex("by_run", (q) => q.eq("runId", run._id)).order("asc").collect(),
      ctx.db.query("agentArtifacts").withIndex("by_run", (q) => q.eq("runId", run._id)).collect(),
    ]);
    return { run, steps, events, artifacts };
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
    if (["completed", "failed", "cancelled"].includes(run.status)) return;
    const now = Date.now();
    await ctx.db.patch(runId, { status: "cancelled", cancelRequestedAt: now, completedAt: now });
    const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", runId)).collect();
    for (const step of steps) {
      if (["pending", "ready", "awaiting_approval"].includes(step.status)) await ctx.db.patch(step._id, { status: "cancelled" });
    }
    const taskRuns = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
    const allRunsTerminal = taskRuns.every((candidate) => candidate._id === runId || ["completed", "failed", "blocked", "cancelled"].includes(candidate.status));
    if (allRunsTerminal) {
      const hasFailedRun = taskRuns.some((candidate) => candidate._id !== runId && (candidate.status === "failed" || candidate.status === "blocked"));
      await ctx.db.patch(task._id, { status: hasFailedRun ? "blocked" : "cancelled" });
    }
    await ctx.db.insert("agentRunEvents", { runId, type: "cancellation_requested", message: "Run cancelled. Active workers must stop at their next safe checkpoint.", createdAt: now });
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
    if (run.status !== "queued" && run.status !== "running") throw new Error("Run is not dispatchable");
    if (step.status !== "pending" && step.status !== "ready") throw new Error("Step is not claimable");
    const steps = await ctx.db.query("agentSteps").withIndex("by_run", (q) => q.eq("runId", args.runId)).collect();
    const completedKeys = new Set(steps.filter((candidate) => candidate.status === "completed").map((candidate) => candidate.stepKey));
    if (!step.dependsOn.every((dependency) => completedKeys.has(dependency))) throw new Error("Step dependencies are incomplete");
    if (steps.filter((candidate) => candidate.status === "running").length >= run.maxParallelism) throw new Error("Run parallelism limit reached");
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
      await ctx.db.insert("approvals", { taskId: task._id, runId: run._id, stepId: step._id, kind: "budget_overage", status: "pending", requestedRwf: requestedTotalCapRwf, requestedAt: Date.now() });
      await ctx.db.patch(run._id, { status: "awaiting_approval" });
      return { status: "budget_approval_required" as const };
    }
    const now = Date.now();
    await ctx.db.patch(task._id, { reservedRwf: task.reservedRwf + args.estimatedRwf });
    await ctx.db.patch(task._id, { status: "running" });
    await ctx.db.patch(step._id, { status: "running", claimedBy: args.workerId, claimedAt: now, heartbeatAt: now, leaseExpiresAt: now + args.leaseMs, reservedRwf: args.estimatedRwf, attempts: step.attempts + 1 });
    await ctx.db.patch(run._id, { status: "running", startedAt: run.startedAt ?? now });
    await ctx.db.insert("agentRunEvents", { runId: run._id, type: "step_claimed", message: `${step.title} claimed by a worker.`, createdAt: now });
    return { status: "claimed" as const };
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
      await ctx.db.patch(task._id, { status: "blocked" });
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
      if (runIsComplete) {
        const taskRuns = await ctx.db.query("agentRuns").withIndex("by_task", (q) => q.eq("taskId", task._id)).collect();
        const allRunsComplete = taskRuns.every((candidate) => candidate._id === run._id || candidate.status === "completed");
        if (allRunsComplete) {
          await ctx.db.patch(task._id, { status: "completed" });
          await ctx.db.insert("taskEvents", { taskId: task._id, type: "task_completed", message: "All agent runs completed.", createdAt: now });
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
