import type { AgentRuntimeResult } from "@circuit-nova/nova-core/agent-runtime";
import type { NovaEvent } from "@circuit-nova/nova-core/nova-cli/agent";
import { runtimeEventForJournal } from "@circuit-nova/nova-core/nova-cli/protocol";

/**
 * Nova speaking to a program instead of a person.
 *
 * A CLI that another tool drives has two hard requirements a human-facing one does not:
 *
 * **One channel carries data, the other carries talk.** Every byte on stdout is a complete JSON
 * object followed by a newline — no banner, no spinner, no colour, no partial line ever. Anything
 * a person would want to read goes to stderr. A caller can therefore pipe stdout straight into a
 * parser without filtering, which is the whole point: the moment stdout can contain prose, every
 * consumer needs a heuristic, and heuristics are where integrations rot.
 *
 * **The exit code means something specific.** "Non-zero" cannot distinguish "the model refused"
 * from "the budget ran out" from "this needed a human", and those want different responses from a
 * caller. `EXIT_CODES` gives each terminal status its own number and never reuses one.
 *
 * Redaction is deliberately not reimplemented here — `runtimeEventForJournal` already decides what
 * is safe to write down for the audit journal, and a second definition of "safe" would eventually
 * disagree with the first.
 */

export const HEADLESS_PROTOCOL_VERSION = 1 as const;

/**
 * Terminal exit codes, stable across releases.
 *
 * Numbers are part of the contract: a caller branching on 4 must keep meaning "the work was not
 * verified" forever. Add new codes rather than repurposing these, and stay below 125 — the shell
 * reserves 126/127 for "cannot execute" and 128+n for signal deaths, so a code up there would be
 * indistinguishable from Nova never having run at all.
 */
export const EXIT_CODES = {
  completed: 0,
  /** An unexpected failure: a crash, a provider error, a malformed model turn. */
  failed: 1,
  /** The invocation itself was wrong — bad flags, no prompt, nothing configured. */
  usage: 2,
  /** The model refused, or a policy or human denied a required action. */
  blocked: 3,
  /** Workspace changed without passing verification evidence. */
  needs_verification: 4,
  /** An action needed a human decision, and headless mode has no one to ask. */
  needs_approval: 5,
  /** An iteration, tool-call or budget ceiling stopped the run. */
  limit: 6,
  /** Interrupted — SIGINT, or a cancellation requested by the caller. */
  cancelled: 7,
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

/**
 * Maps a finished run to its exit code.
 *
 * Total over `AgentRuntimeResult["status"]` by construction: the record below has one entry per
 * member, so a status added to the runtime fails to compile here until it is given a meaning,
 * rather than silently becoming a generic failure.
 */
const STATUS_EXIT: Record<AgentRuntimeResult["status"], ExitCode> = {
  completed: EXIT_CODES.completed,
  failed: EXIT_CODES.failed,
  blocked: EXIT_CODES.blocked,
  needs_approval: EXIT_CODES.needs_approval,
  needs_verification: EXIT_CODES.needs_verification,
  cancelled: EXIT_CODES.cancelled,
  iteration_limit: EXIT_CODES.limit,
};

export function exitCodeForStatus(status: AgentRuntimeResult["status"]): ExitCode {
  return STATUS_EXIT[status];
}

export type HeadlessRecord = {
  /** Protocol version, on every line, so a consumer can branch without tracking state. */
  v: typeof HEADLESS_PROTOCOL_VERSION;
  /** Strictly increasing from 1, gapless. A gap means output was lost. */
  seq: number;
  at: string;
  type: string;
  [key: string]: unknown;
};

/** What a consumer is told about the session before any work starts. */
export type HeadlessSessionInfo = {
  sessionId: string;
  root: string;
  provider: string;
  model: string;
  mode: string;
  workspace: string;
};

export type HeadlessTurnEnd = {
  status: AgentRuntimeResult["status"];
  summary: string;
  iterations: number;
  toolCalls: number;
  usage: AgentRuntimeResult["usage"];
  /** Rendered cost, or null when the model has no published price. */
  cost: string | null;
  elapsedMs: number;
};

/**
 * Serializes one record per line.
 *
 * A value that cannot be serialized becomes an `error` record rather than a thrown exception or,
 * worse, a half-written line: a consumer reading line-delimited JSON can recover from being told
 * something went wrong, but not from a truncated object it cannot parse.
 */
export class HeadlessEmitter {
  private sequence = 0;

  constructor(
    private readonly write: (line: string) => void,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get emitted(): number {
    return this.sequence;
  }

  emit(type: string, fields: Record<string, unknown> = {}): void {
    this.sequence += 1;
    const record: HeadlessRecord = { v: HEADLESS_PROTOCOL_VERSION, seq: this.sequence, at: this.now().toISOString(), type, ...fields };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (error) {
      line = JSON.stringify({
        v: HEADLESS_PROTOCOL_VERSION, seq: this.sequence, at: record.at, type: "error",
        message: `Could not serialize a ${type} record`, cause: error instanceof Error ? error.message : String(error),
      });
    }
    this.write(`${line}\n`);
  }

  session(info: HeadlessSessionInfo): void {
    this.emit("session", { ...info, protocol: HEADLESS_PROTOCOL_VERSION });
  }

  turnStart(objective: string): void {
    this.emit("turn_start", { objective });
  }

  /**
   * One agent event out as one record.
   *
   * Assistant text is forwarded as `text` deltas rather than being buffered into a final message:
   * a caller that wants to stream needs them as they arrive, and a caller that does not can ignore
   * the type entirely — `turn_end` still carries the complete summary either way.
   */
  agentEvent(event: NovaEvent): void {
    if (event.type === "checkpoint") {
      this.emit("checkpoint", { tree: event.checkpoint.tree, label: event.checkpoint.label });
      return;
    }
    if (event.type === "compaction") {
      this.emit("compaction", { messagesBefore: event.messagesBefore, messagesAfter: event.messagesAfter });
      return;
    }
    const runtime = event.event;
    if (runtime.type === "assistant_delta") {
      this.emit("text", { text: runtime.text });
      return;
    }
    // Redacted and length-bounded by the same rules the audit journal uses.
    const safe = runtimeEventForJournal(runtime);
    if (safe.type === "tool_call") {
      this.emit("tool_call", { toolCallId: safe.toolCallId, tool: safe.toolName, effect: safe.effect, arguments: safe.arguments });
      return;
    }
    if (safe.type === "tool_result") {
      // `data` rides along when the tool produced one: a consumer branching on an exit code or a
      // byte count should read the value, not parse the sentence written for the model.
      this.emit("tool_result", {
        toolCallId: safe.toolCallId, tool: safe.toolName, effect: safe.effect, isError: safe.isError, content: safe.content,
        ...(safe.data ? { data: safe.data } : {}),
      });
      return;
    }
    if (safe.type === "model_turn") {
      this.emit("model_turn", { iteration: safe.iteration, model: safe.model, toolCalls: safe.toolCallCount, usage: safe.usage });
      return;
    }
    this.emit("runtime_stop", { status: safe.status, summary: safe.summary });
  }

  turnEnd(result: HeadlessTurnEnd): void {
    this.emit("turn_end", { ...result, exitCode: exitCodeForStatus(result.status) });
  }

  error(message: string, fields: Record<string, unknown> = {}): void {
    this.emit("error", { message, ...fields });
  }
}
