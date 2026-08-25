import type { AgentRuntimeResult } from "../agent-runtime";
import type { NovaEvent } from "./agent";
import type { NovaMode, PermissionDecision } from "./permissions";

/**
 * Nova as an ACP agent: the same session, driven by an editor instead of a terminal.
 *
 * The Agent Client Protocol is JSON-RPC 2.0 over stdio, and it exists for exactly one reason —
 * without it, every editor that wants to host an agent has to write a bespoke integration for
 * every agent, which is the N×M problem LSP solved for language servers. Nova already has the two
 * things the protocol needs and neither is easy to retrofit: a turn that streams structured events
 * rather than raw text, and an approval gate that can pause a turn and wait for a human. This file
 * is the translation layer between those and the wire, and deliberately nothing else.
 *
 * It owns no transport and no agent. A connection is handed `send` (write one JSON-RPC message)
 * and a factory that makes sessions, which is what keeps the protocol testable without a subprocess
 * on one side and a model on the other: the tests here drive real messages through a fake agent and
 * assert on the exact frames that come back.
 */

/** The major version of the wire shape this implements. */
export const ACP_PROTOCOL_VERSION = 1;

export type JsonValue = unknown;
export type JsonRpcId = string | number;

export type JsonRpcRequest = { jsonrpc: "2.0"; id?: JsonRpcId; method: string; params?: Record<string, JsonValue> };
export type JsonRpcResponse = { jsonrpc: "2.0"; id: JsonRpcId; result: JsonValue } | { jsonrpc: "2.0"; id: JsonRpcId; error: { code: number; message: string; data?: JsonValue } };
export type JsonRpcOutgoing = JsonRpcRequest | JsonRpcResponse;

/** JSON-RPC's own codes; the protocol defines no others that this agent can raise. */
export const JSON_RPC = { parseError: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, internalError: -32603 } as const;

/** What ACP calls a session: one Nova agent, bound to one working directory. */
export interface AcpSession {
  readonly id: string;
  send(prompt: string): Promise<Pick<AgentRuntimeResult, "status" | "summary">>;
  cancel(): void;
  /** Async because a mode is a capability boundary: Nova changes it by rebuilding the session under it. */
  setMode(mode: NovaMode): Promise<void>;
  dispose(): Promise<void>;
}

export type AcpSessionFactory = (input: {
  cwd: string;
  /** Streamed straight out as `session/update` notifications. */
  onEvent: (event: NovaEvent) => void;
  /** Asks the *client* to decide, since in ACP the editor owns the human. */
  approve: (request: { toolName: string; summary: string; toolCallId: string }) => Promise<PermissionDecision>;
  /** Present only for `session/load`: resume this stored session rather than starting one. */
  resumeSessionId?: string;
}) => Promise<AcpSession>;

export const ACP_MODES: NovaMode[] = ["plan", "build", "auto", "defender"];

/**
 * How a Nova tool name reads to an editor.
 *
 * ACP's `kind` is what a client renders an icon and a label from, so the mapping is by what the
 * tool *does* to the world rather than by which package it came from. Anything unrecognised —
 * every MCP, skill and plugin tool, which are exactly the ones Nova cannot know the names of — is
 * `other`, which every client is required to handle.
 */
export function acpToolKind(toolName: string): "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other" {
  if (/^(read_file|list_files)$/.test(toolName)) return "read";
  if (/^(write_file|edit_file)$/.test(toolName)) return "edit";
  if (/^(glob_files|grep_files|scan_secrets)$/.test(toolName)) return "search";
  if (/^(run_command|start_application|application_status|stop_application|run_tests|verify|typecheck|lint)$/.test(toolName)) return "execute";
  if (/^(web_search|deep_research|web_fetch)$/.test(toolName)) return "fetch";
  if (/^(todo_write|todo_read|remember|delegate_task)$/.test(toolName)) return "think";
  return "other";
}

/** Nova's terminal statuses, said in the four words ACP has for them. */
export function acpStopReason(status: AgentRuntimeResult["status"]): "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled" {
  if (status === "cancelled") return "cancelled";
  if (status === "blocked") return "refusal";
  if (status === "iteration_limit") return "max_turn_requests";
  return "end_turn";
}

/** The four decisions Nova's ledger understands, as the option list a client renders. */
export const ACP_PERMISSION_OPTIONS = [
  { optionId: "allow", name: "Allow", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow this action from now on", kind: "allow_always" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
  { optionId: "deny_always", name: "Deny this action from now on", kind: "reject_always" },
] as const;

export function decisionFromOptionId(optionId: unknown): PermissionDecision {
  // Anything unrecognised is a refusal. An editor that answers with a string this agent does not
  // know must never be read as consent — the safe reading of an unparseable answer is "no".
  return optionId === "allow" || optionId === "allow_always" || optionId === "deny_always" ? optionId : "deny";
}

function textBlocksToPrompt(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const value = block as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") return value.text;
      // An embedded resource carries its own text; a link carries only where it is. Both are worth
      // passing through, because a client that attached a file meant the agent to see it.
      if (value.type === "resource" && typeof value.resource === "object" && value.resource !== null) {
        const resource = value.resource as Record<string, unknown>;
        const uri = typeof resource.uri === "string" ? resource.uri : "attached resource";
        return typeof resource.text === "string" ? `<resource uri="${uri}">\n${resource.text}\n</resource>` : uri;
      }
      if (value.type === "resource_link" && typeof value.uri === "string") return value.uri;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

/**
 * One ACP connection: dispatches incoming messages and streams a session's events back out.
 *
 * Requests this agent makes of the *client* (only `session/request_permission` today) are tracked
 * by id here, because JSON-RPC is symmetric and the same pipe carries both directions. A response
 * that arrives for an id nobody is waiting on is dropped rather than thrown: a client is allowed to
 * be late, and a late answer must not take down a live session.
 */
export class AcpConnection {
  private readonly sessions = new Map<string, AcpSession>();
  private readonly pending = new Map<JsonRpcId, { resolve: (value: JsonValue) => void; reject: (error: Error) => void }>();
  private nextRequestId = 1;
  private initialized = false;

  constructor(private readonly dependencies: { send: (message: JsonRpcOutgoing) => void; createSession: AcpSessionFactory }) {}

  /** Feeds one parsed incoming message in. Responses are written through `send`. */
  async receive(message: unknown): Promise<void> {
    if (typeof message !== "object" || message === null) return;
    const value = message as Record<string, JsonValue>;
    if ("result" in value || "error" in value) {
      this.settle(value);
      return;
    }
    const id = value.id as JsonRpcId | undefined;
    const method = value.method;
    if (typeof method !== "string") {
      if (id !== undefined) this.fail(id, JSON_RPC.invalidRequest, "A JSON-RPC request must name a method");
      return;
    }
    try {
      const result = await this.dispatch(method, (value.params as Record<string, JsonValue>) ?? {});
      // A notification (no id) gets no reply, even when the handler returned something.
      if (id !== undefined) this.dependencies.send({ jsonrpc: "2.0", id, result: result ?? null });
    } catch (error) {
      const code = error instanceof AcpError ? error.code : JSON_RPC.internalError;
      if (id !== undefined) this.fail(id, code, error instanceof Error ? error.message : "Agent failed");
    }
  }

  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) await session.dispose().catch(() => undefined);
    this.sessions.clear();
    for (const waiter of this.pending.values()) waiter.reject(new Error("Connection closed"));
    this.pending.clear();
  }

  private settle(value: Record<string, JsonValue>): void {
    const waiter = this.pending.get(value.id as JsonRpcId);
    if (!waiter) return;
    this.pending.delete(value.id as JsonRpcId);
    if ("error" in value) {
      const error = value.error as { message?: string } | undefined;
      waiter.reject(new Error(error?.message ?? "Client returned an error"));
      return;
    }
    waiter.resolve(value.result);
  }

  private fail(id: JsonRpcId, code: number, message: string): void {
    this.dependencies.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private request(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    const id = `nova-${this.nextRequestId++}`;
    return new Promise<JsonValue>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.dependencies.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: Record<string, JsonValue>): void {
    this.dependencies.send({ jsonrpc: "2.0", method, params });
  }

  private sessionFor(params: Record<string, JsonValue>): AcpSession {
    const sessionId = params.sessionId;
    const session = typeof sessionId === "string" ? this.sessions.get(sessionId) : undefined;
    if (!session) throw new AcpError(JSON_RPC.invalidParams, `Unknown session ${String(sessionId)}`);
    return session;
  }

  private async dispatch(method: string, params: Record<string, JsonValue>): Promise<JsonValue> {
    switch (method) {
      case "initialize": {
        this.initialized = true;
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: false, audio: false, embeddedContext: true },
          },
          // Nova authenticates through provider environment variables and its own settings file,
          // so there is no in-band method for a client to offer. An empty list says exactly that.
          authMethods: [],
        };
      }
      case "authenticate":
        return {};
      case "session/new":
      case "session/load": {
        if (!this.initialized) throw new AcpError(JSON_RPC.invalidRequest, "initialize must come first");
        const cwd = typeof params.cwd === "string" ? params.cwd : process.cwd();
        const resumeSessionId = method === "session/load" && typeof params.sessionId === "string" ? params.sessionId : undefined;
        // The callbacks need the session's id, which the factory has not returned yet. Bound
        // through a variable rather than by capturing the result, so a factory that emits an event
        // while it is still constructing drops that event instead of throwing on an unset binding.
        let bound: AcpSession | undefined;
        const session = await this.dependencies.createSession({
          cwd,
          resumeSessionId,
          onEvent: (event) => { if (bound) this.publish(bound.id, event); },
          approve: async (request) => (bound ? this.askClient(bound.id, request) : "deny"),
        });
        bound = session;
        this.sessions.set(session.id, session);
        return method === "session/load"
          ? {}
          : { sessionId: session.id, modes: { currentModeId: "build", availableModes: ACP_MODES.map((mode) => ({ id: mode, name: mode })) } };
      }
      case "session/set_mode": {
        const session = this.sessionFor(params);
        const mode = ACP_MODES.find((candidate) => candidate === params.modeId);
        if (!mode) throw new AcpError(JSON_RPC.invalidParams, `Unknown mode ${String(params.modeId)}`);
        await session.setMode(mode);
        return {};
      }
      case "session/prompt": {
        const session = this.sessionFor(params);
        const prompt = textBlocksToPrompt(params.prompt);
        if (!prompt.trim()) throw new AcpError(JSON_RPC.invalidParams, "prompt must contain at least one text block");
        const result = await session.send(prompt);
        return { stopReason: acpStopReason(result.status) };
      }
      case "session/cancel": {
        // A notification: cancelling an unknown session is not worth an error nobody will read.
        const sessionId = params.sessionId;
        if (typeof sessionId === "string") this.sessions.get(sessionId)?.cancel();
        return null;
      }
      case "session/close": {
        const session = this.sessionFor(params);
        this.sessions.delete(session.id);
        await session.dispose();
        return {};
      }
      default:
        throw new AcpError(JSON_RPC.methodNotFound, `Method not found: ${method}`);
    }
  }

  private async askClient(sessionId: string, request: { toolName: string; summary: string; toolCallId: string }): Promise<PermissionDecision> {
    const answer = await this.request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: request.toolCallId, title: request.summary, kind: acpToolKind(request.toolName), status: "pending" },
      options: ACP_PERMISSION_OPTIONS.map((option) => ({ ...option })),
    }).catch(() => null);
    if (typeof answer !== "object" || answer === null) return "deny";
    const outcome = answer as Record<string, unknown>;
    // `cancelled` is the client saying the human went away. That is not consent either.
    if (outcome.outcome !== "selected") return "deny";
    return decisionFromOptionId(outcome.selectedOptionId);
  }

  /** One Nova event, as whichever `session/update` an editor can render. */
  private publish(sessionId: string, event: NovaEvent): void {
    const update = acpUpdateFor(event);
    if (update) this.notify("session/update", { sessionId, update });
  }
}

export class AcpError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = "AcpError";
  }
}

/**
 * The event translation, kept as a pure function so it can be asserted on directly.
 *
 * Not every Nova event has an ACP shape, and inventing one would be worse than dropping it: a
 * checkpoint is a local git detail an editor cannot act on, and a compaction is bookkeeping. They
 * return `null` and stay out of the client's transcript.
 */
export function acpUpdateFor(event: NovaEvent): Record<string, JsonValue> | null {
  if (event.type !== "runtime") return null;
  const runtime = event.event;
  switch (runtime.type) {
    case "assistant_delta":
      return { sessionUpdate: "agent_message_chunk", content: { type: "text", text: runtime.text } };
    case "tool_call":
      return {
        sessionUpdate: "tool_call",
        toolCallId: runtime.toolCallId,
        title: toolCallTitle(runtime.toolName, runtime.arguments),
        kind: acpToolKind(runtime.toolName),
        status: "in_progress",
        rawInput: runtime.arguments,
      };
    case "tool_result":
      return {
        sessionUpdate: "tool_call_update",
        toolCallId: runtime.toolCallId,
        status: runtime.isError ? "failed" : "completed",
        content: [{ type: "content", content: { type: "text", text: runtime.content } }],
      };
    default:
      return null;
  }
}

/** "edit src/app.ts" rather than "edit_file", which is the tool's name and not the work. */
export function toolCallTitle(toolName: string, argumentsValue: Record<string, unknown>): string {
  const subject = ["path", "command", "pattern", "query", "task"].map((key) => argumentsValue[key]).find((value) => typeof value === "string" && value.trim());
  const label = toolName.replace(/_/g, " ");
  return subject ? `${label}: ${String(subject).slice(0, 120)}` : label;
}
