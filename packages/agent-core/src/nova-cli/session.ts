import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "../agent-runtime";
import { approximateInputTokens } from "../model-cost";

/**
 * Session persistence and context compaction.
 *
 * A terminal session that forgets everything when the process exits is a demo. Sessions are stored
 * as a plain JSON message log under `.nova/sessions`, which is deliberately the same shape the
 * runtime already passes around: resuming is reading the file back, not reconstructing state from
 * a summary of it.
 */

export type SessionRecord = {
  id: string;
  createdAt: number;
  updatedAt: number;
  root: string;
  title: string;
  messages: AgentMessage[];
  /** Standing tool approvals, so a resumed session does not re-ask what was already decided. */
  approvals: Record<string, "allow" | "deny">;
  totalRwf: number;
};

export function sessionDirectory(root: string): string {
  return path.join(root, ".nova", "sessions");
}

export function newSessionId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function saveSession(record: SessionRecord): Promise<string> {
  const directory = sessionDirectory(record.root);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${record.id}.json`);
  await fs.writeFile(file, JSON.stringify({ ...record, updatedAt: Date.now() }, null, 2), "utf8");
  return file;
}

export async function loadSession(root: string, id: string): Promise<SessionRecord | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDirectory(root), `${id}.json`), "utf8")) as SessionRecord;
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
            const record = JSON.parse(await fs.readFile(path.join(sessionDirectory(root), file), "utf8")) as SessionRecord;
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
  // The pessimistic figure, deliberately: compacting slightly early costs one summarization call,
  // while compacting late costs the whole turn to a context-length error.
  return approximateInputTokens(messages.map((message) => message.content ?? "")).maximumInputTokens;
}

export type CompactionPlan = {
  /** Messages to hand to the summarizer. */
  toSummarize: AgentMessage[];
  /** Messages kept verbatim after the summary. */
  toKeep: AgentMessage[];
};

/**
 * Decides what to compact when a conversation approaches the model's context limit.
 *
 * OpenCode's threshold — summarize at 90% of what is left after reserving the output budget — is
 * the one used here. Two rules shape the split, and both exist to avoid breaking the transcript:
 * the system and opening messages are always kept, and the tail is cut at a boundary that never
 * separates an assistant's tool calls from their results, since a tool result whose call has been
 * summarized away is an API error rather than a smaller context.
 */
export function planCompaction(
  messages: readonly AgentMessage[],
  options: { contextLimit: number; outputBudget: number; keepRecent?: number },
): CompactionPlan | null {
  const threshold = Math.max((options.contextLimit - options.outputBudget) * 0.9, 0);
  if (estimateMessageTokens(messages) <= threshold) return null;

  const keepRecent = options.keepRecent ?? 6;
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

/** The instruction used to compact a conversation, kept next to the policy that triggers it. */
export const COMPACTION_INSTRUCTION = [
  "Summarize the conversation so far so that work can continue without the full transcript.",
  "Include: what the user asked for, what has been done and verified, the exact files and symbols involved, decisions made and why, and what remains.",
  "Preserve concrete details — paths, function names, commands run and their results, error messages. Drop pleasantries and superseded attempts.",
  "Write it as notes to your future self, not as a report to the user.",
].join(" ");

export function buildCompactedMessages(summary: string, plan: CompactionPlan): AgentMessage[] {
  const system = plan.toSummarize[0]?.role === "system" ? [plan.toSummarize[0]] : [];
  return [
    ...system,
    { role: "user" as const, content: `[Earlier conversation, summarized]\n\n${summary.trim()}` },
    ...plan.toKeep,
  ];
}
