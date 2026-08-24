import { describe, expect, it } from "vitest";
import { describeArtifact, type ArtifactWrite } from "./artifacts";
import { IterativeCodingAgentWorker } from "./iterative-coding-worker";
import type { InteractiveCodingSandboxProvider } from "@circuit-nova/nova-core/providers/contracts";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function request() {
  return {
    taskId: "task", runId: "run", stepId: "step", objective: "Inspect and report", systemPrompt: "Use bounded tools.",
    allowedCapabilityIds: ["workspace.files"], maxIterations: 2, maxToolCalls: 2, maxToolCallsPerTurn: 2,
    maxToolResultChars: 1_000, maxTotalToolResultChars: 2_000, maxOutputTokens: 1_000, modelReservationRwf: 10,
    safetyIdentifier: "org", sandboxRuntimeSeconds: 60,
  };
}

describe("iterative coding worker", () => {
  it("runs the composed loop, records evidence, and always terminates E2B", async () => {
    const calls: string[] = [];
    const writes: ArtifactWrite[] = [];
    const sandbox: InteractiveCodingSandboxProvider = {
      async createSandbox() { calls.push("create"); return { sandboxId: "box", status: "created" }; },
      async stopSandbox() { calls.push("stop"); }, async suspendSandbox() {},
      async readFile() { return "workspace"; },
      async writeFile(_id, path) { calls.push(`write:${path}`); },
      async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; },
    };
    const worker = new IterativeCodingAgentWorker({
      sandbox,
      prices: { inputRwfPerMillionTokens: 1_610, outputRwfPerMillionTokens: 9_660 },
      model: { async complete() { return { responseId: "response", model: "luna", finishReason: "stop", content: "Inspected.", toolCalls: [], usage }; } },
      artifacts: { async put(value) { writes.push(value); return describeArtifact(value, "test"); } },
      control: { async heartbeat() {}, async isCancellationRequested() { return false; }, async isToolCallApproved() { return true; }, async persistRuntimeEvent() {} },
    });
    const result = await worker.execute(request());
    expect(result).toMatchObject({ status: "completed", iterations: 1, toolCallsExecuted: 0 });
    expect(result.artifactReferences).toHaveLength(2);
    expect(writes.map((item) => item.kind)).toEqual(["command_log", "review_summary"]);
    expect(calls).toEqual(["create", "write:/workspace/repo/.circuit-nova-workspace", "stop"]);
  });

  it("terminates the sandbox when the model fails", async () => {
    let stopped = false;
    const sandbox: InteractiveCodingSandboxProvider = {
      async createSandbox() { return { sandboxId: "box", status: "created" }; }, async stopSandbox() { stopped = true; }, async suspendSandbox() {},
      async readFile() { return ""; }, async writeFile() {}, async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; },
    };
    const worker = new IterativeCodingAgentWorker({
      sandbox, prices: { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
      model: { async complete() { throw new Error("provider down"); } },
      artifacts: { async put(value) { return describeArtifact(value); } },
      control: { async heartbeat() {}, async isCancellationRequested() { return false; }, async isToolCallApproved() { return true; }, async persistRuntimeEvent() {} },
    });
    await expect(worker.execute(request())).rejects.toThrow("provider down");
    expect(stopped).toBe(true);
  });

  it("composes recalled skill guidance into the system prompt the model actually receives", async () => {
    const receivedPrompts: string[] = [];
    const sandbox: InteractiveCodingSandboxProvider = {
      async createSandbox() { return { sandboxId: "box", status: "created" }; }, async stopSandbox() {}, async suspendSandbox() {},
      async readFile() { return ""; }, async writeFile() {}, async runCommand() { return { exitCode: 0, stdout: "", stderr: "" }; },
    };
    const worker = new IterativeCodingAgentWorker({
      sandbox, prices: { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
      model: {
        async complete(modelRequest) {
          receivedPrompts.push(modelRequest.messages[0].content);
          return { responseId: "response", model: "luna", finishReason: "stop", content: "Inspected.", toolCalls: [], usage };
        },
      },
      artifacts: { async put(value) { return describeArtifact(value, "test"); } },
      control: { async heartbeat() {}, async isCancellationRequested() { return false; }, async isToolCallApproved() { return true; }, async persistRuntimeEvent() {} },
    });
    await worker.execute({
      ...request(),
      skills: [{ slug: "example-skill", title: "Example skill", taskKind: "coding", proceduralSummary: "Do the example thing carefully and verify it.", sourceRunId: "run_1", sourceObjective: "example objective", version: 1, status: "approved" }],
    });
    expect(receivedPrompts[0]).toContain("Use bounded tools.");
    expect(receivedPrompts[0]).toContain("Example skill");
    expect(receivedPrompts[0]).toContain("cannot grant a tool, permission, budget, or approval");
  });
});
