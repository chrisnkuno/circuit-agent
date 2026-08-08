import { describe, expect, it } from "vitest";
import { describeArtifact, type ArtifactStore, type ArtifactWrite } from "./artifacts";
import { CodingAgentWorker, estimateCodingPlanReservation, MAX_REPAIR_ATTEMPTS } from "./coding-worker";
import type { InteractiveCodingSandboxProvider, SandboxCommand } from "../packages/agent-core/src/providers/contracts";
import type { CodingModelProvider, CodingPlanRequest, CodingPlanResult } from "../packages/agent-core/src/providers/model";
import { buildWanderObjective } from "../packages/agent-core/src/wander";
import { WANDER_REPORT_PATH } from "./wander-report";

const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
const usage = { inputTokens: 1_000, outputTokens: 500, totalTokens: 1_500, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 100 };
const baseRequest = {
  taskId: "task_1",
  runId: "run_1",
  stepId: "step_1",
  objective: "Fix the failing test",
  repositoryContext: "TypeScript repository",
  workspaceRoot: "/workspace/repo",
  maxCommands: 4,
  maxOutputTokens: 2_000,
  timeoutMs: 30_000,
  reasoningEffort: "medium" as const,
  safetyIdentifier: "user_hash_1",
  sandboxRuntimeSeconds: 120,
  modelReservationRwf: 100,
};

function setup(options: { slowCommandMs?: number; recordTimeouts?: number[]; commandExitCode?: number; cancelledAfterChecks?: number; usageOverride?: typeof usage; reuseUnreachable?: boolean; succeedAfterRepairs?: number; repairStatus?: "blocked"; policyRefusal?: boolean; captureUnavailable?: boolean; wanderLab?: boolean } = {}) {
  const calls: string[] = [];
  const writes: ArtifactWrite[] = [];
  let cancellationChecks = 0;
  const result: CodingPlanResult = {
    status: "planned",
    responseId: "resp_1",
    model: "gpt-5.6-terra",
    usage: options.usageOverride ?? usage,
    plan: {
      status: "ready",
      summary: "Updated the implementation and ran tests.",
      fileChanges: [{ path: "/workspace/repo/src/value.ts", content: "export const value = 2;", reason: "Fix value" }],
      commands: [
        { program: "bun", args: ["test"], cwd: "/workspace/repo", timeoutMs: 60_000, purpose: "Run tests" },
        { program: "bun", args: ["run", "typecheck"], cwd: "/workspace/repo", timeoutMs: 60_000, purpose: "Typecheck" },
      ],
      expectedArtifacts: ["model_plan", "command_log", "patch", "test_log"],
      blockers: [],
    },
  };
  const modelRequests: CodingPlanRequest[] = [];
  let modelCalls = 0;
  const model: CodingModelProvider = {
    generateCodingPlan: async (planRequest: CodingPlanRequest) => {
      calls.push("model");
      modelRequests.push(planRequest);
      modelCalls += 1;
      if (modelCalls > 1 && options.repairStatus === "blocked") {
        return { ...result, plan: { ...result.plan!, status: "blocked" as const } };
      }
      return result;
    },
  };
  const sandbox: InteractiveCodingSandboxProvider = {
    createSandbox: async () => { calls.push("create"); return { sandboxId: "sandbox_1", status: "created" }; },
    writeFile: async () => { calls.push("write"); },
    readFile: async (_sandboxId: string, path: string) => {
      calls.push("read");
      if (options.wanderLab && path.includes("CONSENSUS.md")) return "# Role: Consensus Editor\n\nverified strong_plausible speculative\n";
      if (options.wanderLab && path.includes("EVIDENCE.md")) return "# Literature briefing\n\nhttps://example.com/a\n";
      if (options.wanderLab && path.includes("HYPOTHESES.md")) return "# Role: Principal investigator\n\nHypothesis\n";
      if (options.wanderLab && path.includes("REVIEW_METHODS.md")) return "# Role: Methodologist\n\nCritique\n";
      if (options.wanderLab && path.includes("REVIEW_RIVAL.md")) return "# Role: Rival theorist\n\nAlt\n";
      return `contents of ${path}`;
    },
    runCommand: async (sandboxId: string, command: SandboxCommand) => {
      calls.push(`run:${command.program}:${command.args[0] ?? ""}`);
      if (options.recordTimeouts && command.program === "bun") options.recordTimeouts.push(command.timeoutMs);
      if (options.slowCommandMs && command.program === "bun") await new Promise((resolve) => setTimeout(resolve, options.slowCommandMs));
      if (options.reuseUnreachable && sandboxId === "sandbox_gone") throw new Error("sandbox not found");
      if (command.program === "git") return { exitCode: 0, stdout: "diff --git a/src/value.ts b/src/value.ts", stderr: "" };
      if (command.program === "find") {
        if (options.captureUnavailable) throw new Error("workspace listing unavailable");
        if (options.wanderLab) {
          return {
            exitCode: 0,
            stdout: [
              "/workspace/repo/wander/EVIDENCE.md",
              "/workspace/repo/wander/HYPOTHESES.md",
              "/workspace/repo/wander/REVIEW_METHODS.md",
              "/workspace/repo/wander/REVIEW_RIVAL.md",
              "/workspace/repo/wander/CONSENSUS.md",
            ].join("\n") + "\n",
            stderr: "",
          };
        }
        return { exitCode: 0, stdout: "/workspace/repo/main.py\n/workspace/repo/test_main.py\n", stderr: "" };
      }
      if (options.policyRefusal && command.program === "bun") throw new Error("Git command is not read-only");
      if (options.succeedAfterRepairs !== undefined) {
        // Fails until the planner has been shown the error the configured number of times.
        const attempt = calls.filter((call) => call === "model").length - 1;
        if (attempt >= options.succeedAfterRepairs) return { exitCode: 0, stdout: "ok", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "SyntaxError: unterminated string literal" };
      }
      return { exitCode: options.commandExitCode ?? 0, stdout: "ok", stderr: options.commandExitCode ? "failed" : "" };
    },
    stopSandbox: async () => { calls.push("stop"); },
    suspendSandbox: async () => { calls.push("suspend"); },
  };
  const artifacts: ArtifactStore = {
    put: async (value) => { writes.push(value); return describeArtifact(value, "test-artifact"); },
  };
  const control = {
    heartbeat: async () => { calls.push("heartbeat"); },
    isCancellationRequested: async () => {
      cancellationChecks += 1;
      return options.cancelledAfterChecks !== undefined && cancellationChecks >= options.cancelledAfterChecks;
    },
  };
  return { worker: new CodingAgentWorker({ model, sandbox, artifacts, control, prices }), sandbox, artifacts, control, calls, writes, modelRequests };
}

describe("coding agent worker", () => {
  it("harvests a print-ready Wander REPORT.html after a successful lab step", async () => {
    const test = setup({ wanderLab: true });
    const objective = buildWanderObjective("sleep and memory");
    const result = await test.worker.execute({
      ...baseRequest,
      objective,
      maxCommands: 8,
      workspaceSeedFiles: [{ path: "wander/EVIDENCE.md", content: "# Literature briefing\n" }],
    });
    expect(result.status).toBe("completed");
    const report = test.writes.find((write) => write.path === WANDER_REPORT_PATH);
    expect(report?.mediaType).toBe("text/html");
    expect(report?.content).toContain("Wander lab report");
    expect(report?.content).toContain("Consensus");
  });

  it("writes model changes, runs bounded checks, captures evidence, and always releases the sandbox", async () => {
    const test = setup();
    const result = await test.worker.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", actualModelRwf: 6, commandsExecuted: 2 });
    // The files the step produced are captured alongside the record of what it did.
    expect(result.artifactReferences.map((artifact) => artifact.kind)).toEqual(["model_plan", "patch", "command_log", "workspace_file", "workspace_file"]);
    expect(test.calls).toContain("write");
    // Suspended rather than destroyed, and the id handed back, so the next step of this run
    // continues in the same workspace instead of an empty one.
    expect(test.calls.at(-1)).toBe("suspend");
    expect(test.calls).not.toContain("stop");
    expect(result.sandboxId).toBe("sandbox_1");
  });

  it("stops after a failed check and returns honest failure evidence", async () => {
    const test = setup({ commandExitCode: 1 });
    const result = await test.worker.execute(baseRequest);
    // One first attempt plus MAX_REPAIR_ATTEMPTS repairs, each shown the previous error.
    expect(result).toMatchObject({ status: "failed", repairs: MAX_REPAIR_ATTEMPTS });
    expect(test.calls.filter((call) => call === "model")).toHaveLength(1 + MAX_REPAIR_ATTEMPTS);
    expect(test.calls.at(-1)).toBe("suspend");
  });

  it("honors cancellation checkpoints and still releases the sandbox", async () => {
    const test = setup({ cancelledAfterChecks: 3 });
    const result = await test.worker.execute(baseRequest);
    expect(result.status).toBe("cancelled");
    expect(test.calls.at(-1)).toBe("suspend");
  });

  it("continues in the sandbox the previous step left, instead of creating another", async () => {
    const test = setup();
    const result = await test.worker.execute({ ...baseRequest, reuseSandboxId: "sandbox_prev" });
    expect(test.calls).not.toContain("create");
    expect(result.sandboxId).toBe("sandbox_prev");
  });

  it("starts clean when the previous sandbox is gone rather than failing paid-for work", async () => {
    const test = setup({ reuseUnreachable: true });
    const result = await test.worker.execute({ ...baseRequest, reuseSandboxId: "sandbox_gone" });
    expect(test.calls).toContain("create");
    expect(result.sandboxId).toBe("sandbox_1");
    expect(result.status).toBe("completed");
  });

  it("blocks execution when actual model usage exceeds its reservation", async () => {
    const test = setup({ usageOverride: { ...usage, outputTokens: 50_000, totalTokens: 51_000 } });
    await expect(test.worker.execute({ ...baseRequest, modelReservationRwf: 1 })).rejects.toThrow("reserved model budget");
    expect(test.calls).not.toContain("create");
  });

  it("turns model refusals into evidence-backed blockers without creating E2B", async () => {
    const test = setup();
    const refusingModel: CodingModelProvider = {
      generateCodingPlan: async () => ({ status: "refused", refusal: "Repository access is not authorized.", responseId: "resp_refused", model: "gpt-5.6-terra", usage }),
    };
    const worker = new CodingAgentWorker({ model: refusingModel, sandbox: test.sandbox, artifacts: test.artifacts, control: test.control, prices });
    const result = await worker.execute(baseRequest);
    expect(result).toMatchObject({ status: "blocked", commandsExecuted: 0 });
    expect(test.calls).not.toContain("create");
  });

  it("produces a conservative preflight model reservation", () => {
    const estimate = estimateCodingPlanReservation(baseRequest, prices);
    expect(estimate.maximumRwf).toBeGreaterThanOrEqual(estimate.expectedRwf);
    expect(estimate.maximumInputTokens).toBeGreaterThan(estimate.expectedInputTokens);
  });
});

describe("repairing a failed step in place", () => {
  it("shows the planner the command that failed and its output, not just that something failed", async () => {
    const test = setup({ commandExitCode: 1 });
    await test.worker.execute(baseRequest);
    const repair = test.modelRequests[1];
    expect(repair.previousFailure).toBeDefined();
    expect(repair.previousFailure?.command).toContain("bun");
    expect(repair.previousFailure?.exitCode).toBe(1);
    expect(repair.previousFailure?.output).toContain("failed");
    // The first attempt is not a repair and must not claim to be one.
    expect(test.modelRequests[0].previousFailure).toBeUndefined();
  });

  it("completes the step when the repair works", async () => {
    const test = setup({ succeedAfterRepairs: 1 });
    const result = await test.worker.execute(baseRequest);
    expect(result.status).toBe("completed");
    expect(result.repairs).toBe(1);
  });

  it("repairs in the same sandbox, so the fix can build on what the failed attempt wrote", async () => {
    const test = setup({ succeedAfterRepairs: 1 });
    await test.worker.execute(baseRequest);
    expect(test.calls.filter((call) => call === "create")).toHaveLength(1);
  });

  it("stops when the reservation cannot cover another attempt, rather than overspending", async () => {
    // Enough for the first call, not for a second.
    const test = setup({ commandExitCode: 1 });
    const result = await test.worker.execute({ ...baseRequest, modelReservationRwf: 7 });
    expect(result.repairs).toBe(0);
    expect(test.calls.filter((call) => call === "model")).toHaveLength(1);
  });

  it("lets the planner fix a command the policy refused, instead of killing the run", async () => {
    // Refusals are thrown before a shell ever sees the command, so they used to escape the repair
    // loop and fail the run outright — the exact way a step died on "Git command is not read-only".
    const test = setup({ policyRefusal: true });
    const result = await test.worker.execute(baseRequest);
    expect(test.calls.filter((call) => call === "model").length).toBeGreaterThan(1);
    const repair = test.modelRequests[1];
    expect(repair.previousFailure?.output).toContain("refused before it ran");
    expect(result.status).toBe("failed");
  });

  it("keeps a blocked verdict from a repair instead of retrying it", async () => {
    const test = setup({ commandExitCode: 1, repairStatus: "blocked" });
    const result = await test.worker.execute(baseRequest);
    expect(result.repairs).toBe(1);
    expect(test.calls.filter((call) => call === "model")).toHaveLength(2);
  });
});

describe("capturing what a step produced", () => {
  it("stores each workspace file with its content and a workspace-relative path", async () => {
    const test = setup();
    await test.worker.execute(baseRequest);
    const files = test.writes.filter((write) => write.kind === "workspace_file");
    expect(files.map((file) => file.path)).toEqual(["main.py", "test_main.py"]);
    // The content, not a hash of it — the whole point is that it can be read back later.
    expect(files[0].content).toContain("contents of /workspace/repo/main.py");
  });

  it("enumerates the sandbox rather than trusting the plan's declared file changes", async () => {
    // A plan that writes one script which generates three files would otherwise report one file.
    const test = setup();
    await test.worker.execute(baseRequest);
    expect(test.calls).toContain("run:find:/workspace/repo");
    const files = test.writes.filter((write) => write.kind === "workspace_file");
    expect(files.length).toBeGreaterThan(0);
  });

  it("stops inside its time budget and still captures the work already produced", async () => {
    const { worker, writes, calls } = setup({ slowCommandMs: 1_000 });
    // Room for one command past the capture reserve; the second would start with too little left.
    const result = await worker.execute({ ...baseRequest, stepDeadlineMs: 45_000 + 5_500 });

    expect(result.stoppedForTime).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.commandsExecuted).toBe(1);
    expect(result.summary).toContain("time budget");
    // The point of stopping early: evidence still exists.
    expect(writes.some((write) => write.kind === "workspace_file")).toBe(true);
    expect(calls).toContain("suspend");
  });

  it("clamps a command that asks for longer than the step has left", async () => {
    const seen: number[] = [];
    const { worker } = setup({ recordTimeouts: seen });
    await worker.execute({ ...baseRequest, stepDeadlineMs: 60_000 });
    // Plan asks for 60s per command; only ~15s of working time exists after the capture reserve.
    expect(seen[0]).toBeLessThan(60_000);
    expect(seen[0]).toBeGreaterThan(0);
  });

  it("runs unbounded when no deadline is given, so existing callers are unaffected", async () => {
    const { worker } = setup({});
    const result = await worker.execute(baseRequest);
    expect(result.stoppedForTime).toBe(false);
    expect(result.commandsExecuted).toBe(2);
  });

  it("never lets a failed capture cost the step its result", async () => {
    const test = setup({ captureUnavailable: true });
    const result = await test.worker.execute(baseRequest);
    expect(result.status).toBe("completed");
    expect(test.writes.some((write) => write.kind === "workspace_file")).toBe(false);
  });
});
