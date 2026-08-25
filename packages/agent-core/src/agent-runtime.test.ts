import { beforeEach, describe, expect, it } from "vitest";
import { agentMessagePromptParts, BoundedAgentRuntime, isRetryableProviderError, ProviderRequestError, providerFailureKind, type AgentModelRequest, type AgentModelTurn, type AgentRuntimeEvent, type AgentTool, type ToolResultArtifactStore } from "./agent-runtime";

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
  it("counts structured tool-call arguments as prompt input", () => {
    const content = "x".repeat(20_000);
    const parts = agentMessagePromptParts({
      role: "assistant", content: "", toolCalls: [{ id: "write_1", name: "write_file", arguments: { path: "large.ts", content } }],
    });
    expect(parts.join("").length).toBeGreaterThanOrEqual(content.length);
    expect(parts).toContain("write_file");
    expect(parts).toContain("write_1");
  });

  it("resumes a turn that stopped at the output limit instead of failing the run", async () => {
    // `finish_reason: "length"` is a successful, incomplete reply — the tokens are spent and the
    // text is real. Failing here threw away a paid-for partial answer and told the user their
    // model was unsupported.
    const value = harness([
      turn({ finishReason: "length", content: "Here is the plan, step one" }),
      turn({ finishReason: "stop", content: "…step two, and done." }),
    ], []);

    const result = await value.runtime.execute(baseRequest);
    expect(result.status).toBe("completed");
    // The partial text stays in the transcript, so "continue" has something to continue from, and
    // the model is told what happened rather than left to guess why it is being prompted again.
    const resumed = value.requests[1].messages.slice(-2);
    expect(resumed[0]).toEqual({ role: "assistant", content: "Here is the plan, step one" });
    expect(resumed[1].role).toBe("user");
    expect(resumed[1].content).toContain("output token limit");
  });

  it("gives up after a bounded number of continuations rather than spending the whole budget on one answer", async () => {
    const truncated = Array.from({ length: 6 }, () => turn({ finishReason: "length", content: "still going" }));
    const value = harness(truncated, []);
    const result = await value.runtime.execute({ ...baseRequest, maxIterations: 6, modelReservationRwf: 10_000 });
    expect(result.status).toBe("iteration_limit");
    expect(result.summary).toContain("output limit");
    // Three continuations means four model calls in total, not the six the loop would have allowed.
    expect(value.executed()).toBe(4);
  });

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

  describe("provider recovery", () => {
    function runtimeWithProvider(complete: (request: AgentModelRequest) => Promise<AgentModelTurn>, cancelled = () => false) {
      const events: AgentRuntimeEvent[] = [];
      return {
        events,
        runtime: new BoundedAgentRuntime({
          model: { complete }, tools: [], prices,
          control: {
            async heartbeat() {},
            async isCancellationRequested() { return cancelled(); },
            async isToolCallApproved() { return true; },
            async persistEvent(event) { events.push(event); },
          },
        }),
      };
    }

    it("retries a transient provider failure and records only the successful model turn", async () => {
      let calls = 0;
      const value = runtimeWithProvider(async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("service unavailable"), { status: 503 });
        return turn({ content: "Recovered after a transient outage." });
      });
      await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({
        status: "completed", summary: "Recovered after a transient outage.", iterations: 1,
      });
      expect(calls).toBe(2);
      expect(value.events.filter((event) => event.type === "model_turn")).toHaveLength(1);
      expect(value.events.find((event) => event.type === "provider_retry")).toMatchObject({
        nextAttempt: 2, maxAttempts: 3, delayMs: 100, reason: "server",
      });
    });

    it("uses two retries at most and then surfaces the original provider failure", async () => {
      let calls = 0;
      const failure = Object.assign(new Error("upstream overloaded"), { statusCode: 503 });
      const value = runtimeWithProvider(async () => { calls += 1; throw failure; });
      await expect(value.runtime.execute(baseRequest)).rejects.toMatchObject({
        name: "ProviderRequestError", attempts: 3, retrySuppressed: null, cause: failure,
      });
      expect(calls).toBe(3);
      expect(value.events.filter((event) => event.type === "provider_retry")).toHaveLength(2);
    });

    it("does not retry permanent endpoint, authentication, or request errors", async () => {
      for (const status of [400, 401, 403, 404, 422]) {
        let calls = 0;
        const failure = Object.assign(new Error("request failed"), { status });
        const value = runtimeWithProvider(async () => { calls += 1; throw failure; });
        await expect(value.runtime.execute(baseRequest)).rejects.toBe(failure);
        expect(calls).toBe(1);
      }
    });

    it("honours cancellation before repeating a failed provider request", async () => {
      let calls = 0;
      const value = runtimeWithProvider(async () => {
        calls += 1;
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }, () => calls > 0);
      await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "cancelled", iterations: 0 });
      expect(calls).toBe(1);
    });

    it("aborts an in-flight provider request immediately and never retries it", async () => {
      const controller = new AbortController();
      let calls = 0;
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => { markStarted = resolve; });
      const value = runtimeWithProvider(async (request) => {
        calls += 1;
        return await new Promise<AgentModelTurn>((_resolve, reject) => {
          markStarted();
          request.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError", code: "ABORT_ERR" })), { once: true });
        });
      });
      const pending = value.runtime.execute({ ...baseRequest, signal: controller.signal });
      await started;
      controller.abort();
      await expect(pending).resolves.toMatchObject({ status: "cancelled", iterations: 0 });
      expect(calls).toBe(1);
    });

    it("does not retry after a provider has already streamed visible output", async () => {
      let calls = 0;
      const failure = Object.assign(new Error("connection reset after output"), { code: "ECONNRESET" });
      const value = runtimeWithProvider(async (request) => {
        calls += 1;
        request.onTextDelta?.("partial answer");
        throw failure;
      });
      await expect(value.runtime.execute(baseRequest)).rejects.toMatchObject({
        name: "ProviderRequestError", attempts: 1, retrySuppressed: "output_started", cause: failure,
      });
      expect(calls).toBe(1);
    });

    it("recognises transient SDK causes but lets an explicit 404 override a vague network message", () => {
      expect(isRetryableProviderError(new Error("fetch failed", { cause: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }))).toBe(true);
      expect(isRetryableProviderError(Object.assign(new Error("temporary network error"), { status: 404 }))).toBe(false);
      expect(isRetryableProviderError(Object.assign(new Error("rate limited"), { status: 429 }))).toBe(true);
      expect(providerFailureKind(Object.assign(new Error("too many requests"), { status: 429 }))).toBe("rate_limit");
      expect(providerFailureKind(Object.assign(new Error("gateway timeout"), { status: 504 }))).toBe("server");
      expect(providerFailureKind(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))).toBe("network");
    });

    it("keeps the original provider message inside a clear bounded-retry error", () => {
      const cause = Object.assign(new Error("upstream overloaded"), { status: 503 });
      const error = new ProviderRequestError(cause, { attempts: 3 });
      expect(error.message).toContain("failed after 3 attempts");
      expect(error.message).toContain("upstream overloaded");
      expect(error.cause).toBe(cause);
    });
  });

  describe("malformed tool-turn recovery", () => {
    const readTool: AgentTool = {
      name: "read_file", description: "Read", inputSchema: {}, capabilityId: "workspace.files",
      effect: "none", requiresApproval: false, parallelSafe: false, async execute() { return { content: "contents" }; },
    };

    it("asks the model to split a tool batch that exceeds the per-turn limit", async () => {
      const oversized = Array.from({ length: 5 }, (_, index) => ({ id: `too-many-${index}`, name: "read_file", arguments: {} }));
      const value = harness([
        turn({ finishReason: "tool_calls", toolCalls: oversized }),
        turn({ finishReason: "tool_calls", toolCalls: [{ id: "valid", name: "read_file", arguments: {} }] }),
        turn({ content: "Recovered." }),
      ], [readTool]);
      const result = await value.runtime.execute(baseRequest);
      expect(result).toMatchObject({ status: "completed", toolCallsExecuted: 1 });
      expect(value.requests[1].messages.at(-1)?.content).toContain("at most 4 calls");
      expect(value.events.filter((event) => event.type === "tool_call")).toHaveLength(1);
    });

    it("fails after two bounded corrections when oversized batches continue", async () => {
      const oversized = () => turn({
        finishReason: "tool_calls",
        toolCalls: Array.from({ length: 5 }, (_, index) => ({ id: crypto.randomUUID(), name: "read_file", arguments: { index } })),
      });
      const value = harness([oversized(), oversized(), oversized()], [readTool]);
      await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({
        status: "failed", toolCallsExecuted: 0, summary: expect.stringContaining("repeatedly exceeded"),
      });
      expect(value.executed()).toBe(3);
    });

    it.each([
      ["missing id", [{ id: "", name: "read_file", arguments: {} }]],
      ["duplicate id", [{ id: "same", name: "read_file", arguments: {} }, { id: "same", name: "read_file", arguments: {} }]],
      ["non-object arguments", [{ id: "bad-args", name: "read_file", arguments: "{}" }]],
    ])("repairs %s without executing the malformed call", async (_label, malformedCalls) => {
      const value = harness([
        turn({ finishReason: "tool_calls", toolCalls: malformedCalls }),
        turn({ finishReason: "tool_calls", toolCalls: [{ id: "valid", name: "read_file", arguments: {} }] }),
        turn({ content: "Recovered." }),
      ], [readTool]);
      const result = await value.runtime.execute(baseRequest);
      expect(result).toMatchObject({ status: "completed", toolCallsExecuted: 1 });
      expect(value.requests[1].messages.at(-1)?.content).toContain("malformed");
    });

    it("recovers a declared tool turn with no calls, then allows a normal answer", async () => {
      const value = harness([
        turn({ finishReason: "tool_calls", toolCalls: [] }),
        turn({ content: "No tool was needed." }),
      ], []);
      await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "completed", toolCallsExecuted: 0 });
      expect(value.requests[1].messages.at(-1)?.content).toContain("no usable tool calls");
    });
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
    ], tools);
    const result = await harnessValue.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed", iterations: 3, toolCallsExecuted: 2 });
    expect(calls).toEqual(["write", "test"]);
    // Each tool is announced before it runs and reported after, so a front end can show the work
    // in progress rather than only its outcome.
    expect(harnessValue.events.map((event) => event.type)).toEqual([
      "model_turn", "tool_call", "tool_result",
      "model_turn", "tool_call", "tool_result",
      "model_turn", "runtime_stop",
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
    expect(value.requests.some((request) => request.messages.some((message) => message.role === "user" && message.content.includes("smallest relevant")))).toBe(true);
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

  it("accepts passing targeted tests without spending another turn on a generic smoke request", async () => {
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "w1", name: "write_file", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "t1", name: "run_tests", arguments: {} }] }),
      turn({ content: "Implemented and tested." }),
    ], [writeTool, verifier("run_tests", "tests")]);
    const result = await value.runtime.execute(baseRequest);
    expect(result).toMatchObject({ status: "completed" });
    const asks = value.requests.at(-1)!.messages.filter((message) => message.role === "user" && message.content.includes("assembled"));
    expect(asks).toHaveLength(0);
    expect(value.executed()).toBe(3);
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
    expect(value.executed()).toBe(3); // tool-call turn, first stop, then one bounded retry
  });

  it("halts before an unapproved external action", async () => {
    let executed = false;
    const tool: AgentTool = { name: "send_message", description: "Send", inputSchema: {}, capabilityId: "operations.execute", effect: "external", requiresApproval: true, parallelSafe: false, async execute() { executed = true; return { content: "sent" }; } };
    const value = harness([turn({ finishReason: "tool_calls", toolCalls: [{ id: "send-1", name: "send_message", arguments: {} }] })], [tool], false);
    const result = await value.runtime.execute({ ...baseRequest, allowedCapabilityIds: ["operations.execute"] });
    expect(result.status).toBe("needs_approval");
    expect(executed).toBe(false);
  });

  it("recovers once when the model reaches outside its capability scope", async () => {
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "bad-1", name: "unknown_tool", arguments: {} }] }),
      turn({ content: "I can answer without it." }),
    ], []);
    await expect(value.runtime.execute(baseRequest)).resolves.toMatchObject({ status: "completed", toolCallsExecuted: 0 });
  });

  it("fails closed when an unavailable tool is requested twice", async () => {
    const value = harness([
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "bad-1", name: "unknown_tool", arguments: {} }] }),
      turn({ finishReason: "tool_calls", toolCalls: [{ id: "bad-2", name: "unknown_tool", arguments: {} }] }),
    ], []);
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

/**
 * What a tool result costs the transcript.
 *
 * These are the properties that decide whether an agent finishes a long task or dies of context
 * exhaustion, and each one was measured wrong before: eviction that cost more than it saved, the
 * same output paid for twice, and eight parallel calls appending a whole context window in one step.
 */
describe("what a tool result costs the transcript", () => {
  function sizedTool(output: string, name = "run_command"): AgentTool[] {
    return [{
      name,
      description: "Runs a command",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      // Read-only on purpose: this describes what a *result* costs, and a workspace effect would
      // pull the verification nudges into every one of these runs and measure something else.
      capabilityId: "workspace.files",
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute() { return { content: output }; },
    }];
  }

  function callFor(name: string, id: string) {
    return { id, name, arguments: {} };
  }

  function store() {
    const puts: string[] = [];
    return {
      puts,
      store: {
        async put(input: { toolName: string; content: string }) {
          puts.push(input.content);
          return { path: `.nova/artifacts/${input.toolName}-abc123456789.txt`, bytes: input.content.length, lines: input.content.split("\n").length, elided: false };
        },
      } as ToolResultArtifactStore,
    };
  }

  it("sends a result whole when evicting it would cost more than it saves", async () => {
    // Just over the per-call budget: the excerpt would save a few hundred characters and then
    // invite a read_file worth thousands. Measured at 40,000 that trade was 35x worse.
    const output = "x".repeat(Math.floor(baseRequest.maxToolResultChars * 1.4));
    const spy = store();
    const value = harness(
      [turn({ finishReason: "tool_calls", toolCalls: [callFor("run_command", "c1")] }), turn({ content: "done" }), turn({ content: "done" })],
      sizedTool(output),
      true,
      spy.store,
    );
    const result = await value.runtime.execute(baseRequest);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(toolMessage?.content).toBe(output);
    expect(spy.puts).toHaveLength(0);
  });

  it("still evicts when the result is genuinely large, and spends a fraction of the budget on the excerpt", async () => {
    const output = ["START", ...Array(5_000).keys()].join("\n") + "\nEND";
    const spy = store();
    const value = harness(
      [turn({ finishReason: "tool_calls", toolCalls: [callFor("run_command", "c1")] }), turn({ content: "done" }), turn({ content: "done" })],
      sizedTool(output),
      true,
      spy.store,
    );
    const result = await value.runtime.execute(baseRequest);
    const toolMessage = result.messages.find((message) => message.role === "tool");
    expect(spy.puts[0]).toBe(output);
    expect(toolMessage?.content).toContain(".nova/artifacts/run_command-abc123456789.txt");
    // Head and tail both survive — the end is the half that says what failed.
    expect(toolMessage?.content).toContain("START");
    expect(toolMessage?.content).toContain("END");
    expect(toolMessage!.content.length).toBeLessThanOrEqual(baseRequest.maxToolResultChars);
  });

  it("references an identical earlier result instead of paying for it twice", async () => {
    const output = "y".repeat(6_000);
    const spy = store();
    const value = harness(
      [
        turn({ finishReason: "tool_calls", toolCalls: [callFor("run_command", "c1")] }),
        turn({ finishReason: "tool_calls", toolCalls: [callFor("run_command", "c2")] }),
        turn({ content: "done" }),
        turn({ content: "done" }),
      ],
      sizedTool(output),
      true,
      spy.store,
    );
    const result = await value.runtime.execute({ ...baseRequest, maxTotalToolResultChars: 40_000 });
    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toHaveLength(2);
    expect(toolMessages[1].content).toMatch(/identical to the earlier run_command result/i);
    // The saving is the whole point: the second copy costs a line, not the payload.
    expect(toolMessages[1].content.length).toBeLessThan(400);
  });

  it("bounds what a single iteration can append, however many calls it made", async () => {
    const output = "z".repeat(3_000);
    const tools = ["alpha", "beta", "gamma", "delta"].map((name) => sizedTool(output, name)[0]);
    const value = harness(
      [
        turn({
          finishReason: "tool_calls",
          toolCalls: [callFor("alpha", "c1"), callFor("beta", "c2"), callFor("gamma", "c3"), callFor("delta", "c4")],
        }),
        turn({ content: "done" }),
        turn({ content: "done" }),
      ],
      tools,
      true,
    );
    const request = { ...baseRequest, maxToolResultChars: 4_000, maxTotalToolResultChars: 40_000 };
    const result = await value.runtime.execute(request);
    const appended = result.messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + message.content.length, 0);
    // A quarter of the total allowance is the per-iteration ceiling; four 3,000-char results would
    // otherwise have landed 12,000 characters in one step.
    expect(appended).toBeLessThanOrEqual(Math.max(request.maxToolResultChars, request.maxTotalToolResultChars / 4));
  });
});

describe("effort", () => {
  it("carries a run's effort into every model call, and sends nothing when unset", async () => {
    // Reasoning tokens bill as output and share the output budget, so this is a spend control.
    // It belongs to the run: a delegated sub-task is cheap work from its first call to its last.
    const cheap = harness([turn({ content: "done" })], []);
    await cheap.runtime.execute({ ...baseRequest, effort: "low" });
    expect(cheap.requests.every((request) => request.effort === "low")).toBe(true);

    const ordinary = harness([turn({ content: "done" })], []);
    await ordinary.runtime.execute(baseRequest);
    // Absent, not "high": the provider's own default is the right answer and second-guessing it
    // would cost quality on exactly the requests that need it.
    expect(ordinary.requests.every((request) => request.effort === undefined)).toBe(true);
  });
});

describe("what a nudge costs", () => {
  /**
   * Every nudge re-sends the whole transcript, so the expensive part of a nudge is never its text —
   * it is how many round trips deliver it. What the runtime must not do is walk up the evidence
   * ladder one question per model call.
   */
  it("asks for tests and for an assembled-program check in one message, not two round trips", async () => {
    const checkTool: AgentTool[] = [{
      name: "run_command",
      description: "Runs a command",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      capabilityId: "workspace.terminal",
      effect: "workspace",
      requiresApproval: false,
      parallelSafe: false,
      async execute() {
        return { content: "exit 0", verification: { passed: true, kind: "check" as const, scope: "targeted" as const, summary: "tsc exited 0" } };
      },
    }];
    const value = harness(
      [
        turn({ finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "run_command", arguments: {} }] }),
        turn({ content: "Typecheck passes." }),
        turn({ content: "Still just a typecheck." }),
      ],
      checkTool,
      true,
    );
    const result = await value.runtime.execute(baseRequest);

    const asks = result.messages.filter((message) => message.role === "user" && message.content.startsWith("That build/typecheck"));
    expect(asks).toHaveLength(1);
    expect(asks[0].content).toContain("smallest relevant existing test or smoke command");
    const behaviourAlone = result.messages.filter((message) => message.role === "user" && message.content.startsWith("Your unit tests pass"));
    expect(behaviourAlone).toHaveLength(0);
  });

  it("asks for verification at most once, and never gives up on the run", async () => {
    const writer: AgentTool[] = [{
      name: "write_file",
      description: "Writes a file",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      capabilityId: "workspace.files",
      effect: "workspace",
      requiresApproval: false,
      parallelSafe: false,
      async execute() { return { content: "written" }; },
    }];
    const value = harness(
      [
        turn({ finishReason: "tool_calls", toolCalls: [{ id: "c1", name: "write_file", arguments: {} }] }),
        turn({ content: "All done." }),
        turn({ content: "Still done." }),
        turn({ content: "Really done." }),
      ],
      writer,
      true,
    );
    const result = await value.runtime.execute(baseRequest);
    const asks = result.messages.filter((message) => message.role === "user" && message.content.startsWith("You changed the workspace"));
    // A model that never verifies still terminates, and the gate reports what happened.
    expect(asks).toHaveLength(1);
    expect(result.status).toBe("needs_verification");
  });
});
