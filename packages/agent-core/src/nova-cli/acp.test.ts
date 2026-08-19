import { describe, expect, it } from "vitest";
import {
  ACP_PROTOCOL_VERSION,
  AcpConnection,
  acpStopReason,
  acpToolKind,
  acpUpdateFor,
  decisionFromOptionId,
  JSON_RPC,
  toolCallTitle,
  type AcpSession,
  type JsonRpcOutgoing,
} from "./acp";
import type { NovaEvent } from "./agent";

function connect(overrides: { onSend?: (prompt: string) => void; status?: "completed" | "cancelled" | "blocked" | "iteration_limit" } = {}) {
  const sent: JsonRpcOutgoing[] = [];
  let emit: ((event: NovaEvent) => void) | undefined;
  let ask: ((request: { toolName: string; summary: string; toolCallId: string }) => Promise<string>) | undefined;
  const disposed: string[] = [];
  const modes: string[] = [];
  let cancelled = false;

  const connection = new AcpConnection({
    send: (message) => sent.push(message),
    createSession: async ({ onEvent, approve }) => {
      emit = onEvent;
      ask = approve;
      const session: AcpSession = {
        id: "sess_1",
        async send(prompt) {
          overrides.onSend?.(prompt);
          return { status: overrides.status ?? "completed", summary: "done" };
        },
        cancel() { cancelled = true; },
        async setMode(mode) { modes.push(mode); },
        async dispose() { disposed.push("sess_1"); },
      };
      return session;
    },
  });

  const call = async (method: string, params?: Record<string, unknown>, id: number | string = 1) => {
    await connection.receive({ jsonrpc: "2.0", id, method, params });
    return sent.find((message) => "id" in message && message.id === id && ("result" in message || "error" in message));
  };
  const notify = (method: string, params?: Record<string, unknown>) => connection.receive({ jsonrpc: "2.0", method, params });

  return { connection, sent, call, notify, emit: (event: NovaEvent) => emit?.(event), ask: () => ask, disposed, modes, wasCancelled: () => cancelled };
}

const initialize = { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} };

describe("acp handshake and sessions", () => {
  it("answers initialize with the version it speaks and what it can do", async () => {
    const value = connect();
    const response = await value.call("initialize", initialize);
    expect(response).toMatchObject({ result: { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: { loadSession: true } } });
  });

  it("refuses to create a session before the handshake", async () => {
    const value = connect();
    const response = await value.call("session/new", { cwd: "/tmp/project" });
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidRequest } });
  });

  it("names its modes so a client can offer them", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    const response = await value.call("session/new", { cwd: "/tmp/project" }, 2);
    expect(response).toMatchObject({ result: { sessionId: "sess_1" } });

    await value.call("session/set_mode", { sessionId: "sess_1", modeId: "plan" }, 3);
    expect(value.modes).toEqual(["plan"]);
    const rejected = await value.call("session/set_mode", { sessionId: "sess_1", modeId: "godmode" }, 4);
    expect(rejected).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("rejects work for a session that does not exist, rather than inventing one", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    const response = await value.call("session/prompt", { sessionId: "nope", prompt: [{ type: "text", text: "hi" }] }, 2);
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("answers unknown methods with method-not-found instead of failing the connection", async () => {
    const value = connect();
    const response = await value.call("session/teleport", {});
    expect(response).toMatchObject({ error: { code: JSON_RPC.methodNotFound } });
  });

  it("never replies to a notification, and cancels the session a cancel names", async () => {
    const value = connect();
    await value.call("initialize", initialize);
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    const before = value.sent.length;
    await value.notify("session/cancel", { sessionId: "sess_1" });
    await value.notify("session/cancel", { sessionId: "unknown" });

    expect(value.sent).toHaveLength(before);
    expect(value.wasCancelled()).toBe(true);
  });
});

describe("acp prompt turns", () => {
  async function ready(overrides: Parameters<typeof connect>[0] = {}) {
    const value = connect(overrides);
    await value.call("initialize", initialize);
    await value.call("session/new", { cwd: "/tmp/project" }, 2);
    return value;
  }

  it("flattens content blocks — including an attached resource — into the prompt the agent runs", async () => {
    const prompts: string[] = [];
    const value = await ready({ onSend: (prompt) => prompts.push(prompt) });
    await value.call("session/prompt", {
      sessionId: "sess_1",
      prompt: [
        { type: "text", text: "why does this fail?" },
        { type: "resource", resource: { uri: "file:///project/main.py", text: "def f(): pass" } },
        { type: "resource_link", uri: "file:///project/README.md" },
      ],
    }, 3);

    expect(prompts[0]).toContain("why does this fail?");
    expect(prompts[0]).toContain("def f(): pass");
    expect(prompts[0]).toContain("file:///project/README.md");
  });

  it("refuses an empty prompt rather than spending a model call on nothing", async () => {
    const value = await ready();
    const response = await value.call("session/prompt", { sessionId: "sess_1", prompt: [] }, 3);
    expect(response).toMatchObject({ error: { code: JSON_RPC.invalidParams } });
  });

  it("reports every terminal status as one of the protocol's stop reasons", async () => {
    expect(acpStopReason("completed")).toBe("end_turn");
    expect(acpStopReason("needs_verification")).toBe("end_turn");
    expect(acpStopReason("failed")).toBe("end_turn");
    expect(acpStopReason("needs_approval")).toBe("end_turn");
    expect(acpStopReason("cancelled")).toBe("cancelled");
    expect(acpStopReason("blocked")).toBe("refusal");
    expect(acpStopReason("iteration_limit")).toBe("max_turn_requests");
  });

  it("streams a turn's events as session/update notifications on the same session", async () => {
    const value = await ready();
    value.emit({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "Looking..." } });
    value.emit({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "edit_file", effect: "workspace", arguments: { path: "src/app.ts" } } });
    value.emit({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "edit_file", isError: false, effect: "workspace", content: "1 replacement" } });
    // Local bookkeeping an editor cannot act on stays out of the client's transcript.
    value.emit({ type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 8 });

    const updates = value.sent.filter((message): message is Extract<JsonRpcOutgoing, { method: string }> => "method" in message && message.method === "session/update");
    expect(updates.map((update) => (update.params?.update as { sessionUpdate: string }).sessionUpdate)).toEqual(["agent_message_chunk", "tool_call", "tool_call_update"]);
    expect(updates.every((update) => update.params?.sessionId === "sess_1")).toBe(true);
  });
});

describe("acp permission requests", () => {
  it("asks the client, and treats anything that is not an explicit allow as a refusal", async () => {
    const answers: Record<string, unknown> = {
      "nova-1": { outcome: "selected", selectedOptionId: "allow" },
      "nova-2": { outcome: "selected", selectedOptionId: "allow_always" },
      "nova-3": { outcome: "cancelled" },
      "nova-4": { outcome: "selected", selectedOptionId: "something_else" },
    };
    const sent: JsonRpcOutgoing[] = [];
    let ask: ((request: { toolName: string; summary: string; toolCallId: string }) => Promise<string>) | undefined;
    const connection = new AcpConnection({
      send: (message) => {
        sent.push(message);
        // Stand in for the editor: answer every request the agent makes as soon as it makes it.
        if ("method" in message && message.method === "session/request_permission" && message.id !== undefined) {
          void connection.receive({ jsonrpc: "2.0", id: message.id, result: answers[String(message.id)] });
        }
      },
      createSession: async ({ approve }) => {
        ask = approve;
        return { id: "sess_1", async send() { return { status: "completed" as const, summary: "" }; }, cancel() {}, async setMode() {}, async dispose() {} };
      },
    });
    await connection.receive({ jsonrpc: "2.0", id: 1, method: "initialize", params: initialize });
    await connection.receive({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/tmp/p" } });

    const decisions = [];
    for (const toolName of ["write_file", "run_command", "run_command", "write_file"]) {
      decisions.push(await ask!({ toolName, summary: `${toolName} something`, toolCallId: "c1" }));
    }
    expect(decisions).toEqual(["allow", "allow_always", "deny", "deny"]);

    const request = sent.find((message) => "method" in message && message.method === "session/request_permission");
    expect(request).toMatchObject({ params: { sessionId: "sess_1", toolCall: { kind: "edit", status: "pending" } } });
    expect((request as unknown as { params: { options: Array<{ optionId: string }> } }).params.options.map((option) => option.optionId))
      .toEqual(["allow", "allow_always", "deny", "deny_always"]);
  });

  it("reads an unknown option id as a denial", () => {
    expect(decisionFromOptionId("allow")).toBe("allow");
    expect(decisionFromOptionId("allow_always")).toBe("allow_always");
    expect(decisionFromOptionId("deny_always")).toBe("deny_always");
    expect(decisionFromOptionId(undefined)).toBe("deny");
    expect(decisionFromOptionId("yes please")).toBe("deny");
    expect(decisionFromOptionId(42)).toBe("deny");
  });
});

describe("acp rendering hints", () => {
  it("classifies tools by what they do to the world, and unknown ones safely", () => {
    expect(acpToolKind("read_file")).toBe("read");
    expect(acpToolKind("edit_file")).toBe("edit");
    expect(acpToolKind("run_command")).toBe("execute");
    expect(acpToolKind("grep_files")).toBe("search");
    expect(acpToolKind("web_fetch")).toBe("fetch");
    expect(acpToolKind("todo_write")).toBe("think");
    expect(acpToolKind("some_mcp_tool")).toBe("other");
  });

  it("titles a call by the work, not by the function name", () => {
    expect(toolCallTitle("edit_file", { path: "src/app.ts" })).toBe("edit file: src/app.ts");
    expect(toolCallTitle("run_command", { command: "bun test" })).toBe("run command: bun test");
    expect(toolCallTitle("todo_read", {})).toBe("todo read");
    expect(toolCallTitle("read_file", { path: "x".repeat(400) }).length).toBeLessThan(140);
  });

  it("passes a failed tool through as a failed call, keeping its output", () => {
    const update = acpUpdateFor({ type: "runtime", event: { type: "tool_result", toolCallId: "c9", toolName: "run_command", isError: true, effect: "none", content: "exit 1: tests failed" } });
    expect(update).toMatchObject({ sessionUpdate: "tool_call_update", toolCallId: "c9", status: "failed" });
    expect(JSON.stringify(update)).toContain("tests failed");
  });
});
