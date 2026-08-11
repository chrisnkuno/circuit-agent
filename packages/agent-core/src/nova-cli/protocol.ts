import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type { AgentRuntimeEvent, ToolEffect } from "../agent-runtime";
import type { ApprovalRequest, PermissionDecision } from "./permissions";

/**
 * Nova's narrow waist between the kernel, persistence and every present or future client.
 *
 * This is intentionally small. A protocol with twenty reliable events is faster to evolve than a
 * CLI whose renderer, session files and runtime each invent a different meaning for “turn done”.
 */
export const NOVA_PROTOCOL_VERSION = 1 as const;
export const JOURNAL_GENESIS_HASH = "0".repeat(64);

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "blocked"
  | "needs_verification"
  | "cancelled"
  | "failed"
  | "iteration_limit";

const TRANSITIONS: Readonly<Record<TurnStatus, readonly TurnStatus[]>> = {
  queued: ["running", "cancelled", "failed"],
  running: ["waiting_approval", "completed", "blocked", "needs_verification", "cancelled", "failed", "iteration_limit"],
  waiting_approval: ["running", "blocked", "cancelled", "failed"],
  completed: [],
  blocked: [],
  needs_verification: [],
  cancelled: [],
  failed: [],
  iteration_limit: [],
};

export function assertTurnTransition(from: TurnStatus, to: TurnStatus): void {
  if (!TRANSITIONS[from].includes(to)) throw new Error(`Illegal Nova turn transition: ${from} -> ${to}`);
}

type DurableRuntimeEvent = Exclude<AgentRuntimeEvent, { type: "assistant_delta" }>;

const SENSITIVE_KEY = /(authorization|cookie|credential|password|private.?key|secret|token)/i;

function boundedJournalValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = value.replace(/((?:api[_-]?key|authorization|password|secret|token)\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
    if (redacted.length <= 4_000) return redacted;
    const digest = createHash("sha256").update(value).digest("hex");
    return `${redacted.slice(0, 4_000)}\n...[${redacted.length - 4_000} chars omitted; original sha256=${digest}]`;
  }
  if (Array.isArray(value)) return value.map((item) => boundedJournalValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, item]) => [childKey, boundedJournalValue(item, childKey)]));
  }
  return value;
}

/** Keeps the audit useful without turning it into an unbounded secret-bearing transcript. */
export function runtimeEventForJournal(event: DurableRuntimeEvent): DurableRuntimeEvent {
  if (event.type === "tool_call") return { ...event, arguments: boundedJournalValue(event.arguments) as Record<string, unknown> };
  // `data` goes through the same redaction and bounding as `content` — it holds the same facts,
  // so a secret that must not reach the journal in prose must not reach it as a value either.
  if (event.type === "tool_result") {
    return {
      ...event,
      content: boundedJournalValue(event.content) as string,
      ...(event.data ? { data: boundedJournalValue(event.data) as Record<string, unknown> } : {}),
    };
  }
  return event;
}

export type NovaProtocolPayload =
  | { type: "turn_status"; turnId: string; from: TurnStatus; to: TurnStatus }
  // `effect` and `capabilityId` ride along so the audit records what the human was actually
  // authorizing, not merely which tool asked. A digest alone cannot be read back by a person.
  | { type: "approval_requested"; turnId: string; request: Pick<ApprovalRequest, "summary" | "actionDigest" | "scopeKey" | "policyVersion"> & { toolCallId: string; toolName: string; effect: ToolEffect; capabilityId: string } }
  | { type: "approval_decided"; turnId: string; actionDigest: string; decision: PermissionDecision }
  | { type: "runtime"; turnId: string; event: DurableRuntimeEvent }
  | { type: "compaction"; turnId: string; messagesBefore: number; messagesAfter: number; actualRwf: number };

export type NovaEventEnvelope = {
  protocolVersion: typeof NOVA_PROTOCOL_VERSION;
  sequence: number;
  sessionId: string;
  timestamp: string;
  previousHash: string;
  payload: NovaProtocolPayload;
  hash: string;
};

function hashEnvelope(envelope: Omit<NovaEventEnvelope, "hash">): string {
  return createHash("sha256").update(JSON.stringify(envelope)).digest("hex");
}

export function eventJournalPath(root: string, sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(sessionId)) throw new Error("Session id contains unsafe characters");
  return path.join(root, ".nova", "events", `${sessionId}.jsonl`);
}

/** Reads and verifies every complete line; a crash-truncated final line is safely ignored. */
export async function readEventJournal(root: string, sessionId: string): Promise<NovaEventEnvelope[]> {
  const file = eventJournalPath(root, sessionId);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const completeText = text.endsWith("\n") ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const events = completeText.split("\n").filter(Boolean).map((line) => JSON.parse(line) as NovaEventEnvelope);
  let previousHash = JOURNAL_GENESIS_HASH;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.protocolVersion !== NOVA_PROTOCOL_VERSION) throw new Error(`Unsupported Nova protocol version ${event.protocolVersion}`);
    if (event.sessionId !== sessionId || event.sequence !== index + 1 || event.previousHash !== previousHash) {
      throw new Error(`Invalid Nova event chain at sequence ${event.sequence}`);
    }
    const { hash, ...withoutHash } = event;
    if (hash !== hashEnvelope(withoutHash)) throw new Error(`Nova event integrity check failed at sequence ${event.sequence}`);
    previousHash = hash;
  }
  return events;
}

/**
 * Serialized, append-only writer with a persistent file handle.
 *
 * Callers choose `durable` for the boundaries that must reach disk before a side effect starts.
 * Model/result telemetry can share the same handle without paying an fsync per token delta.
 */
export class EventJournal {
  private handle: FileHandle | null = null;
  private sequence = 0;
  private previousHash = JOURNAL_GENESIS_HASH;
  private initialized: Promise<void> | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly sessionId: string) {}

  private async initialize(): Promise<void> {
    const previous = await readEventJournal(this.root, this.sessionId);
    this.sequence = previous.length;
    this.previousHash = previous.at(-1)?.hash ?? JOURNAL_GENESIS_HASH;
    const file = eventJournalPath(this.root, this.sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const existing = await fs.readFile(file, "utf8").catch(() => "");
    if (existing && !existing.endsWith("\n")) {
      const complete = existing.slice(0, existing.lastIndexOf("\n") + 1);
      await fs.truncate(file, Buffer.byteLength(complete, "utf8"));
    }
    this.handle = await fs.open(file, "a", 0o600);
  }

  append(payload: NovaProtocolPayload, options: { durable?: boolean } = {}): Promise<NovaEventEnvelope> {
    let written!: NovaEventEnvelope;
    const operation = this.tail.then(async () => {
      this.initialized ??= this.initialize();
      await this.initialized;
      const withoutHash: Omit<NovaEventEnvelope, "hash"> = {
        protocolVersion: NOVA_PROTOCOL_VERSION,
        sequence: this.sequence + 1,
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        previousHash: this.previousHash,
        payload,
      };
      written = { ...withoutHash, hash: hashEnvelope(withoutHash) };
      await this.handle!.write(`${JSON.stringify(written)}\n`);
      if (options.durable) await this.handle!.sync();
      this.sequence = written.sequence;
      this.previousHash = written.hash;
    });
    this.tail = operation;
    return operation.then(() => written);
  }

  async flush(): Promise<void> {
    await this.tail;
    await this.handle?.sync();
  }

  async close(): Promise<void> {
    await this.flush();
    await this.handle?.close();
    this.handle = null;
  }
}
