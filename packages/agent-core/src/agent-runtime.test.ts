import { beforeEach, describe, expect, it } from "vitest";
import { BoundedAgentRuntime, type AgentModelRequest, type AgentModelTurn, type AgentRuntimeEvent, type AgentTool, type ToolResultArtifactStore } from "./agent-runtime";

const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
const prices = { inputRwfPerMillionTokens: 1_610, outputRwfPerMillionTokens: 9_660 };

function harness(turns: AgentModelTurn[], tools: AgentTool[], approved = true, artifacts?: ToolResultArtifactStore) {
  const events: AgentRuntimeEvent[] = [];
  const requests: AgentModelRequest[] = [];
  let modelCalls = 0;
  const runtime = new BoundedAgentRuntime({
    model: { async complete(request) { requests.push(request); const turn = turns[modelCalls++]; if (!turn) throw new Error("Unexpected model call"); return turn; } },
    tools,
    prices,
    ...(artifacts ? { artifacts } : {}),
    control: {
      async heartbeat() {},
      async isCancellationRequested() { return false; },
      async isToolCallApproved() { return approved; },
      async persistEvent(event) { events.push(event); },
    },
  });
  return { runtime, events, requests, executed: () => modelCalls };
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
  it("preserves native structured history and refuses orphaned tool results", async () => {
    const value = harness([turn({ finishReason: "stop", content: "continued" })], []);
    const history = [
      { role: "user" as const, content: "read it" },
      { role: "assistant" as const, content: "", toolCalls: [{ id: "old_1", name: "read_file", arguments: { path: "a.ts" } }] },
      { role: "tool" as const, content: "contents", toolCallId: "old_1", name: "read_file" },
      { role: "assistant" as const, content: "I read it." },
    ];
    await value.runtime.execute({ ...baseRequest, history, objective: "continue" });
    expect(value.requests[0].messages.slice(1, -1)).toEqual(history);

    await expect(value.runtime.execute({
      ...baseRequest,
      history: [{ role: "tool", content: "orphan", toolCallId: "missing", name: "read_file" }],
    })).rejects.toThrow(/orphaned tool result/);
  });
  it("does not contact the model when the approved reservation cannot cover a conservative request", async () => {
    const value = harness([turn({ content: "should never be reached" })], []);
    const result = await value.runtime.execute({ ...baseRequest, modelReservationRwf: 0 });
    expect(result).toMatchObject({ status: "iteration_limit", iterations: 0, actualModelRwf: 0 });
    expect(result.summary).toContain("approved model budget");
    expect(value.executed()).toBe(0);
  });

  it("runs a multi-turn coding loop and requires real verification after edits", async () => {
    const calls: string[] = [];
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write a file", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { calls.push("write"); return { content: "written" }; } },
      { name: "run_tests", description: "Run tests", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { calls.push("test"); return { content: "tests passed", verification: { passed: true, kind: "tests", scope: "targeted", summary: "unit tests" } }; } },
    ];
    const harnessValue = harness([
      turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "call-1", name: "write_file", arguments: { path: "a.ts" } }] }),
      turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "call-2", name: "run_tests", arguments: {} }] }),
      turn({ content: "Implemented and verified." }),
      // Unit tests alone now draw one ask for an exercise of the assembled program; answering it
      // is what ends the run.
      turn({ content: "This is a pure function with no entry point to assemble." }),
    ], tools);
    const result = await harnessValue.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", iterations: 4, toolCallsExecuted: 2 });
    expect(calls).toEqual(["write", "test"]);
    // Each tool is announced before it runs and reported after, so a front end can show the work
    // in progress rather than only its outcome.
    expect(harnessValue.events.map((event) => event.type)).toEqual([
      "model_turn", "tool_call", "tool_result",
      "model_turn", "tool_call", "tool_result",
      "model_turn", "model_turn", "runtime_stop",
    ]);
  });

  it("nudges the model back to verify instead of ending the turn immediately", async () => {
    const calls: string[] = [];
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { calls.push("write"); return { content: "written" }; } },
      { name: "run_tests", description: "Run tests", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { calls.push("test"); return { content: "tests passed", verification: { passed: true, kind: "tests", scope: "targeted", summary: "unit tests" } }; } },
    ];
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "write-1", name: "write_file", arguments: {} }] }),
      turn({ content: "Done" }), // stops without verifying — should be nudged, not accepted
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "test-1", name: "run_tests", arguments: {} }] }),
      turn({ content: "Implemented and verified." }),
      turn({ content: "Nothing assemblable here." }),
    ], tools);
    const result = await value.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", toolCallsExecuted: 2 });
    expect(calls).toEqual(["write", "test"]);
    expect(value.requests.some((request) => request.messages.some((message) => message.role === "user" && message.content.includes("verifies it")))).toBe(true);
  });

  it("asks for executed tests when the only evidence is that the code compiles", async () => {
    const calls: string[] = [];
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { calls.push("write"); return { content: "written" }; } },
      { name: "typecheck", description: "Typecheck", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { calls.push("check"); return { content: "0 errors", verification: { passed: true, kind: "check", scope: "targeted", summary: "tsc" } }; } },
      { name: "run_tests", description: "Tests", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { calls.push("test"); return { content: "8 passed", verification: { passed: true, kind: "tests", scope: "targeted", summary: "vitest" } }; } },
    ];
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "typecheck", arguments: {} }] }),
      turn({ content: "It compiles, so it's done." }), // compile-only — must be pushed for tests
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "run_tests", arguments: {} }] }),
      turn({ content: "Tested against its invariants; there is no assembled program to exercise." }),
    ], tools);
    const result = await value.runtime.execute(baseRequest);
    expect(result.status).toBe("completed");
    expect(calls).toEqual(["write", "check", "test"]);
    // Both rungs were asked for in one message, so clearing compile-only evidence costs one round
    // trip rather than two.
    expect(value.executed()).toBe(5);
    expect(value.requests.some((request) => request.messages.some((message) => message.role === "user" && message.content.includes("invariants")))).toBe(true);
  });

  it("accepts compile-only evidence once the model explains there is no behaviour to assert", async () => {
    // Formatting, documentation and configuration changes have nothing to execute. Asking is
    // right; refusing to accept the answer would strand the turn.
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { return { content: "written" }; } },
      { name: "typecheck", description: "Typecheck", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "ok", verification: { passed: true, kind: "check", scope: "targeted", summary: "tsc" } }; } },
    ];
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "typecheck", arguments: {} }] }),
      turn({ content: "Comment-only change." }),
      turn({ content: "This edits a comment; there is no behaviour to assert." }),
    ], tools);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "completed" });
    // Asked exactly once — a second ask would be nagging, not a gate.
    expect(value.executed()).toBe(4);
  });

  it("treats unclassified verification as compile-only rather than as proof of behaviour", async () => {
    // A tool that reports `verification` without a kind must not clear the stronger bar by
    // omission; inferring the weaker claim is what keeps the gate honest for third-party tools.
    const tools: AgentTool[] = [
      { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { return { content: "written" }; } },
      { name: "verify", description: "Verify", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "ok", verification: { passed: true, scope: "targeted", summary: "unspecified" } }; } },
    ];
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "v1", name: "verify", arguments: {} }] }),
      turn({ content: "Done." }),
      turn({ content: "No behaviour to assert." }),
    ], tools);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "completed" });
    expect(value.requests.at(-1)?.messages.some((message) => message.role === "user" && message.content.includes("compiles"))).toBe(true);
  });

  const writeTool: AgentTool = { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { return { content: "written" }; } };
  const verifier = (name: string, kind: "check" | "tests" | "smoke" | "behavior"): AgentTool => ({
    name, description: name, inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false,
    async execute() { return { content: "ok", verification: { passed: true, kind, scope: "targeted", summary: name } }; },
  });

  it("does not ask for tests again once tests ran, but does ask once for the assembled program", async () => {
    // Units passing is not the same claim as the program working: a component whose invariants all
    // hold is still useless if it was never mounted. The ask escalates one rung, it does not repeat.
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "run_tests", arguments: {} }] }),
      turn({ content: "Implemented and tested." }),
      turn({ content: "It is a pure library; there is nothing to assemble." }),
    ], [writeTool, verifier("run_tests", "tests")]);
    const result = await value.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed" });
    const asks = value.requests.at(-1)!.messages.filter((message) => message.role === "user" && message.content.includes("assembled"));
    expect(asks).toHaveLength(1);
    // And never the compile-level ask, which tests already cleared.
    expect(value.requests.at(-1)!.messages.some((message) => message.content.includes("shows the code compiles"))).toBe(false);
  });

  /**
   * The doctrine has to be cheaper to follow than to ignore, or it just adds latency to every run.
   * A turn that produced functional evidence itself is finished the moment it says so.
   */
  it.each(["smoke", "behavior"] as const)("ends immediately when %s evidence is already present", async (kind) => {
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "v1", name: "verify", arguments: {} }] }),
      turn({ content: "Implemented, tested, and exercised end to end." }),
    ], [writeTool, verifier("verify", kind)]);
    const result = await value.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", summary: "Implemented, tested, and exercised end to end." });
    expect(value.executed()).toBe(3); // no nudge, no extra round trip
  });

  /**
   * Tool batches run as consecutive groups, not all-or-nothing.
   *
   * The old rule required *every* call in a batch to be parallel-safe, so one write forced five
   * independent reads to run one after another. Grouping keeps the concurrency where it is safe
   * without ever reordering across an effectful call.
   */
  describe("executing a batch of tool calls", () => {
    const started: string[] = [];
    const finished: string[] = [];
    const slow = (name: string, effect: "none" | "workspace"): AgentTool => ({
      name, description: name, inputSchema: {}, capabilityId: "workspace.files", effect,
      requiresApproval: false, parallelSafe: effect === "none",
      async execute() {
        started.push(name);
        await new Promise((resolve) => setTimeout(resolve, 20));
        finished.push(name);
        return { content: name };
      },
    });
    const batch = (names: string[]) => turn({
      finishReason: "tool_calls",
      toolCalls: names.map((name, index) => ({ id: `c${index}`, name, arguments: {} })),
    });
    // A workspace-effect tool trips the verification gate, which spends turns of its own. These
    // tests are about execution order, so the gate is simply answered and got out of the way.
    const settle = [turn({ content: "done" }), turn({ content: "nothing to verify" }), turn({ content: "nothing to assemble" })];
    beforeEach(() => { started.length = 0; finished.length = 0; });

    it("runs adjacent read-only calls concurrently even when a write shares the batch", async () => {
      const value = harness([batch(["r1", "r2", "r3", "w1"]), ...settle],
        [slow("r1", "none"), slow("r2", "none"), slow("r3", "none"), slow("w1", "workspace")]);
      await value.runtime.execute({ ...baseRequest, maxIterations: 6 });
      // All three reads are in flight before any of them finishes; the write waits its turn.
      expect(started.slice(0, 3)).toEqual(["r1", "r2", "r3"]);
      expect(finished.indexOf("w1")).toBe(3);
    });

    it("never reorders a read across a write, so each still observes the state it was sequenced for", async () => {
      const value = harness([batch(["r1", "w1", "r2"]), ...settle],
        [slow("r1", "none"), slow("w1", "workspace"), slow("r2", "none")]);
      await value.runtime.execute({ ...baseRequest, maxIterations: 6 });
      // Strictly serial: the write separates the two reads into different groups, and a read that
      // was emitted after a write must not be hoisted in front of it.
      expect(finished).toEqual(["r1", "w1", "r2"]);
    });

    it("keeps effectful calls strictly serial and in their emitted order", async () => {
      const value = harness([batch(["w1", "w2", "w3"]), ...settle],
        [slow("w1", "workspace"), slow("w2", "workspace"), slow("w3", "workspace")]);
      await value.runtime.execute({ ...baseRequest, maxIterations: 6 });
      expect(finished).toEqual(["w1", "w2", "w3"]);
    });

    it("returns one result per call, in the order the model emitted them, however they ran", async () => {
      const value = harness([batch(["r1", "r2", "w1", "r3"]), ...settle],
        [slow("r1", "none"), slow("r2", "none"), slow("w1", "workspace"), slow("r3", "none")]);
      const result = await value.runtime.execute({ ...baseRequest, maxIterations: 6 });
      const results = result.messages.filter((message) => message.role === "tool");
      expect(results.map((message) => (message as { name: string }).name)).toEqual(["r1", "r2", "w1", "r3"]);
      expect(result.toolCallsExecuted).toBe(4);
    });
  });

  it("does not demote evidence when a weaker check runs after a stronger one", async () => {
    // Running the linter after the e2e suite is not a reason to ask for the e2e suite again.
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "e1", name: "e2e", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "l1", name: "lint", arguments: {} }] }),
      turn({ content: "Done." }),
    ], [writeTool, verifier("e2e", "behavior"), verifier("lint", "check")]);
    const result = await value.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", summary: "Done." });
    expect(value.executed()).toBe(4);
  });

  it("still reports needs_verification if the model never verifies after being nudged", async () => {
    const tool: AgentTool = { name: "write_file", description: "Write", inputSchema: {}, capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false, async execute() { return { content: "written" }; } };
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "write-1", name: "write_file", arguments: {} }] }),
      turn({ content: "Done" }),
      turn({ content: "Still done" }),
      turn({ content: "Really done" }),
    ], [tool]);
    // The gate leads, but the agent's own account of the work survives it: replacing the summary
    // outright left a reader with a status and no idea what had been done.
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({
      status: "needs_verification",
      toolCallsExecuted: 1,
      summary: expect.stringContaining("The agent reported:"),
    });
    expect(value.executed()).toBe(4); // the tool-call turn, the first stop, then two nudged retries before the gate gives up
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

  it("announces a tool call with its arguments before running it", async () => {
    const tool: AgentTool = {
      name: "read_file", description: "Read", inputSchema: {}, capabilityId: "workspace.files",
      effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "contents" }; },
    };
    const value = harness([
      turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/app.ts" } }] }),
      turn({ content: "Read it." }),
    ], [tool]);
    await value.runtime.execute(baseRequest);

    const announced = value.events.find((event) => event.type === "tool_call");
    expect(announced).toMatchObject({ toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "src/app.ts" } });
    // Before, not after — the ordering is the whole point of the event.
    expect(value.events.indexOf(announced!)).toBeLessThan(value.events.findIndex((event) => event.type === "tool_result"));
  });

  it("does not announce a tool call that cancellation stopped before it started", async () => {
    const tool: AgentTool = {
      name: "read_file", description: "Read", inputSchema: {}, capabilityId: "workspace.files",
      effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "contents" }; },
    };
    const events: AgentRuntimeEvent[] = [];
    const runtime = new BoundedAgentRuntime({
      model: { async complete() { return turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] }); } },
      tools: [tool],
      prices,
      control: {
        async heartbeat() {},
        // Cancelled between preparing the call and running it: nothing ran, so nothing is claimed.
        async isCancellationRequested() { return events.some((event) => event.type === "model_turn"); },
        async isToolCallApproved() { return true; },
        async persistEvent(event) { events.push(event); },
      },
    });
    await runtime.execute(baseRequest);
    expect(events.some((event) => event.type === "tool_call")).toBe(false);
  });

  it("turns a thrown tool error into a tool result instead of crashing the run", async () => {
    // A tool that throws (a network error, an unexpected exception) must not take the whole
    // session down with it — the model needs to see the failure as a tool result and can retry
    // or change approach, the same as it would for a tool that returns isError itself.
    const tool: AgentTool = {
      name: "flaky_tool", description: "Sometimes throws", inputSchema: {}, capabilityId: "workspace.files",
      effect: "none", requiresApproval: false, parallelSafe: false,
      async execute() { throw new Error("ECONNRESET"); },
    };
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "call-1", name: "flaky_tool", arguments: {} }] }),
      turn({ content: "Recovered" }),
    ], [tool]);
    const result = await value.runtime.execute(baseRequest);
    expect(result.status).toBe("completed");
    const toolResult = value.events.find((event) => event.type === "tool_result");
    expect(toolResult).toMatchObject({ isError: true, content: "ECONNRESET" });
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

describe("oversized tool results", () => {
  const hugeOutput = [...Array(20_000).keys()].map((index) => `log line ${index}`).join("\n");
  const noisyTool: AgentTool[] = [
    { name: "run_command", description: "Run a command", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: `${hugeOutput}\nFAILED at the end` }; } },
  ];
  const callTurns = [
    turn({ finishReason: "tool_calls", content: "", toolCalls: [{ id: "call-1", name: "run_command", arguments: { command: "bun test" } }] }),
    turn({ content: "Read the log." }),
  ];

  function storeSpy(behaviour: "ok" | "throws" = "ok") {
    const puts: Array<{ toolName: string; content: string }> = [];
    const store: ToolResultArtifactStore = {
      async put(input) {
        puts.push({ toolName: input.toolName, content: input.content });
        if (behaviour === "throws") throw new Error("read-only filesystem");
        return { path: ".nova/artifacts/run_command-0123456789ab.txt", bytes: Buffer.byteLength(input.content), lines: input.content.split("\n").length, elided: false };
      },
    };
    return { store, puts };
  }

  it("writes the whole result to an artifact and charges the transcript only for the excerpt", async () => {
    const spy = storeSpy();
    const value = harness(callTurns, noisyTool, true, spy.store);
    const result = await value.runtime.execute(baseRequest);

    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(spy.puts[0].content).toHaveLength(hugeOutput.length + "\nFAILED at the end".length);
    expect(toolMessage?.content.length).toBeLessThanOrEqual(baseRequest.maxToolResultChars);
    // The handle, the beginning and — the reason any of this exists — the end.
    expect(toolMessage?.content).toContain(".nova/artifacts/run_command-0123456789ab.txt");
    expect(toolMessage?.content).toContain("log line 0");
    expect(toolMessage?.content).toContain("FAILED at the end");
  });

  it("tells the front end where the full output went", async () => {
    const spy = storeSpy();
    const value = harness(callTurns, noisyTool, true, spy.store);
    await value.runtime.execute(baseRequest);

    const event = value.events.find((item) => item.type === "tool_result");
    expect(event).toMatchObject({ type: "tool_result", artifact: { path: ".nova/artifacts/run_command-0123456789ab.txt", elided: false } });
  });

  it("truncates exactly as before when no store is configured, and when the store fails", async () => {
    const withoutStore = harness(callTurns, noisyTool);
    const plain = (await withoutStore.runtime.execute(baseRequest)).messages.find((message) => message.role === "tool");
    expect(plain?.content).toContain("[tool result truncated]");
    expect(plain?.content.length).toBeLessThanOrEqual(baseRequest.maxToolResultChars);

    const failing = storeSpy("throws");
    const withFailingStore = harness(callTurns, noisyTool, true, failing.store);
    const result = await withFailingStore.runtime.execute(baseRequest);
    // A store that cannot write must cost the run nothing beyond the excerpt it could not build.
    expect(result.status).toBe("completed");
    expect(result.messages.find((message) => message.role === "tool")?.content).toContain("[tool result truncated]");
  });

  it("leaves results that already fit untouched, and never calls the store for them", async () => {
    const spy = storeSpy();
    const small: AgentTool[] = [
      { name: "run_command", description: "Run a command", inputSchema: {}, capabilityId: "workspace.terminal", effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "2 passed" }; } },
    ];
    const value = harness(callTurns, small, true, spy.store);
    const result = await value.runtime.execute(baseRequest);

    expect(result.messages.find((message) => message.role === "tool")?.content).toBe("2 passed");
    expect(spy.puts).toHaveLength(0);
  });
});
