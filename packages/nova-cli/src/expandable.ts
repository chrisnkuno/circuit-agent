import { DIM, paint } from "./ansi";
import type { ColorDepth } from "./banner";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

/**
 * Folded blocks, and the handle that unfolds them.
 *
 * The transcript has one screen and a turn can produce a thousand lines. The usual answers are both
 * bad: print everything and the answer scrolls away above the reader, or truncate and the detail is
 * gone for good. So long output is folded to a readable height and *kept*, tagged with a number
 * the reader can ask for — `[3] +140 lines · /expand 3`.
 *
 * A full-screen pager was the other option and is the wrong one here. Nova's transcript is an
 * append-only scroll precisely so it stays copy-pasteable and scrollable with the terminal's own
 * scrollback; a pager takes the keyboard, hides the session behind it, and gives back a view you
 * cannot quote. Expansion prints *into the transcript* instead, so the expanded copy scrolls and
 * copies exactly like everything around it.
 *
 * Entries live for the session and are capped, because this is a convenience over output the model
 * already consumed — not a second store of record.
 */

const MAX_ENTRIES = 64;

export type Expandable = {
  id: number;
  /** What the reader is asking to see: "src/app.ts", "npm test output". */
  label: string;
  /** The whole thing, already rendered for the terminal. */
  full: string;
  /** How many lines were withheld — the number that makes the offer worth making. */
  hidden: number;
};

export class ExpandableStore {
  private entries: Expandable[] = [];
  private nextId = 1;

  /** Files a folded block and returns its id; ids never repeat within a session. */
  add(label: string, full: string, hidden: number): number {
    const id = this.nextId;
    this.nextId += 1;
    this.entries.push({ id, label, full, hidden });
    // Oldest first: the block a reader asks to expand is nearly always one they can still see.
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES);
    return id;
  }

  get(id: number): Expandable | undefined {
    return this.entries.find((entry) => entry.id === id);
  }

  get last(): Expandable | undefined {
    return this.entries.at(-1);
  }

  get all(): readonly Expandable[] {
    return this.entries;
  }

  get size(): number {
    return this.entries.length;
  }

  /** A new thread has nothing to do with the last one's output. */
  clear(): void {
    this.entries = [];
  }
}

export type ExpandCommand =
  | { kind: "list" }
  | { kind: "last" }
  | { kind: "all" }
  | { kind: "one"; id: number }
  | { kind: "invalid"; reason: string };

/**
 * `/expand`, `/expand 3`, `/expand last`, `/expand all`, `/expand list`.
 *
 * Bare `/expand` means the most recent fold, because that is what the word means when someone says
 * it out loud while looking at a screen — the alternative, making them read a number off the line
 * above, is a lookup step for the overwhelmingly common case.
 */
export function parseExpandCommand(input: string): ExpandCommand | null {
  const match = /^\/expand(?:\s+(.*))?$/.exec(input.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim().toLowerCase();
  if (argument === "" || argument === "last") return { kind: "last" };
  if (argument === "all") return { kind: "all" };
  if (argument === "list" || argument === "ls") return { kind: "list" };
  if (/^\d+$/.test(argument)) return { kind: "one", id: Number(argument) };
  return { kind: "invalid", reason: `/expand takes a number, "last", "all", or "list" — not "${argument}".` };
}

/** The one-line offer printed under a folded block. */
export function expandHint(id: number, hidden: number, depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  return paint(`${glyphs.collapsed} ${hidden} more line${hidden === 1 ? "" : "s"} hidden ${glyphs.middot} /expand ${id}`, DIM, depth);
}

/** The index `/expand list` prints: what is foldable right now, and how much each is hiding. */
export function renderExpandableList(entries: readonly Expandable[], depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (entries.length === 0) return paint("  nothing folded in this session yet", DIM, depth);
  return entries
    .map((entry) => `  ${paint(`[${entry.id}]`, DIM, depth)} ${entry.label} ${paint(`${glyphs.middot} ${entry.hidden} hidden line${entry.hidden === 1 ? "" : "s"}`, DIM, depth)}`)
    .join("\n");
}
