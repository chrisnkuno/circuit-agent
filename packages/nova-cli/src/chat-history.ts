import type { AgentMessage } from "@circuit-nova/nova-core/agent-runtime";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { BOLD, CYAN, DIM, paint, paintAll } from "./ansi";
import { barChart } from "./charts";
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
  /** Lowercased conversation/tool text used only for local recall, never rendered. */
  searchText?: string;
  /** Native FTS evidence for a search result; absent for the portable JSON fallback. */
  evidence?: { source: "snapshot" | "journal"; snippet: string; why: string[] };
};

export function countTurns(messages: readonly AgentMessage[]): number {
  return messages.filter((message) => message.role === "user" && !message.internal).length;
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
  const searchText = record.messages.flatMap((message): string[] => {
    if (message.role === "system" || message.internal) return [];
    if (message.role === "tool") return [message.name, message.content];
    if (message.role === "assistant" && "toolCalls" in message) {
      return [message.content, ...message.toolCalls.flatMap((call) => [call.name, JSON.stringify(call.arguments ?? {})])];
    }
    return [message.content];
  }).join("\n").toLowerCase();
  return {
    id: record.id,
    title: record.title,
    updatedAt: record.updatedAt,
    turns: countTurns(record.messages),
    messages: record.messages.length,
    searchText,
  };
}

/**
 * Sessions whose actual conversation matches, most recent first.
 *
 * Raw session messages are already local and durable, so searching them needs neither an embedding
 * API nor an LLM summary. Tool names and arguments are included: people often remember the command
 * or file that failed more readily than the words they used to open the session.
 */
export function searchHistory(entries: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const needle = query.trim().toLowerCase();
  const queryTerms = needle.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  const matched = needle === "" ? [...entries] : entries.filter((entry) => {
    const haystack = `${entry.title.toLowerCase()}\n${entry.searchText ?? ""}`;
    // All remembered words may occur across markdown or tool JSON punctuation. Requiring every
    // term preserves phrase-like precision without making `money test` miss `**money** test`.
    return queryTerms.length > 0 && queryTerms.every((term) => haystack.includes(term));
  });
  return matched.sort((left, right) => right.updatedAt - left.updatedAt);
}

/**
 * Turns per day across the recent past — the shape of how this project is actually worked on.
 *
 * `/history` answered "what did I do" and never "when, and how much". A total cannot show that the
 * work is three heavy days and a fortnight of nothing, which is the only reading that tells you
 * whether a session is part of a push or a one-off.
 *
 * Days with no sessions are emitted as empty bars rather than skipped, because a gap *is* the
 * information: a chart that lists only active days draws a flat wall of work and hides every pause.
 */
export function renderHistoryUsage(
  entries: readonly HistoryEntry[],
  style: SectionStyle,
  options: { now?: number; days?: number } = {},
): string {
  if (entries.length === 0) return "";
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const days = Math.max(2, options.days ?? 14);
  const now = options.now ?? Date.now();
  const DAY = 86_400_000;
  // Bucketed by local calendar day, not by 24-hour blocks counted back from now: "Tuesday" is what
  // a person remembers, and an offset window would split one evening's work across two bars.
  const startOfDay = (at: number) => { const date = new Date(at); date.setHours(0, 0, 0, 0); return date.getTime(); };
  const today = startOfDay(now);
  const buckets = new Map<number, number>();
  for (let index = days - 1; index >= 0; index -= 1) buckets.set(today - index * DAY, 0);
  for (const entry of entries) {
    const day = startOfDay(entry.updatedAt);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + entry.turns);
  }
  if ([...buckets.values()].every((value) => value === 0)) return "";

  const rows = barChart(
    [...buckets].map(([day, turns]) => ({
      label: new Date(day).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      value: turns,
    })),
    { width: Math.max(24, Math.min(64, style.width - GUTTER.length)), depth: style.depth, glyphs, format: (value) => `${Math.round(value)}` },
  );
  return [heading(`turns per day ${glyphs.middot} last ${days} days`, 2, style), ...rows.map((row) => `${GUTTER}${row}`)].join("\n");
}

/** The list view: recency, size, and the id `/history <id>` takes. */
export function renderHistoryList(entries: readonly HistoryEntry[], style: SectionStyle, options: { now?: number; current?: string } = {}): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  if (entries.length === 0) return `${GUTTER}${paint("no past sessions in this project yet", DIM, style.depth)}`;
  const now = options.now ?? Date.now();
  const width = Math.max(0, ...entries.map((entry) => entry.title.length));
  const titleWidth = Math.min(width, Math.max(16, style.width - 34));

  const lines = entries.flatMap((entry) => {
    const active = entry.id === options.current;
    const mark = active ? paint(glyphs.circleFull, CYAN, style.depth) : " ";
    const title = clip(entry.title || "untitled", titleWidth, glyphs).padEnd(titleWidth);
    const meta = `${relativeTime(entry.updatedAt, now)} ${glyphs.middot} ${entry.turns} turn${entry.turns === 1 ? "" : "s"}`;
    const row = `${GUTTER}${mark} ${active ? paintAll(title, [BOLD], style.depth) : title}  ${paint(meta, DIM, style.depth)}`;
    const rendered = [clip(row, style.width, glyphs)];
    if (entry.evidence) {
      const snippet = entry.evidence.snippet.replace(/\s+/g, " ").trim();
      if (snippet) rendered.push(clip(`${GUTTER}  ${glyphs.boxVertical} ${snippet}`, style.width, glyphs));
      const reason = entry.evidence.why.find((item) => !item.startsWith("evidence source:"));
      rendered.push(clip(`${GUTTER}  ${glyphs.boxVertical} ${entry.evidence.source} evidence${reason ? ` ${glyphs.middot} ${reason}` : ""}`, style.width, glyphs));
    }
    return rendered;
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
  const boundaries = record.messages.flatMap((message, index) => (message.role === "user" && !message.internal ? [index] : []));
  const from = options.turns !== undefined && boundaries.length > options.turns
    ? boundaries[boundaries.length - options.turns]
    : 0;
  if (from > 0) out.push(`${GUTTER}${paint(`${glyphs.middot.repeat(3)} earlier turns omitted`, DIM, style.depth)}`);

  let turn = 0;
  for (const message of record.messages.slice(from)) {
    if (message.role === "system" || message.internal) continue;
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
  | { kind: "status" }
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
  if (rest === "status" || rest === "doctor") return { kind: "status" };

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
  return { kind: "invalid", reason: `/history takes a session id, "search <text>", "status", or "resume" — not "${verb}".` };
}
