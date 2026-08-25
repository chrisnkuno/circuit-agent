import { describe, expect, it } from "vitest";
import type { AgentRuntimeResult } from "@circuit-nova/nova-core/agent-runtime";
import { EXIT_CODES, HeadlessEmitter, HEADLESS_PROTOCOL_VERSION, exitCodeForStatus, type HeadlessRecord } from "./headless";

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** Collects raw output exactly as a pipe would receive it, so the parsing is the test. */
function capture() {
  let raw = "";
  const emitter = new HeadlessEmitter((line) => { raw += line; }, () => new Date("2026-08-10T12:00:00.000Z"));
  return {
    emitter,
    get raw() { return raw; },
    records(): HeadlessRecord[] {
      // Split the way a consumer must: on newlines, with no tolerance for anything else.
      return raw.split("\n").filter((line) => line !== "").map((line) => JSON.parse(line) as HeadlessRecord);
    },
  };
}

const ALL_STATUSES: AgentRuntimeResult["status"][] = [
  "completed", "failed", "blocked", "needs_approval", "needs_verification", "cancelled", "iteration_limit",
];

describe("headless exit codes", () => {
  it("gives every terminal status its own code", () => {
    // The contract a caller branches on. Distinctness is the property: collapsing two statuses
    // onto one number silently removes a caller's ability to tell them apart.
    const codes = ALL_STATUSES.map(exitCodeForStatus);
    expect(new Set(codes).size).toBe(ALL_STATUSES.length);
    expect(exitCodeForStatus("completed")).toBe(0);
  });

  it("is total: every status maps to a defined code", () => {
    for (const status of ALL_STATUSES) {
      const code = exitCodeForStatus(status);
      expect(Number.isInteger(code)).toBe(true);
      expect(Object.values(EXIT_CODES)).toContain(code);
    }
  });

  it("keeps every code inside the range a shell can report", () => {
    // 126/127 mean "could not execute" and 128+n means "killed by signal n". A code at or above
    // 126 would be indistinguishable from Nova never having run.
    for (const code of Object.values(EXIT_CODES)) {
      expect(code).toBeGreaterThanOrEqual(0);
      expect(code).toBeLessThan(126);
    }
  });

  it("reserves zero for success alone", () => {
    for (const status of ALL_STATUSES) {
      if (status !== "completed") expect(exitCodeForStatus(status)).not.toBe(0);
    }
  });
});

describe("headless stream", () => {
  it("writes one complete JSON object per line and nothing else", () => {
    const sink = capture();
    sink.emitter.session({ sessionId: "s1", root: "/repo", provider: "anthropic", model: "claude-sonnet-5", mode: "build", workspace: "local" });
    sink.emitter.turnStart("fix the tests");
    sink.emitter.agentEvent({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "working" } });

    // Every line parses, and the raw stream ends on a newline — a consumer must never be left
    // holding a partial object waiting for more.
    expect(() => sink.records()).not.toThrow();
    expect(sink.raw.endsWith("\n")).toBe(true);
    for (const line of sink.raw.split("\n").filter(Boolean)) {
      expect(line).not.toContain("\n");
      expect(JSON.parse(line)).toBeTypeOf("object");
    }
  });

  it("numbers records from one with no gaps, so a consumer can detect loss", () => {
    const sink = capture();
    sink.emitter.session({ sessionId: "s1", root: "/r", provider: "p", model: "m", mode: "build", workspace: "local" });
    for (let index = 0; index < 5; index += 1) sink.emitter.emit("text", { text: `chunk ${index}` });
    sink.emitter.turnEnd({ status: "completed", summary: "done", iterations: 1, toolCalls: 0, usage, cost: null, elapsedMs: 5 });

    const records = sink.records();
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(records.every((record) => record.v === HEADLESS_PROTOCOL_VERSION)).toBe(true);
    expect(records.every((record) => typeof record.at === "string" && typeof record.type === "string")).toBe(true);
  });

  it("survives text that would break a line-delimited format", () => {
    // Control characters in model output must be escaped into the JSON string, never emitted raw.
    // \u2028 is a line terminator to a JS parser, \u0000 a control character, and a bare newline
    // would split one record into two unparseable halves. All must survive as string content.
    const hostile = 'line one\nline two\r\n"quoted" \\ backslash \u0000 nul \u2028 sep \t tab';
    const sink = capture();
    sink.emitter.emit("text", { text: hostile });

    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0].text).toBe(hostile);
    // One record means one line: exactly one newline in the raw stream, at the very end.
    expect(sink.raw.split("\n").filter((line) => line !== "")).toHaveLength(1);
  });

  it("reports a value it cannot serialize instead of writing a broken line", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const sink = capture();
    sink.emitter.emit("tool_result", { content: circular });

    const records = sink.records();
    expect(records).toHaveLength(1);
    expect(records[0].type).toBe("error");
    expect(records[0].seq).toBe(1); // the sequence is still spent, so no gap appears
  });

  it("redacts credentials in tool arguments, by the same rule the audit journal uses", () => {
    const sink = capture();
    sink.emitter.agentEvent({
      type: "runtime",
      event: { type: "tool_call", toolCallId: "c1", toolName: "run_command", effect: "workspace", arguments: { command: "deploy", token: "sk-live-abcdef123456" } },
    });
    expect(sink.raw).not.toContain("sk-live-abcdef123456");
    expect(sink.records()[0].arguments).toMatchObject({ token: "[REDACTED]" });
  });

  it("passes a tool's structured data through, so a consumer need not parse prose", () => {
    const sink = capture();
    sink.emitter.agentEvent({
      type: "runtime",
      event: {
        type: "tool_result", toolCallId: "c1", toolName: "run_command", isError: true, effect: "workspace",
        content: "exit 2\n1 failed", data: { command: "npm test", exitCode: 2, stdout: "1 failed", stderr: "" },
      },
    });
    const [record] = sink.records();
    // The exit code is a number to branch on, not a substring to find in "exit 2\n1 failed".
    expect(record.data).toMatchObject({ command: "npm test", exitCode: 2 });
  });

  it("redacts secrets inside data, not only inside content", () => {
    // `data` carries the same facts as `content`; redacting one and not the other would move the
    // secret rather than remove it.
    const sink = capture();
    sink.emitter.agentEvent({
      type: "runtime",
      event: {
        type: "tool_result", toolCallId: "c1", toolName: "run_command", isError: false, effect: "workspace",
        content: "ok", data: { command: "deploy", token: "sk-live-abcdef123456" },
      },
    });
    expect(sink.raw).not.toContain("sk-live-abcdef123456");
    expect((sink.records()[0].data as Record<string, unknown>).token).toBe("[REDACTED]");
  });

  it("maps each agent event to its own record type", () => {
    const sink = capture();
    sink.emitter.agentEvent({ type: "checkpoint", checkpoint: { tree: "abc123", label: "before", createdAt: 0, turnId: "t1", messageCount: 0 } });
    sink.emitter.agentEvent({ type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 12 });
    sink.emitter.agentEvent({ type: "runtime", event: { type: "provider_retry", iteration: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 100, reason: "rate_limit" } });
    sink.emitter.agentEvent({ type: "runtime", event: { type: "model_turn", iteration: 1, responseId: "r", model: "m", toolCallCount: 2, usage } });
    sink.emitter.agentEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "ok" } });
    sink.emitter.agentEvent({ type: "runtime", event: { type: "runtime_stop", status: "completed", summary: "done" } });

    expect(sink.records().map((record) => record.type)).toEqual([
      "checkpoint", "compaction", "provider_retry", "model_turn", "tool_result", "runtime_stop",
    ]);
  });

  it("carries the exit code on turn_end, so a consumer need not re-derive it", () => {
    const sink = capture();
    sink.emitter.turnEnd({ status: "needs_verification", summary: "unverified", iterations: 3, toolCalls: 2, usage, cost: "$0.01", elapsedMs: 20 });
    const [record] = sink.records();
    expect(record).toMatchObject({ type: "turn_end", status: "needs_verification", exitCode: EXIT_CODES.needs_verification });
  });
});
