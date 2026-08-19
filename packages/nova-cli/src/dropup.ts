import { clipTo, windowStart } from "./chooser";
import { visibleWidth } from "./markdown";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

/**
 * The suggestion list that opens *upward* from the inline input bar.
 *
 * Why upward, and why it belongs to the prompt box rather than to `PinnedScreen`:
 *
 * `PinnedScreen.renderSuggestions` already draws a list, and it works — but only under `--pin`,
 * because it addresses rows by absolute screen coordinates taken from the layout, and those
 * coordinates are only where the input bar actually is when a held region has pinned it there. In
 * the default session the bar is *printed inline*, so it sits wherever the transcript happens to
 * have reached: on a fresh session that is row 8 of a 40-row terminal, and the absolute-addressed
 * list would paint at rows 35-37, thirty rows below the prompt it belongs to. That is the bug this
 * module exists to fix, and it is why every escape sequence here is a *relative* move from the
 * cursor — the cursor is on the input row by construction, so relative motion finds the bar without
 * needing to know what row it is on.
 *
 * Upward is also the only safe direction, which is a happy accident worth writing down. Readline
 * redraws its line by moving to the line's start and issuing `ED 0` (erase to end of display), so
 * *everything below the input row is periodically destroyed by readline* — that is why the box's
 * closing border has always needed re-drawing and why `dropBorder` exists. Rows above the top
 * border are the one region readline never touches. A list drawn there survives every keystroke,
 * every history recall and every completion redraw without coordination.
 */

export type DropupEntry = {
  command: string;
  args?: string;
  description: string;
  /** Rendered right-aligned in the tail, so the list teaches the shortcut alongside the name. */
  chord?: string;
};

export type DropupPaint = {
  dim: (text: string) => string;
  cyan: (text: string) => string;
  green: (text: string) => string;
};

const PLAIN: DropupPaint = { dim: (text) => text, cyan: (text) => text, green: (text) => text };

export type DropupOptions = {
  width: number;
  /** Hard ceiling on rows. The caller derives it from the terminal height; see `dropupRowBudget`. */
  maxRows?: number;
  /** Highlighted row, as an index into `entries`. Absent when the list is being read, not browsed. */
  selected?: number;
  glyphs?: GlyphSet;
  paint?: DropupPaint;
};

/**
 * How many rows the list may take.
 *
 * Bounded by the terminal, not by taste: the block below it (top border, input row, closing border)
 * is three rows, and a transcript that has been squeezed to nothing is not a transcript. Leaving
 * `MIN_VISIBLE_TRANSCRIPT` rows is what keeps the thing you are typing *about* on screen while you
 * type — a list that covers the error message you are responding to has optimised the wrong thing.
 */
const MIN_VISIBLE_TRANSCRIPT = 3;
const BAR_ROWS = 3;

export function dropupRowBudget(terminalRows: number, wanted: number, ceiling = 8): number {
  const room = terminalRows - BAR_ROWS - MIN_VISIBLE_TRANSCRIPT;
  return Math.max(0, Math.min(wanted, ceiling, room));
}

/**
 * The window of entries to show, scrolled to keep `selected` inside it.
 *
 * Defers to `windowStart` rather than deriving a second scroll rule: the chooser, the palette and
 * this list all scroll a selection through a fixed-height window, and three implementations of that
 * is three places for the same off-by-one. An unbrowsed list has no selection to follow and simply
 * shows its first `rows` entries.
 */
export function dropupWindow(count: number, rows: number, selected?: number): { start: number; length: number } {
  const length = Math.max(0, Math.min(count, Math.max(0, Math.floor(rows))));
  if (selected === undefined || length === 0) return { start: 0, length };
  return { start: windowStart(selected, count, length), length };
}

/**
 * The list's rows, ordered top-to-bottom as they will appear on screen.
 *
 * Rank order is *reversed* here, so the best match ends up on the bottom row — the one directly
 * above the input line. In an upward list the row nearest the cursor is the one the eye lands on and
 * the one the thumb expects Return to take, and putting the best match furthest from the prompt
 * would mean the list's answer and the list's focus are at opposite ends of it. This is the same
 * rule `renderPalette` follows for `direction: "up"`.
 */
export function renderDropup(entries: readonly DropupEntry[], options: DropupOptions): string[] {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const clip = (text: string, width: number) => clipTo(text, width, glyphs);
  const paint = options.paint ?? PLAIN;
  const columns = Math.max(1, options.width);
  const rows = options.maxRows ?? entries.length;
  const { start, length } = dropupWindow(entries.length, rows, options.selected);
  const visible = entries.slice(start, start + length);
  if (visible.length === 0) return [];

  const heads = visible.map((entry) => (entry.args ? `${entry.command} ${entry.args}` : entry.command));
  // Measured in cells rather than characters: a `.length`-based pad silently misaligns every row
  // below the first wide glyph, and command arguments are the place non-ASCII will arrive first.
  const natural = Math.max(0, ...heads.map(visibleWidth));
  const headBudget = Math.max(0, Math.min(natural, Math.floor(Math.max(0, columns - 6) * 0.55)));

  const lines = visible.map((entry, offset) => {
    const active = options.selected !== undefined && start + offset === options.selected;
    const marker = active ? paint.cyan(glyphs.prompt) : " ";
    if (columns < 8) return clip(`${active ? glyphs.prompt : " "}${heads[offset]}`, columns);
    const head = clip(heads[offset], headBudget);
    const padded = head + " ".repeat(Math.max(0, headBudget - visibleWidth(head)));
    const used = visibleWidth(`  ${marker === " " ? " " : glyphs.prompt} ${padded}  `);
    const room = Math.max(0, columns - used);
    // The chord is charged for *before* the description, not appended after it. Appending is the
    // obvious way and it is wrong: the description is long and variable, the chord is short and
    // fixed, so a naive clip eats the chord first and every row ends "…[Ctrl+…" — the row loses
    // precisely the thing that would have stopped the user needing the list next time. Reserving it
    // means a squeezed row drops description text, which is the part they can already infer.
    const chord = entry.chord ? `  [${entry.chord}]` : "";
    const chordWidth = visibleWidth(chord);
    // Unless there is not room for both: a chord alone, with no hint of what the command does, is a
    // worse row than a description alone, so the description keeps a floor before the chord is cut.
    const keepChord = chord !== "" && room - chordWidth >= 12;
    const descriptionRoom = Math.max(0, keepChord ? room - chordWidth : room);
    const tail = `${clip(entry.description, descriptionRoom)}${keepChord ? chord : ""}`;
    // Clipped, never wrapped. A wrapped row occupies two screen rows while the paint arithmetic
    // believes it occupies one, and every row above it is then written to the wrong place.
    return `  ${marker} ${active ? paint.cyan(padded) : padded}  ${paint.dim(clip(tail, room))}`;
  });

  // Best match nearest the prompt.
  return lines.reverse();
}

