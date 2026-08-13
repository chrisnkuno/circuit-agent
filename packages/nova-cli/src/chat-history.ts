import type { AgentMessage } from "@circuit-nova/nova-core/agent-runtime";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { BOLD, CYAN, DIM, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS } from "./glyphs";
import { renderMarkdown } from "./markdown";
import { GUTTER, clip, heading, rule, type SectionStyle } from "./sections";
import { describeToolCall } from "./transcript";

/**
 * Past conversations, as something you can look through rather than a list of ids.
 *
 * `/sessions` already existed and printed `20260808T001720Z-2ubjpz  fix the failing tests`, which
 * answers "does a session exist" and nothing else. The questions people actually have about their
 * own history are "which one was that" and "what did we decide" — the first needs recency, size and
 * a searchable title; the second needs the conversation itself, replayed.
 *
 * Replay renders from the stored message log through the same markdown renderer a live turn uses,
 * so a conversation read back looks like the conversation as it happened. Tool calls collapse to
 * one line each: at read-back time the interesting thing is what was done, not the arguments it was
 * done with.
 */

export type HistoryEntry = {
  id: string;
  title: string;
  updatedAt: number;
  /** Turns, not messages: what a person counts when they ask "how long was that one". */
  turns: number;
  messages: number;
};

export function countTurns(messages: readonly AgentMessage[]): number {
  return messages.filter((message) => message.role === "user").length;
}

/** How long ago, in the units a person would say out loud. */
export function relativeTime(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  return months < 12 ? `${months}mo ago` : `${Math.round(months / 12)}y ago`;
}

export function summarizeSession(record: SessionRecord): HistoryEntry {
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
    turns: countTurns(record.messages),
    messages: record.messages.length,
  };
}

/**
 * Sessions whose title or opening request matches, most recent first.
 *
 * Matching is case-insensitive substring over the title, because a session title *is* the first
 * line of the request that started it — the words someone remembers typing are the words in it.
 */
export function searchHistory(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const matched = needle === "" ? [...entries] : entries.filter((entry) => entry.title.toLowerCase().includes(needle));
  return matched.sort((left, right) => right.updatedAt - left.updatedAt);
}

/** The list view: recency, size, and the id `/history <id>` takes. */
export function renderHistoryList(entries: readonly HistoryEntry[], style: SectionStyle, options: { now?: number; current?: string } = {}): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  if (entries.length === 0) return `${GUTTER}${paint("no past sessions in this project yet", DIM, style.depth)}`;
  const now = options.now ?? Date.now();
  const width = Math.max(0, ...entries.map((entry) => entry.title.length));
  const titleWidth = Math.min(width, Math.max(16, style.width - 34));

  const lines = entries.map((entry) => {
    const active = entry.id === options.current;
    const mark = active ? paint(glyphs.circleFull, CYAN, style.depth) : " ";
    const title = clip(entry.title || "untitled", titleWidth, glyphs).padEnd(titleWidth);
    const meta = `${relativeTime(entry.updatedAt, now)} ${glyphs.middot} ${entry.turns} turn${entry.turns === 1 ? "" : "s"}`;
    const row = `${GUTTER}${mark} ${active ? paintAll(title, [BOLD], style.depth) : title}  ${paint(meta, DIM, style.depth)}`;
    return clip(row, style.width, glyphs);
  });
  // The teaching line is clipped like everything else: it is the least important row on screen and
  // must never be the one that wraps and pushes the list out of alignment.
  const hint = clip(
    `/history <id> to read one ${glyphs.middot} /history resume to pick one up ${glyphs.middot} /history search <text>`,
    Math.max(0, style.width - GUTTER.length),
    glyphs,
  );
  return [...lines, `${GUTTER}${paint(hint, DIM, style.depth)}`].join("\n");
}

export type ReplayOptions = {
  /** Most recent N turns; the whole thing when omitted. A long session is not a thing to dump. */
  turns?: number;
  /** Tool calls are one line each unless this is off, in which case they are dropped entirely. */
  tools?: boolean;
};

/**
 * A stored conversation, rendered back into the transcript.
 *
 * Section rules separate the turns. Without them a replayed conversation is one unbroken column in
 * which the reader cannot see where a question ended and the answer began — which is exactly the
 * failure the live transcript's own turn separators exist to prevent.
 */
export function renderReplay(record: SessionRecord, style: SectionStyle, options: ReplayOptions = {}): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const out: string[] = [];
  out.push(heading(record.title || record.id, 1, style));
  out.push(`${GUTTER}${paint(`${record.id} ${glyphs.middot} ${countTurns(record.messages)} turns ${glyphs.middot} ${relativeTime(record.updatedAt)}`, DIM, style.depth)}`);

  // Turn boundaries are user messages; slicing by them is what makes `--turns 3` mean three
  // exchanges rather than three arbitrary log entries.
  const boundaries = record.messages.flatMap((message, index) => (message.role === "user" ? [index] : []));
  const from = options.turns !== undefined && boundaries.length > options.turns
    ? boundaries[boundaries.length - options.turns]
    : 0;
  if (from > 0) out.push(`${GUTTER}${paint(`${glyphs.middot.repeat(3)} earlier turns omitted`, DIM, style.depth)}`);

  let turn = 0;
  for (const message of record.messages.slice(from)) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      turn += 1;
      out.push(rule(style, { label: `turn ${turn}`, tone: "accent" }));
      out.push(message.content.split("\n").map((line) => `${GUTTER}${paint(glyphs.prompt, CYAN, style.depth)} ${paintAll(line, [BOLD], style.depth)}`).join("\n"));
      continue;
    }
    if (message.role === "tool") continue; // the call line below already says what happened
    if ("toolCalls" in message && message.toolCalls.length > 0) {
      if (options.tools === false) continue;
      for (const call of message.toolCalls) {
        const detail = describeToolCall(call.name, (call.arguments ?? {}) as Record<string, unknown>);
        out.push(`${GUTTER}${paint(glyphs.check, DIM, style.depth)} ${paint(call.name, CYAN, style.depth)}${detail ? paint(`  ${clip(detail, Math.max(8, style.width - 24), glyphs)}`, DIM, style.depth) : ""}`);
      }
      if (!message.content.trim()) continue;
    }
    if (message.content.trim()) {
      out.push(`${GUTTER}${paint(glyphs.star, DIM, style.depth)} ${paintAll("Nova", [BOLD], style.depth)}`);
      out.push(renderMarkdown(message.content.trim(), { width: style.width, depth: style.depth }));
    }
  }
  out.push(rule(style, { label: "end of session", tone: "neutral" }));
  return out.join("\n");
}

export type HistoryCommand =
  | { kind: "list" }
  | { kind: "search"; query: string }
  | { kind: "show"; id: string; turns?: number }
  | { kind: "resume"; id?: string }
  | { kind: "invalid"; reason: string };

const SESSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

/** `/history`, `/history search <text>`, `/history <id>`, `/history resume [id]`. */
export function parseHistoryCommand(input: string): HistoryCommand | null {
  const match = /^\/(?:history|sessions)(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim();
  if (rest === "" || rest === "list") return { kind: "list" };

  const [verb, ...others] = rest.split(/\s+/);
  const argument = others.join(" ").trim();
  if (verb === "search" || verb === "find") {
    return argument ? { kind: "search", query: argument } : { kind: "invalid", reason: "/history search needs something to search for." };
  }
  if (verb === "resume" || verb === "open") {
    if (argument === "") return { kind: "resume" };
    return SESSION_ID.test(argument) || argument === "latest"
      ? { kind: "resume", id: argument }
      : { kind: "invalid", reason: `"${argument}" is not a session id. Run /history to see them.` };
  }
  if (SESSION_ID.test(verb)) {
    const turns = /^\d+$/.test(argument) ? Number(argument) : undefined;
    return { kind: "show", id: verb, ...(turns === undefined ? {} : { turns }) };
  }
  return { kind: "invalid", reason: `/history takes a session id, "search <text>", or "resume" — not "${verb}".` };
}
