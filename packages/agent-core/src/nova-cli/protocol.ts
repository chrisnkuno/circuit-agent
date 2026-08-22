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
const SECRET_ASSIGNMENT = /((?:[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?key(?:_id)?|authorization|credential|password|passwd|private[_-]?key|secret|token)[A-Za-z0-9_]*)\s*[:=]\s*)([^\s,;]+)/gi;
const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g;
const AUTHENTICATED_URL = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;

function redactJournalString(value: string): string {
  return value
    .replace(PRIVATE_KEY_BLOCK, "[REDACTED PRIVATE KEY]")
    .replace(AUTHENTICATED_URL, "$1[REDACTED]@")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]");
}

function boundedJournalValue(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    const redacted = redactJournalString(value);
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
/**
 * The journal, read once: its verified events and the exact bytes they came from.
 *
 * `EventJournal.initialize` needs both — the chain, to know where to continue from, and whether the
 * file ends mid-line, to truncate a torn write. It used to call `readEventJournal` and then read
 * the same file a second time for that one question, which at 5,000 events was a second full read,
 * parse and re-hash of everything. The bytes are right here.
 */
export async function readEventJournal(root: string, sessionId: string): Promise<NovaEventEnvelope[]> {
  return (await readJournalFile(root, sessionId)).events;
}

async function readJournalFile(root: string, sessionId: string): Promise<{ events: NovaEventEnvelope[]; text: string; completeText: string }> {
  const file = eventJournalPath(root, sessionId);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], text: "", completeText: "" };
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
  return { events, text, completeText };
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
    const { events, text, completeText } = await readJournalFile(this.root, this.sessionId);
    this.sequence = events.length;
    this.previousHash = events.at(-1)?.hash ?? JOURNAL_GENESIS_HASH;
    const file = eventJournalPath(this.root, this.sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // A file that does not end in a newline was torn by a crash mid-write. The complete prefix is
    // already computed by the read above, so this costs a `truncate` and not a second full read.
    if (text.length !== completeText.length) await fs.truncate(file, Buffer.byteLength(completeText, "utf8"));
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
