import { CodingPlanSchema } from "../packages/agent-core/src/coding-prompt";
import { estimateModelCost, priceActualModelUsage, type ModelCostEstimate, type ModelPriceCatalog } from "../packages/agent-core/src/model-cost";
import { buildCodingPlannerPrompt } from "../packages/agent-core/src/coding-prompt";
import { truncateEvidence, type ArtifactReference, type ArtifactStore, type ArtifactWrite } from "./artifacts";
import { summarizeCommandFailure } from "./worker-runtime";
import type { InteractiveCodingSandboxProvider, SandboxCommandResult, SandboxSession } from "../packages/agent-core/src/providers/contracts";
import type { CodingModelProvider, CodingPlanRequest, ModelUsage } from "../packages/agent-core/src/providers/model";
import { isWanderObjective } from "../packages/agent-core/src/wander";
import { assembleWanderReport } from "./wander-report";

export type CodingWorkerControl = {
  /**
   * `sandboxId` is reported as soon as one exists so the control plane can show which sandbox is
   * live and, more importantly, still knows about it if this worker dies before releasing it.
   */
  heartbeat(stepId: string, sandboxId?: string): Promise<void>;
  isCancellationRequested(runId: string): Promise<boolean>;
};

export type CodingWorkerRequest = CodingPlanRequest & {
  runId: string;
  sandboxRuntimeSeconds: number;
  modelReservationRwf: number;
  /**
   * Wall-clock the whole step may spend, model call included. Optional so callers that do not
   * run inside a bounded host keep the previous unbounded behaviour.
   */
  stepDeadlineMs?: number;
  /**
   * The sandbox this run's previous step left behind, if any. Reusing it is what lets a step build
   * on the workspace an earlier step created; without it every step starts from an empty directory
   * and silently redoes the setup work of the one before it.
   */
  reuseSandboxId?: string;
};

export type CodingWorkerResult = {
  status: "completed" | "failed" | "blocked" | "needs_clarification" | "cancelled";
  summary: string;
  artifactReferences: ArtifactReference[];
  modelUsage: ModelUsage;
  actualModelRwf: number;
  commandsExecuted: number;
  /** How many times the planner was shown a failure and asked to fix it within this step. */
  repairs?: number;
  /** True when the step stopped early to stay inside `stepDeadlineMs`, rather than finishing. */
  stoppedForTime?: boolean;
  /** The sandbox left suspended for the next step, so the caller can hand it back or destroy it. */
  sandboxId?: string;
};

export type CodingWorkerDependencies = {
  model: CodingModelProvider;
  /** Interactive because capturing what a step produced means reading the workspace back out. */
  sandbox: InteractiveCodingSandboxProvider;
  artifacts: ArtifactStore;
  control: CodingWorkerControl;
  prices: ModelPriceCatalog;
};

const emptyUsage: ModelUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function artifact(request: CodingWorkerRequest, value: Omit<ArtifactWrite, "taskId" | "runId" | "stepId">): ArtifactWrite {
  return { taskId: request.taskId, runId: request.runId, stepId: request.stepId, ...value };
}

/**
 * Sandbox policy refusals, which never reach a shell and so have no exit code of their own. The
 * marker is outside the range a process can return, so it cannot be confused with one.
 */
const POLICY_REFUSED_EXIT_CODE = -2;

const POLICY_REFUSAL_PATTERNS = [
  /is not allowed in coding sandboxes/i,
  /blocked by the sandbox policy/i,
  /must stay inside \/workspace/i,
  /is not read-only/i,
  /Inline program evaluation is blocked/i,
  /must run a declared script or test/i,
  /exceed the sandbox policy/i,
  /Command timeout must be/i,
];

function isPolicyRefusal(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return POLICY_REFUSAL_PATTERNS.some((pattern) => pattern.test(message));
}

function commandRecord(index: number, command: { program: string; args: string[]; purpose: string }, result: SandboxCommandResult) {
  return {
    index,
    command: { program: command.program, args: command.args },
    purpose: command.purpose,
    exitCode: result.exitCode,
    stdout: truncateEvidence(result.stdout),
    stderr: truncateEvidence(result.stderr),
  };
}

export function estimateCodingPlanReservation(request: CodingPlanRequest, prices: ModelPriceCatalog): ModelCostEstimate {
  const prompt = buildCodingPlannerPrompt(request);
  return estimateModelCost([prompt.instructions, prompt.input], request.maxOutputTokens, prices);
}

/**
 * How many times a step may re-plan after a command fails. A failing command is usually a small,
 * self-inflicted mistake — a syntax error in a generated script, a wrong path, a tool that is not
 * installed — and the planner can fix it when it is shown the error. Bounded because a planner
 * that cannot fix something in two tries is not converging, and each attempt costs a real model
 * call. The budget check below stops earlier than this whenever the step's reservation runs out.
 */
export const MAX_REPAIR_ATTEMPTS = 2;

/**
 * Held back from the step's deadline so the work can always be captured.
 *
 * Evidence is written after the commands finish, so a step that spends its last second running a
 * command has produced files nobody can read — which is indistinguishable, from the outside, from
 * a step that produced nothing at all.
 */
const CAPTURE_RESERVE_MS = 45_000;

/** Below this there is no point starting another command; it would only be killed mid-run. */
const MINIMUM_COMMAND_MS = 5_000;

/**
 * Bounds on capturing the workspace. Generous for real work — a step writes a handful of files —
 * and strict enough that a runaway script cannot turn one step into megabytes of stored evidence.
 */
const MAX_CAPTURED_FILES = 40;
const MAX_CAPTURED_FILE_BYTES = 128_000;

/**
 * Directories that hold generated or vendored content rather than work. Capturing them buries the
 * few files a person actually wants under caches — a single pytest run contributed four
 * `.pytest_cache` entries to a two-file result before these were excluded.
 */
const UNCAPTURED_DIRECTORIES = [".git", "node_modules", ".pytest_cache", "__pycache__", ".venv", "venv", ".ruff_cache", ".mypy_cache", "dist", "build", ".next", "target"];

/** Executes a bounded model plan and guarantees sandbox cleanup on every path. */
export class CodingAgentWorker {
  constructor(private readonly dependencies: CodingWorkerDependencies) {}

  /**
   * Reads back the files a step produced. Enumerated from the sandbox rather than taken from the
   * plan's `fileChanges`, because much of what a step creates is written by the commands it runs,
   * not declared up front — a plan that writes one script which generates three files would
   * otherwise report one file and lose the rest.
   *
   * Never fails a step: this is evidence collection after the work is already done, and losing a
   * capture is much cheaper than losing the run that produced it.
   */
  private async captureWorkspace(request: CodingWorkerRequest, sandboxId: string): Promise<ArtifactWrite[]> {
    const captured: ArtifactWrite[] = [];
    try {
      const listing = await this.dependencies.sandbox.runCommand(sandboxId, {
        program: "find",
        args: [
          request.workspaceRoot,
          "-type",
          "f",
          ...UNCAPTURED_DIRECTORIES.flatMap((directory) => ["-not", "-path", `*/${directory}/*`]),
          "-size",
          "-256k",
        ],
        cwd: request.workspaceRoot,
        timeoutMs: 30_000,
      });
      if (listing.exitCode !== 0) return captured;
      const paths = listing.stdout.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, MAX_CAPTURED_FILES);
      for (const path of paths) {
        try {
          const content = await this.dependencies.sandbox.readFile(sandboxId, path);
          // Binary content would be unreadable in a viewer and pointless as text evidence.
          if (content.includes("\u0000")) continue;
          captured.push({
            taskId: request.taskId,
            runId: request.runId,
            stepId: request.stepId,
            kind: "workspace_file",
            mediaType: "text/plain",
            content: truncateEvidence(content, MAX_CAPTURED_FILE_BYTES),
            path: path.startsWith(request.workspaceRoot) ? path.slice(request.workspaceRoot.length).replace(/^\//, "") : path,
          });
        } catch {
          // One unreadable file must not cost the capture of the others.
        }
      }
    } catch {
      // The workspace could not be listed; the step's other evidence still stands.
    }
    return captured;
  }

  async execute(request: CodingWorkerRequest): Promise<CodingWorkerResult> {
    if (!request.runId.trim()) throw new Error("runId is required");
    if (!Number.isSafeInteger(request.modelReservationRwf) || request.modelReservationRwf < 0) throw new Error("modelReservationRwf must be a non-negative integer");
    if (!Number.isInteger(request.sandboxRuntimeSeconds) || request.sandboxRuntimeSeconds < 1 || request.sandboxRuntimeSeconds > 3_600) {
      throw new Error("sandboxRuntimeSeconds must be between 1 and 3600");
    }
    await this.dependencies.control.heartbeat(request.stepId);
    if (await this.dependencies.control.isCancellationRequested(request.runId)) {
      return { status: "cancelled", summary: "Run was cancelled before model execution.", artifactReferences: [], modelUsage: emptyUsage, actualModelRwf: 0, commandsExecuted: 0 };
    }

    // Measured from the moment the step starts working, so the model call spends the same budget
    // the commands do — it is the part most likely to run long.
    const startedAt = Date.now();
    const remainingMs = () => (request.stepDeadlineMs ?? Number.POSITIVE_INFINITY) - (Date.now() - startedAt);
    /** Time left for actual work, once the reserve that guarantees a capture is set aside. */
    const workingMs = () => remainingMs() - CAPTURE_RESERVE_MS;
    let stoppedForTime = false;

    let usage = { ...emptyUsage };
    const spend = (next: ModelUsage) => {
      usage = {
        inputTokens: usage.inputTokens + next.inputTokens,
        outputTokens: usage.outputTokens + next.outputTokens,
        totalTokens: usage.totalTokens + next.totalTokens,
        cachedInputTokens: usage.cachedInputTokens + next.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens + next.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens + next.reasoningTokens,
      };
      return priceActualModelUsage(usage.inputTokens, usage.outputTokens, this.dependencies.prices);
    };

    const modelResult = await this.dependencies.model.generateCodingPlan(request);
    let actualModelRwf = spend(modelResult.usage);
    if (actualModelRwf > request.modelReservationRwf) throw new Error("Actual model usage exceeds the reserved model budget");
    if (modelResult.status === "refused") {
      const evidence = await this.dependencies.artifacts.put(artifact(request, {
        kind: "review_summary", mediaType: "text/plain", content: modelResult.refusal ?? "Model refused the coding request.",
      }));
      return { status: "blocked", summary: modelResult.refusal ?? "Model refused the coding request.", artifactReferences: [evidence], modelUsage: usage, actualModelRwf, commandsExecuted: 0 };
    }

    let plan = CodingPlanSchema.parse(modelResult.plan);
    if (plan.commands.length > request.maxCommands) throw new Error("Model plan exceeds the requested command limit");
    let planArtifact = await this.dependencies.artifacts.put(artifact(request, {
      kind: "model_plan", mediaType: "application/json", content: JSON.stringify({ responseId: modelResult.responseId, model: modelResult.model, plan }, null, 2),
    }));
    if (plan.status !== "ready") {
      return {
        status: plan.status === "blocked" ? "blocked" : "needs_clarification",
        summary: plan.summary,
        artifactReferences: [planArtifact],
        modelUsage: usage,
        actualModelRwf,
        commandsExecuted: 0,
      };
    }
    if (await this.dependencies.control.isCancellationRequested(request.runId)) {
      return { status: "cancelled", summary: "Run was cancelled before sandbox creation.", artifactReferences: [planArtifact], modelUsage: usage, actualModelRwf, commandsExecuted: 0 };
    }

    // Resume the run's existing sandbox when there is one, and fall back to a fresh sandbox if it
    // has gone away. A sandbox that expired, was reaped, or was killed out from under us is a
    // reason to start clean — never a reason to fail work that has already been paid for.
    let session: SandboxSession;
    if (request.reuseSandboxId) {
      try {
        session = { sandboxId: request.reuseSandboxId, status: "running" };
        await this.dependencies.sandbox.runCommand(session.sandboxId, {
          program: "pwd",
          args: [],
          cwd: request.workspaceRoot,
          timeoutMs: 30_000,
        });
      } catch {
        session = await this.dependencies.sandbox.createSandbox({
          taskId: request.taskId,
          template: "coding",
          maxRuntimeSeconds: request.sandboxRuntimeSeconds,
        });
      }
    } else {
      session = await this.dependencies.sandbox.createSandbox({
        taskId: request.taskId,
        template: "coding",
        maxRuntimeSeconds: request.sandboxRuntimeSeconds,
      });
    }
    await this.dependencies.control.heartbeat(request.stepId, session.sandboxId);
    const evidence: ArtifactReference[] = [planArtifact];
    const commandLog: ReturnType<typeof commandRecord>[] = [];
    let commandsExecuted = 0;
    let failure: ReturnType<typeof commandRecord> | undefined;
    let cancelled = false;
    let failed = false;

    let repairs = 0;

    try {
      // Control-plane briefings (e.g. Wander Exa literature) land before the planner's writes so
      // scientists can treat them as notebook files without re-fetching from the sandbox.
      for (const seed of request.workspaceSeedFiles ?? []) {
        const path = seed.path.startsWith("/") ? seed.path : `${request.workspaceRoot}/${seed.path}`;
        await this.dependencies.sandbox.writeFile(session.sandboxId, path, seed.content);
      }
      // Attempt, then repair. A failed command is shown back to the planner, which produces a new
      // plan in the same workspace — the files the failed attempt wrote are still there, which is
      // what makes a fix possible rather than a fresh guess at the same objective.
      for (;;) {
        failed = false;
        failure = undefined;
        for (const change of plan.fileChanges) {
          await this.dependencies.sandbox.writeFile(session.sandboxId, change.path, change.content);
        }
        for (const [index, command] of plan.commands.entries()) {
          if (await this.dependencies.control.isCancellationRequested(request.runId)) {
            cancelled = true;
            break;
          }
          // Stop of our own accord while there is still time to save the work. The alternative is
          // the host killing the step mid-command, which loses every file it had already written.
          if (workingMs() < MINIMUM_COMMAND_MS) {
            stoppedForTime = true;
            break;
          }
          await this.dependencies.control.heartbeat(request.stepId, session.sandboxId);
          // A command the policy refuses is a mistake the planner can fix, not an infrastructure
          // failure. Refusals are thrown rather than returned, so without this they escape the
          // repair loop entirely and kill the run — which is exactly how a step died on
          // "Git command is not read-only" after the planner had already been told the rule.
          let result: SandboxCommandResult;
          try {
            result = await this.dependencies.sandbox.runCommand(session.sandboxId, {
              program: command.program,
              args: command.args,
              cwd: command.cwd ?? undefined,
              // A plan may ask for up to fifteen minutes per command, which alone outlives the
              // step. Clamping keeps a single long command from consuming the whole budget.
              timeoutMs: Math.max(MINIMUM_COMMAND_MS, Math.min(command.timeoutMs, workingMs())),
            });
          } catch (error) {
            if (!isPolicyRefusal(error)) throw error;
            result = { exitCode: POLICY_REFUSED_EXIT_CODE, stdout: "", stderr: `This command was refused before it ran: ${error instanceof Error ? error.message : "not permitted"}` };
          }
          commandsExecuted += 1;
          const record = commandRecord(commandLog.length, command, result);
          commandLog.push(record);
          if (result.exitCode !== 0) {
            failed = true;
            // Kept so the step summary can name what failed, and so the next attempt can be shown
            // the actual error rather than being asked to guess.
            failure = record;
            break;
          }
        }

        if (!failed || cancelled || repairs >= MAX_REPAIR_ATTEMPTS) break;

        // A repair is a fresh model call plus another pass of commands. Starting one that cannot
        // finish spends real money to produce a plan the step will never get to run.
        if (workingMs() < request.timeoutMs + MINIMUM_COMMAND_MS) {
          stoppedForTime = true;
          break;
        }

        // Only re-plan while the step's own reservation still covers another call. Spending past
        // it would break the guarantee that a step never exceeds what was reserved for it.
        const estimate = estimateCodingPlanReservation(request, this.dependencies.prices).maximumRwf;
        if (actualModelRwf + estimate > request.modelReservationRwf) break;

        repairs += 1;
        const repaired = await this.dependencies.model.generateCodingPlan({
          ...request,
          previousFailure: {
            intent: failure?.purpose ?? plan.summary,
            command: [failure?.command.program, ...(failure?.command.args ?? [])].join(" "),
            exitCode: failure?.exitCode ?? 1,
            output: (failure?.stderr?.trim() || failure?.stdout?.trim() || "").slice(0, 4_000),
          },
        });
        actualModelRwf = spend(repaired.usage);
        if (actualModelRwf > request.modelReservationRwf) throw new Error("Actual model usage exceeds the reserved model budget");
        if (repaired.status === "refused") break;
        const nextPlan = CodingPlanSchema.parse(repaired.plan);
        if (nextPlan.commands.length > request.maxCommands) throw new Error("Model plan exceeds the requested command limit");
        planArtifact = await this.dependencies.artifacts.put(artifact(request, {
          kind: "model_plan", mediaType: "application/json", content: JSON.stringify({ responseId: repaired.responseId, model: repaired.model, repairOf: failure?.command, plan: nextPlan }, null, 2),
        }));
        evidence.push(planArtifact);
        // A planner that concludes the objective cannot be met keeps that verdict; it is an answer,
        // not a failure to retry.
        if (nextPlan.status !== "ready") break;
        plan = nextPlan;
      }

      if (!cancelled) {
        const diff = await this.dependencies.sandbox.runCommand(session.sandboxId, {
          program: "git",
          args: ["diff", "--no-ext-diff", "--binary"],
          cwd: request.workspaceRoot,
          timeoutMs: 30_000,
        });
        if (diff.exitCode === 0 && diff.stdout.trim()) {
          evidence.push(await this.dependencies.artifacts.put(artifact(request, {
            kind: "patch", mediaType: "text/x-diff", content: truncateEvidence(diff.stdout, 1_500_000),
          })));
        }
      }
      evidence.push(await this.dependencies.artifacts.put(artifact(request, {
        kind: "command_log",
        mediaType: "application/json",
        content: JSON.stringify(commandLog, null, 2),
      })));

      // The work itself, captured before the sandbox is suspended. Everything else here describes
      // what happened; this is what was actually produced, and it is the only evidence that would
      // otherwise exist solely inside a workspace nobody can open.
      const captured = await this.captureWorkspace(request, session.sandboxId);
      for (const file of captured) {
        evidence.push(await this.dependencies.artifacts.put(artifact(request, file)));
      }

      // Wander harvest: assemble a print-ready HTML report from the lab notebook once the step
      // succeeds. Built on the control plane (not by the model) so the deliverable is reliable.
      if (!cancelled && !failed && isWanderObjective(request.objective)) {
        const evidenceFallback = request.workspaceSeedFiles?.find((seed) => seed.path.endsWith("EVIDENCE.md"))?.content;
        const report = assembleWanderReport({ objective: request.objective, files: captured, evidenceFallback });
        if (report) {
          const reportPath = `${request.workspaceRoot}/${report.path}`;
          try {
            await this.dependencies.sandbox.writeFile(session.sandboxId, reportPath, report.html);
          } catch {
            // Capture still succeeds even if writing back into a suspending sandbox fails.
          }
          evidence.push(await this.dependencies.artifacts.put(artifact(request, {
            kind: "workspace_file",
            mediaType: "text/html",
            path: report.path,
            content: report.html,
          })));
        }
      }
    } finally {
      // Suspended, not destroyed: the next step of this run continues in this workspace. The run's
      // terminal transition is what destroys it (convex/agentRuns.ts), with a reaper behind that
      // for workers that never get to say anything at all.
      await this.dependencies.sandbox.suspendSandbox(session.sandboxId);
    }

    return {
      status: cancelled ? "cancelled" : failed ? "failed" : "completed",
      stoppedForTime,
      summary: cancelled
        ? "Run cancelled at a safe checkpoint."
        : stoppedForTime && !failed
          ? `Stopped at the step's ${Math.round((request.stepDeadlineMs ?? 0) / 60_000)}-minute time budget with ${commandsExecuted} command(s) run; everything produced up to that point was captured.`
        : failure
          ? summarizeCommandFailure({ ...failure.command, purpose: failure.purpose, exitCode: failure.exitCode, stdout: failure.stdout, stderr: failure.stderr })
          : failed
            ? "A verification command failed."
            : plan.summary,
      artifactReferences: evidence,
      modelUsage: usage,
      actualModelRwf,
      commandsExecuted,
      repairs,
      sandboxId: session.sandboxId,
    };
  }
}
