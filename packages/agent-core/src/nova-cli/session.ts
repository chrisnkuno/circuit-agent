import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { agentMessagePromptParts, type AgentMessage } from "../agent-runtime";
import { approximateInputTokens } from "../model-cost";
import type { NovaMode } from "./permissions";

/**
 * Session persistence and context compaction.
 *
 * A terminal session that forgets everything when the process exits is a demo. Sessions are stored
 * as a plain JSON message log under `.nova/sessions`, which is deliberately the same shape the
 * runtime already passes around: resuming is reading the file back, not reconstructing state from
 * a summary of it.
 */

export type SessionRecord = {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  /** Optimistic concurrency token. A stale writer is rejected instead of losing a newer turn. */
  revision: number;
  id: string;
  createdAt: number;
  updatedAt: number;
  root: string;
  title: string;
  messages: AgentMessage[];
  /** Permission posture to restore on resume; absent on sessions written before this field. */
  mode?: NovaMode;
  /** Durable-memory entries already present in this transcript, so resume does not bill them twice. */
  recalledMemoryKeys?: string[];
  /** Standing tool approvals, so a resumed session does not re-ask what was already decided. */
  approvals: Record<string, "allow" | "deny">;
  totalRwf: number;
  /** SHA-256 over the canonical record without this field. */
  integrity?: string;
};

export const SESSION_SCHEMA_VERSION = 2 as const;

export function sessionDirectory(root: string): string {
  return path.join(root, ".nova", "sessions");
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function assertSessionId(id: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id === "." || id === "..") {
    throw new Error("Session id contains unsafe characters");
  }
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return null;
}

function integrityFor(record: Omit<SessionRecord, "integrity">): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(record))).digest("hex");
}

async function acquireSessionLock(lockFile: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => { await fs.unlink(lockFile).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 30_000) {
        await fs.unlink(lockFile).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Session is being updated by another Nova process");
}

/** Atomic, checksummed and conflict-aware: an interrupted write never replaces the last snapshot. */
export async function saveSession(record: SessionRecord): Promise<string> {
  assertSessionId(record.id);
  const directory = sessionDirectory(record.root);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${record.id}.json`);
  const lockFile = `${file}.lock`;
  const release = await acquireSessionLock(lockFile);
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const fileExists = await fs.stat(file).then(() => true).catch(() => false);
    const current = await loadSession(record.root, record.id);
    if (fileExists && !current) throw new Error("Existing session is corrupt or incompatible; refusing to overwrite it");
    if (current && current.revision !== record.revision) {
      throw new Error(`Session revision conflict: expected ${record.revision}, found ${current.revision}`);
    }
    const withoutIntegrity: Omit<SessionRecord, "integrity"> = {
      ...record,
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: record.revision + 1,
      updatedAt: Date.now(),
    };
    delete (withoutIntegrity as Partial<SessionRecord>).integrity;
    const next: SessionRecord = { ...withoutIntegrity, integrity: integrityFor(withoutIntegrity) };
    const handle = await fs.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    const directoryHandle = await fs.open(directory, "r").catch(() => null);
    if (directoryHandle) {
      await directoryHandle.sync().catch(() => undefined);
      await directoryHandle.close();
    }
    Object.assign(record, next);
    return file;
  } finally {
    await fs.unlink(temporary).catch(() => undefined);
    await release();
  }
}

export async function loadSession(root: string, id: string): Promise<SessionRecord | null> {
  try {
    assertSessionId(id);
    const parsed = JSON.parse(await fs.readFile(path.join(sessionDirectory(root), `${id}.json`), "utf8")) as Partial<SessionRecord>;
    if (!parsed || typeof parsed !== "object" || parsed.id !== id || typeof parsed.root !== "string") return null;
    const [storedRoot, requestedRoot] = await Promise.all(
      [parsed.root, root].map(async (candidate) => fs.realpath(path.resolve(candidate)).catch(() => path.resolve(candidate))),
    );
    const rootsMatch = process.platform === "win32"
      ? storedRoot.toLocaleLowerCase("en-US") === requestedRoot.toLocaleLowerCase("en-US")
      : storedRoot === requestedRoot;
    if (!rootsMatch) return null;
    if (!Array.isArray(parsed.messages) || typeof parsed.approvals !== "object" || parsed.approvals === null) return null;
    if (!Number.isSafeInteger(parsed.totalRwf) || (parsed.totalRwf ?? -1) < 0) return null;
    if (typeof parsed.schemaVersion === "number" && parsed.schemaVersion > SESSION_SCHEMA_VERSION) return null;
    if (parsed.integrity) {
      const { integrity, ...withoutIntegrity } = parsed as SessionRecord;
      if (integrity !== integrityFor(withoutIntegrity)) return null;
    }
    return {
      ...(parsed as SessionRecord),
      schemaVersion: SESSION_SCHEMA_VERSION,
      revision: Number.isSafeInteger(parsed.revision) && (parsed.revision ?? -1) >= 0 ? parsed.revision! : 0,
    };
  } catch {
    return null;
  }
}

export async function listSessions(root: string, limit = 20): Promise<Array<Pick<SessionRecord, "id" | "title" | "updatedAt">>> {
  try {
    const files = await fs.readdir(sessionDirectory(root));
    const records = await Promise.all(
      files
        .filter((file) => file.endsWith(".json"))
        .map(async (file) => {
          try {
            const record = await loadSession(root, file.slice(0, -5));
            if (!record) return null;
            return { id: record.id, title: record.title, updatedAt: record.updatedAt };
          } catch {
            return null;
          }
        }),
    );
    return records
      .filter((record): record is NonNullable<typeof record> => record !== null)
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/** First line of the opening request, which is what a person recognises a session by. */
export function titleFromObjective(objective: string): string {
  return objective.trim().split("\n")[0].slice(0, 72) || "Untitled session";
}

export function estimateMessageTokens(messages: readonly AgentMessage[]): number {
  /**
   * The expected figure, not the pessimistic one.
   *
   * `maximumInputTokens` is `max(expected + 256, utf8Bytes + 1024)`, and for any real transcript
   * the *byte* term wins — it is roughly three times the token count. Comparing that against the
   * context limit meant Nova believed it was full at about 28% of a 200K window, and 5.6% of a 1M
   * one: it compacted, paid a summarization call, discarded detail, and rebuilt its whole prompt
   * cache, five times more often than it had any reason to. Measured on real source text, the
   * first `required` fired at 56,216 actual tokens against a 184,000-token allowance.
   *
   * The pessimistic reading was defensible when the alternative was losing a turn to a
   * context-length error, but it was the wrong tool for that job: the reserve for the reply is
   * already subtracted by the caller, and 0.9 of what remains is the safety margin.
   *
   * Tool-call arguments are counted too. They are part of an assistant message on the wire and
   * were invisible here, so a transcript of many tool calls read as smaller than it was — an error
   * in the opposite direction, hidden behind the first one.
   */
  const parts: string[] = [];
  for (const message of messages) parts.push(...agentMessagePromptParts(message));
  return approximateInputTokens(parts).expectedInputTokens;
}

export type CompactionPlan = {
  /** Messages to hand to the summarizer. */
  toSummarize: AgentMessage[];
  /** Messages kept verbatim after the summary. */
  toKeep: AgentMessage[];
};

/**
 * How badly a transcript needs compacting, which is not the same question as whether it may be.
 *
 * `advisable` means the conversation has grown past the point where compacting is cheap and safe;
 * `required` means the next turn will not fit and compacting is no longer optional. The split
 * exists because the right moment to forget is a property of the *work*, not of the buffer: a
 * numeric threshold alone forces a summary in the middle of a half-finished edit, where the detail
 * being discarded is exactly the detail the next tool call needs. Splitting the decision lets the
 * caller compact early when the work is at a boundary, and only override that when it must.
 */
export type CompactionUrgency = "none" | "advisable" | "required";

/** Where compacting is cheap because the work has concluded, versus mid-task where it is not. */
export type CompactionBoundary = "safe" | "mid-task";

const ADVISABLE_SHARE = 0.7;
const REQUIRED_SHARE = 0.9;

export function compactionUrgency(
  messages: readonly AgentMessage[],
  options: { contextLimit: number; outputBudget: number },
): CompactionUrgency {
  const usable = Math.max(options.contextLimit - options.outputBudget, 0);
  const used = estimateMessageTokens(messages);
  if (used > usable * REQUIRED_SHARE) return "required";
  if (used > usable * ADVISABLE_SHARE) return "advisable";
  return "none";
}

/**
 * Whether the transcript is at a point where forgetting is safe.
 *
 * Two conditions, both structural rather than guessed. The transcript must end with a plain
 * assistant message — a turn that actually concluded, rather than one suspended between a tool
 * call and its result, where summarizing would strand the call. And nothing may be marked
 * in progress on the agent's own plan: an item the agent believes it is halfway through is a
 * promise that the details behind it still matter.
 */
export function atSafeBoundary(messages: readonly AgentMessage[], options: { workInProgress?: boolean } = {}): boolean {
  if (options.workInProgress) return false;
  const last = messages.at(-1);
  return last !== undefined && last.role === "assistant" && !("toolCalls" in last);
}

/**
 * Decides what to compact when a conversation approaches the model's context limit.
 *
 * OpenCode's threshold — summarize at 90% of what is left after reserving the output budget — is
 * the ceiling used here, but not the only trigger: past 70% the transcript is compacted as soon as
 * the work reaches a boundary, so the summary is written where there is a clean thing to say
 * rather than wherever the buffer happened to fill. Two rules then shape the split, and both exist
 * to avoid breaking the transcript: the system and opening messages are always kept, and the tail
 * is cut at a boundary that never separates an assistant's tool calls from their results, since a
 * tool result whose call has been summarized away is an API error rather than a smaller context.
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  options: { contextLimit: number; outputBudget: number; keepRecent?: number; boundary?: CompactionBoundary },
): CompactionPlan | null {
  const urgency = compactionUrgency(messages, options);
  if (urgency === "none") return null;
  if (urgency === "advisable" && (options.boundary ?? "mid-task") !== "safe") return null;

  const keepRecent = options.keepRecent ?? recentToKeep(messages.slice(messages[0]?.role === "system" ? 2 : 1), options);
  // The system prompt and the original request are what the whole session means; they never go.
  const head = messages.slice(0, messages[0]?.role === "system" ? 2 : 1);
  const rest = messages.slice(head.length);
  if (rest.length <= keepRecent) return null;

  let cut = rest.length - keepRecent;
  // Walk the cut backwards until the kept tail does not begin with orphaned tool results.
  while (cut > 0 && rest[cut]?.role === "tool") cut -= 1;
  if (cut <= 0) return null;

  return { toSummarize: [...head, ...rest.slice(0, cut)], toKeep: rest.slice(cut) };
}

/**
 * The fewest recent messages worth keeping verbatim, measured in tokens rather than counted.
 *
 * "Keep the last six messages" treats a two-line acknowledgement and a 40,000-character test log as
 * the same size. Six of the latter is around 60,000 tokens carried past a compaction that happened
 * *because* the transcript was too large; six of the former is 300 tokens, and throws away context
 * the next turn plainly needed. Neither is what the number was trying to express.
 *
 * What it was trying to express is: leave enough of the recent conversation intact that the agent
 * can continue without re-reading the summary for details it just had. That is a size, so it is
 * measured as one — a fifth of the usable window — with a floor of one complete exchange, because a
 * kept tail of nothing is a compaction the agent cannot continue from at all.
 */
const KEEP_RECENT_SHARE = 0.2;
const MINIMUM_KEPT_MESSAGES = 2;

function recentToKeep(recent: readonly AgentMessage[], options: { contextLimit: number; outputBudget: number }): number {
  const budget = Math.max(0, options.contextLimit - options.outputBudget) * KEEP_RECENT_SHARE;
  let spent = 0;
  let kept = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const cost = estimateMessageTokens([recent[index]]);
    if (kept >= MINIMUM_KEPT_MESSAGES && spent + cost > budget) break;
    spent += cost;
    kept += 1;
  }
  return Math.min(recent.length, Math.max(MINIMUM_KEPT_MESSAGES, kept));
}

/** The instruction used to compact a conversation, kept next to the policy that triggers it. */
export const COMPACTION_INSTRUCTION = [
  "Summarize the conversation so far so that work can continue without the full transcript.",
  "Include: what the user asked for, what has been done and verified, the exact files and symbols involved, decisions made and why, and what remains.",
  "Preserve concrete details — paths, function names, commands run and their results, error messages. Drop pleasantries and superseded attempts.",
  "Reproduce every standing instruction, prohibition and constraint the user gave, verbatim and in full, however long ago it was said — these are the one thing that must never be shortened or paraphrased away.",
  "Write it as notes to your future self, not as a report to the user.",
].join(" ");

/**
 * The governing facts of a session, which a summary is not allowed to be the only record of.
 *
 * Summarization is lossy by design, and what it loses first is the boring part: the permission
 * mode, which exact actions the user has already approved or refused, what the session is
 * permitted to spend, what the original request actually said. Every one of those is a constraint
 * on what the agent may *do*, and a constraint that survives only as a sentence in a summary is a
 * constraint that quietly stops existing three compactions later — the failure mode is silent,
 * because nothing errors when a rule is simply no longer mentioned.
 *
 * So they are never summarized. They are re-derived from live state at every compaction and
 * re-stated verbatim, which means the block cannot drift from the ledger it describes: it is a
 * rendering of the ledger, not a memory of it.
 */
export type StandingConstraints = {
  mode: string;
  /** The request that opened the session, in full. */
  objective: string;
  /** Decisions the user has already made about specific actions. */
  approvals: Record<string, "allow" | "deny">;
  /** Items the agent's own plan still has open. */
  openTodos: string[];
  /** What is left to spend, already formatted for a person. */
  budgetRemaining?: string;
};

export const STANDING_CONSTRAINTS_HEADING = "[Standing constraints — still in force, not a summary]";

export function standingConstraintsBlock(constraints: StandingConstraints): string {
  const allowed = Object.entries(constraints.approvals).filter(([, decision]) => decision === "allow").map(([key]) => key);
  const denied = Object.entries(constraints.approvals).filter(([, decision]) => decision === "deny").map(([key]) => key);
  return [
    STANDING_CONSTRAINTS_HEADING,
    `Permission mode: ${constraints.mode}.`,
    `Original request: ${constraints.objective.trim()}`,
    allowed.length > 0 ? `Actions the user has standing-approved: ${allowed.join(", ")}.` : "No action has standing approval; every effectful call is asked for.",
    ...(denied.length > 0 ? [`Actions the user has refused — do not propose them again: ${denied.join(", ")}.`] : []),
    ...(constraints.openTodos.length > 0 ? [`Still open: ${constraints.openTodos.join("; ")}.`] : []),
    ...(constraints.budgetRemaining ? [`Remaining approved spend: ${constraints.budgetRemaining}.`] : []),
  ].join("\n");
}

/**
 * The transcript after compaction: the system message, the constraints, the summary, the tail.
 *
 * Constraints first and summary second, deliberately. The summary is the part the model reasons
 * *from*; the constraints are the part it must reason *within*, and putting them ahead of the
 * narrative keeps them from reading as one more historical detail that happened to be mentioned.
 */
export function buildCompactedMessages(summary: string, plan: CompactionPlan, standing?: StandingConstraints): AgentMessage[] {
  const system = plan.toSummarize[0]?.role === "system" ? [plan.toSummarize[0]] : [];
  return [
    ...system,
    ...(standing ? [{ role: "user" as const, content: standingConstraintsBlock(standing) }] : []),
    { role: "user" as const, content: `[Earlier conversation, summarized]\n\n${summary.trim()}` },
    ...plan.toKeep,
  ];
}
