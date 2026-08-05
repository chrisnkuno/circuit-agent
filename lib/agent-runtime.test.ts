import { describe, expect, it } from "vitest";
import { BoundedAgentRuntime, type AgentModelTurn, type AgentRuntimeEvent, type AgentTool } from "./agent-runtime";

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const prices = { inputRwfPerMillionTokens: 1_610, outputRwfPerMillionTokens: 9_660 };

function harness(turns: AgentModelTurn[], tools: AgentTool[], approved = true) {
  const events: AgentRuntimeEvent[] = [];
  let modelCalls = 0;
  const runtime = new BoundedAgentRuntime({
    model: { async complete() { const turn = turns[modelCalls++]; if (!turn) throw new Error("Unexpected model call"); return turn; } },
    tools,
    prices,
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return approved; },
      async persistEvent(event) { events.push(event); },
    },
  });
  return { runtime, events, executed: () => modelCalls };
}

const baseRequest = {
  taskId: "task-1", runId: "run-1", stepId: "step-1", objective: "Fix and verify the project", systemPrompt: "You are a bounded coding agent.",
  allowedCapabilityIds: ["workspace.files", "workspace.terminal"], maxIterations: 6, maxToolCalls: 8, maxToolCallsPerTurn: 4,
  maxToolResultChars: 2_000, maxTotalToolResultChars: 8_000, maxOutputTokens: 2_000, modelReservationRwf: 100, safetyIdentifier: "org-1",
};

function turn(overrides: Partial<AgentModelTurn>): AgentModelTurn {
  return { responseId: crypto.randomUUID(), model: "gpt-5.6-luna", finishReason: "stop", content: "Done", toolCalls: [], usage, ...overrides };
}

describe("bounded agent runtime", () => {
  it("runs a multi-turn coding loop and requires real verification after edits", async () => {
    const calls: string[] = [];
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write a file", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { calls.push("write"); return { content: "written" }; } },
      { name: "run_tests", description: "Run tests", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { calls.push("test"); return { content: "tests passed", verification: { passed: true, scope: "targeted", summary: "unit tests" } }; } },
    ];
    const harnessValue = harness([
      turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "a.ts" } }] }),
      turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "call-2", name: "run_tests", arguments: {} }] }),
      turn({ content: "Implemented and verified." }),
    ], tools);
    const result = await harnessValue.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", iterations: 3, toolCallsExecuted: 2, actualModelRwf: 2 });
    expect(calls).toEqual(["write", "test"]);
    expect(harnessValue.events.map((event) => event.type)).toEqual(["model_turn", "tool_result", "model_turn", "tool_result", "model_turn", "runtime_stop"]);
  });

  it("does not claim completion when workspace changes lack verification", async () => {
    const tool: AgentTool = { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { return { content: "written" }; } };
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "write-1", name: "write_file", arguments: {} }] }),
      turn({ content: "Done" }),
    ], [tool]);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "needs_verification", toolCallsExecuted: 1 });
  });

  it("halts before an unapproved external action", async () => {
    let executed = false;
    const tool: AgentTool = { name: "send_message", description: "Send", inputSchema: {}, capabilityId: "operations.execute", effect: "external", requiresApproval: true, parallelSafe: false, async execute() { executed = true; return { content: "sent" }; } };
    const value = harness([turn({ finishReason: "tool_calls", toolCalls: [{ id: "send-1", name: "send_message", arguments: {} }] })], [tool], false);
    const result = await value.runtime.execute({ ...baseRequest, allowedCapabilityIds: ["operations.execute"] });
    expect(result.status).toBe("needs_approval");
    expect(executed).toBe(false);
  });

  it("fails closed when the model reaches outside its capability scope", async () => {
    const value = harness([turn({ finishReason: "tool_calls", toolCalls: [{ id: "bad-1", name: "unknown_tool", arguments: {} }] })], []);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "failed", toolCallsExecuted: 0 });
  });

  it("runs only explicitly safe read tools concurrently", async () => {
    let active = 0;
    let peak = 0;
    const makeTool = (name: string): AgentTool => ({ name, description: name, inputSchema: {}, capabilityId: "workspace.files", effect: "none", requiresApproval: false, parallelSafe: true, async execute() { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return { content: name }; } });
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "r1", name: "read_a", arguments: {} }, { id: "r2", name: "read_b", arguments: {} }] }),
      turn({ content: "Read both" }),
    ], [makeTool("read_a"), makeTool("read_b")]);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "completed", toolCallsExecuted: 2 });
    expect(peak).toBe(2);
  });
});
