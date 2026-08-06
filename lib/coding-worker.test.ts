import { describe, expect, it } from "vitest";
import { describeArtifact, type ArtifactStore, type ArtifactWrite } from "./artifacts";
import { CodingAgentWorker, estimateCodingPlanReservation } from "./coding-worker";
import type { CodingSandboxProvider, SandboxCommand } from "./providers/contracts";
import type { CodingModelProvider, CodingPlanResult } from "./providers/model";

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

function setup(options: { commandExitCode?: number; cancelledAfterChecks?: number; usageOverride?: typeof usage; reuseUnreachable?: boolean } = {}) {
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
  const model: CodingModelProvider = { generateCodingPlan: async () => { calls.push("model"); return result; } };
  const sandbox: CodingSandboxProvider = {
    createSandbox: async () => { calls.push("create"); return { sandboxId: "sandbox_1", status: "created" }; },
    writeFile: async () => { calls.push("write"); },
    runCommand: async (sandboxId: string, command: SandboxCommand) => {
      calls.push(`run:${command.program}:${command.args[0] ?? ""}`);
      if (options.reuseUnreachable && sandboxId === "sandbox_gone") throw new Error("sandbox not found");
      if (command.program === "git") return { exitCode: 0, stdout: "diff --git a/src/value.ts b/src/value.ts", stderr: "" };
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
  return { worker: new CodingAgentWorker({ model, sandbox, artifacts, control, prices }), sandbox, artifacts, control, calls, writes };
}

describe("coding agent worker", () => {
  it("writes model changes, runs bounded checks, captures evidence, and always releases the sandbox", async () => {
    const test = setup();
    const result = await test.worker.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", actualModelRwf: 6, commandsExecuted: 2 });
    expect(result.artifactReferences.map((artifact) => artifact.kind)).toEqual(["model_plan", "patch", "command_log"]);
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
    expect(result).toMatchObject({ status: "failed", commandsExecuted: 1 });
    expect(test.calls.filter((call) => call.startsWith("run:bun"))).toHaveLength(1);
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
