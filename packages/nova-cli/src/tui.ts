import { STAR_GLYPHS, type ColorDepth } from "./banner";
import { newMarkdownState, renderMarkdownLine, visibleWidth, type MarkdownState } from "./markdown";

/**
 * The pinned status region beneath the scrolling transcript, and the pieces it is built from.
 *
 * Nova stays a scrolling-transcript CLI — an append-only log is what makes a session reviewable
 * and copy-pasteable afterward — so nothing here uses the alt-screen buffer. The status bar is
 * just the last thing on screen, redrawn in place: clear the lines it occupies, write new ones.
 * Every other writer (a tool line, an approval prompt, the next turn) has to close it first, the
 * same way `nova.ts` already makes every writer call `endStreamedLine()` before printing.
 */

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" ? text : `${code}${text}${RESET}`;
}

/** Braille-free, theme-matched: the same star glyphs the banner lights up, cycling in place. */
const SPINNER_FRAMES = [STAR_GLYPHS[2], STAR_GLYPHS[3], STAR_GLYPHS[4], STAR_GLYPHS[3]];

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly onTick: () => void, private readonly intervalMs = 120) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % SPINNER_FRAMES.length;
      this.onTick();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get glyph(): string {
    return SPINNER_FRAMES[this.frame];
  }
}

export type StatusFields = {
  mode: string;
  spinnerGlyph: string;
  elapsedMs: number;
  toolCalls: number;
  /** Tokens spent so far this turn, summed across the model's iterations. */
  tokens: number;
  cost: string;
};

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

export function formatTokens(tokens: number): string {
  if (tokens < 1_000) return `${tokens} tokens`;
  return `${(tokens / 1_000).toFixed(1)}k tokens`;
}

/**
 * What the spinner claims to be doing, rotating slowly.
 *
 * A word that never changes reads as a frozen program; one that changes every frame reads as
 * noise. Every few seconds is the rate at which it registers as alive without demanding attention.
 */
const VERBS = ["Thinking", "Working", "Reasoning", "Digging", "Tracing", "Composing", "Considering", "Checking"];

export function thinkingVerb(elapsedMs: number): string {
  return VERBS[Math.floor(Math.max(0, elapsedMs) / 4_000) % VERBS.length];
}

/**
 * Composes the status line for a given width, dropping detail in priority order before it breaks.
 *
 * The elapsed time is the one field that survives every narrowing: it is the only one that answers
 * "is this still going", which is the question a status line exists for.
 */
export function formatStatusLine(fields: StatusFields, width: number, depth: ColorDepth): string {
  const verb = thinkingVerb(fields.elapsedMs);
  const left = `${fields.spinnerGlyph} ${verb}…`;
  const paintedLeft = `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint(`${verb}…`, DIM, depth)}`;

  // Ordered least to most important; the front of the list is given up first.
  const optional = [
    fields.cost,
    fields.tokens > 0 ? formatTokens(fields.tokens) : "",
    fields.toolCalls > 0 ? `${fields.toolCalls} tool${fields.toolCalls === 1 ? "" : "s"}` : "",
    fields.mode,
  ].filter((segment) => segment !== "");

  let kept = [...optional].reverse(); // most important first, as they read left to right
  for (;;) {
    const right = [...kept, formatElapsed(fields.elapsedMs)].join(" · ");
    const total = visibleWidth(left) + 1 + right.length;
    if (total <= width || kept.length === 0) {
      if (total > width) return visibleWidth(left) <= width ? paintedLeft : "";
      const gap = Math.max(1, width - visibleWidth(left) - right.length);
      return `${paintedLeft}${" ".repeat(gap)}${paint(right, DIM, depth)}`;
    }
    kept = kept.slice(0, -1); // drop the least important segment still present
  }
}

export class StatusBar {
  private linesDrawn = 0;

  constructor(private readonly stream: NodeJS.WriteStream = process.stdout) {}

  /** Redraws the bar in place: erase what was there, write the new line. */
  render(fields: StatusFields, depth: ColorDepth): void {
    this.clear();
    const width = this.stream.columns ?? 80;
    const line = formatStatusLine(fields, width, depth);
    this.stream.write(`${line}\n`);
    this.linesDrawn = 1;
  }

  /** Removes the bar from the screen. Every other writer must call this before printing. */
  clear(): void {
    if (this.linesDrawn === 0) return;
    for (let index = 0; index < this.linesDrawn; index += 1) {
      this.stream.write("\x1b[1A\x1b[2K"); // cursor up one line, erase it
    }
    this.linesDrawn = 0;
  }
}

/** How many terminal rows a printed string occupies at a given width. */
export function rowsOccupied(text: string, columns: number): number {
  const width = visibleWidth(text);
  if (width === 0) return 1; // an empty line still consumes a row
  return Math.ceil(width / Math.max(1, columns));
}

/**
 * A run of lines at the bottom of the screen, any of which can be rewritten later.
 *
 * A tool call is worth announcing before it runs and summarising after, and those are the same
 * line: `⋯ run_command  npm test` becomes `✓ run_command  npm test · exit 0`. A block rather than
 * a single line because the runtime issues read-only calls in parallel — several announcements go
 * out before the first result returns, so the line to rewrite is usually not the last one.
 *
 * `forget()` is how a caller says the block is no longer the bottom of the screen, after which
 * nothing above may be touched: rewriting then would erase whatever printed in between.
 */
export class ReplaceableBlock {
  private entries: string[] = [];
  private rows = 0;

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stdout,
    private readonly columns: () => number = () => process.stdout.columns ?? 80,
  ) {}

  /** Adds a line at the bottom and returns the handle needed to rewrite it. */
  append(text: string): number {
    this.entries.push(text);
    this.stream.write(`${text}\n`);
    this.rows += rowsOccupied(text, this.columns());
    return this.entries.length - 1;
  }

  /** Rewrites one line. False when the block has been forgotten, or the handle is unknown. */
  update(index: number, text: string): boolean {
    if (index < 0 || index >= this.entries.length) return false;
    this.entries[index] = text;
    for (let row = 0; row < this.rows; row += 1) this.stream.write("\x1b[1A\x1b[2K");
    this.stream.write("\r");
    this.rows = 0;
    for (const entry of this.entries) {
      this.stream.write(`${entry}\n`);
      this.rows += rowsOccupied(entry, this.columns());
    }
    return true;
  }

  /** Something else has printed; the block is no longer the bottom of the screen. */
  forget(): void {
    this.entries = [];
    this.rows = 0;
  }

  get active(): boolean {
    return this.entries.length > 0;
  }
}

/**
 * Assistant text, streamed live and rendered as markdown once each line is whole.
 *
 * These two goals fight: markdown cannot be styled until a line is complete (a `**` may be half
 * arrived), but waiting for the newline would freeze the screen for the length of a paragraph,
 * since models emit a paragraph as one line. So the raw text is written as it arrives — the
 * session reads as live — and the moment the line closes it is erased and reprinted properly
 * styled and wrapped. The rewrite is one line deep and instant, so what a person sees is text
 * appearing normally that happens to end up formatted.
 */
export class MarkdownStream {
  private pending = "";
  private atLineStart = true;
  private state: MarkdownState = newMarkdownState();

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stdout,
    private readonly depth: ColorDepth = "none",
    private readonly columns: () => number = () => process.stdout.columns ?? 80,
    /**
     * Whether the destination is a terminal that can be drawn on.
     *
     * Redrawing a line requires a cursor, and a pipe has none — the escape codes would simply land
     * in whatever file or program is reading. So `nova "..." > notes.md` gets the model's own text
     * through unaltered, which is also the more useful thing to receive.
     */
    private readonly live = true,
  ) {}

  /** True while a partial line is on screen that nothing else may print over. */
  get active(): boolean {
    return this.live ? this.pending !== "" : !this.atLineStart;
  }

  push(text: string): void {
    if (!this.live) {
      if (text === "") return;
      this.stream.write(text);
      this.atLineStart = text.endsWith("\n");
      return;
    }
    const parts = text.split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) this.finalizeLine();
      if (parts[index] !== "") {
        this.pending += parts[index];
        this.stream.write(parts[index]);
      }
    }
  }

  /** Finishes a trailing partial line, so the next writer starts on a clean row. */
  end(): void {
    if (!this.live) {
      if (!this.atLineStart) {
        this.stream.write("\n");
        this.atLineStart = true;
      }
      return;
    }
    if (this.pending !== "") this.finalizeLine();
  }

  /** Forgets fence state between turns, so an unclosed block cannot colour the next answer. */
  reset(): void {
    this.pending = "";
    this.atLineStart = true;
    this.state = newMarkdownState();
  }

  private finalizeLine(): void {
    this.erasePending();
    const rendered = renderMarkdownLine(this.pending, this.state, { width: this.columns(), depth: this.depth });
    this.stream.write(`${rendered.join("\n")}\n`);
    this.pending = "";
  }

  private erasePending(): void {
    if (this.pending === "") return;
    // The cursor sits at the end of the raw text, with no newline written after it: clear the row
    // it is on, then walk up through any rows the text wrapped onto.
    const rows = rowsOccupied(this.pending, this.columns());
    this.stream.write("\r\x1b[2K");
    for (let index = 1; index < rows; index += 1) this.stream.write("\x1b[1A\x1b[2K");
  }
}

/**
 * A unicode-box-drawn card, sized to its content — the same "compute a width, then center or pad
 * within it" math `banner.ts` uses for the wordmark, applied to arbitrary line-based content.
 */
export function box(
  lines: readonly string[],
  options: { width?: number; depth: ColorDepth; title?: string; titleColor?: "cyan" | "green" | "yellow" },
): string {
  const terminalWidth = options.width ?? process.stdout.columns ?? 80;
  const titleWidth = options.title ? visibleWidth(options.title) : 0;
  const titlePaint = options.titleColor === "green" ? GREEN : options.titleColor === "yellow" ? YELLOW : CYAN;
  // Measured in columns, not characters: a todo containing an emoji is two columns wide there and
  // one character long, and padding by the latter is what leaves a border short of its own corner.
  const contentWidth = Math.min(
    Math.max(titleWidth, ...lines.map((line) => visibleWidth(line)), 1),
    Math.max(1, terminalWidth - 4),
  );
  const horizontal = "─".repeat(contentWidth + 2);
  const top = options.title
    ? `╭─ ${paint(options.title, titlePaint, options.depth)} ${
        "─".repeat(Math.max(0, contentWidth - titleWidth - 1))
      }╮`
    : `╭${horizontal}╮`;
  const bottom = `╰${horizontal}╯`;
  const body = lines.map((line) => {
    const clipped = visibleWidth(line) > contentWidth ? `${sliceToWidth(line, contentWidth - 1)}…` : line;
    return `│ ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} │`;
  });
  return [top, ...body, bottom].join("\n");
}

/** Takes as many characters as fit in a column budget, counting wide characters as two. */
function sliceToWidth(text: string, width: number): string {
  let taken = "";
  let used = 0;
  for (const character of text) {
    const next = visibleWidth(character);
    if (used + next > width) break;
    taken += character;
    used += next;
  }
  return taken;
}

/**
 * The one-line header that opens an agent's response, so a scrolling transcript reads as a
 * conversation between two clearly marked speakers rather than an unbroken wall of text.
 *
 * The user's side already gets a boxed "you" bubble (`renderUserMessage` in nova.ts); the agent's
 * side cannot be boxed the same way because its text is streamed and the box would have to be
 * closed before the final width is known. A label printed once, right before the first token of
 * the turn, gets the same "who is speaking" legibility without needing to buffer the answer.
 */
export function renderAgentLabel(depth: ColorDepth): string {
  return `${paint("✦", CYAN, depth)} ${paint("nova", CYAN, depth)}`;
}

/**
 * The "files modified" footer printed after a turn that actually edited the workspace.
 *
 * A person skimming the transcript for "what did it touch" should not have to reconstruct that
 * from a scroll of individual `write_file` / `edit_file` tool lines further up — this is that
 * answer, deduplicated and sorted, in the same boxed-section language as `/diff` and `/todos`.
 */
export function renderFilesTouched(paths: readonly string[], depth: ColorDepth, width?: number): string {
  const unique = [...new Set(paths)].sort();
  return box(unique, { depth, width, title: "files modified", titleColor: "green" });
}

/** The mode's accent colour in the input bar, so the permission posture is legible at a glance. */
const MODE_COLORS: Record<string, string> = { plan: YELLOW, auto: GREEN, build: CYAN };

/** Visible columns the `│ › ` prefix of the prompt box occupies. */
export const PROMPT_PREFIX_COLUMNS = 4;

/**
 * The input bar that makes the REPL read like a chat app: a titled box parked at the bottom of
 * the screen, with the cursor on its input row.
 *
 * `draw` renders three rows — a border with a live header (mode, workspace), the input row, and
 * a closing border — and returns the prefix that the caller passes to readline's `question()`,
 * which is what keeps the left border on screen through readline's own editing redraws. The
 * closing border is only guaranteed while the line is being typed forward; any full redraw
 * readline performs (an arrow-key edit, a completion, submit) clears the row below the input, so
 * the box gracefully opens rather than corrupting.
 */
export function renderPromptBox(options: {
  mode: string;
  workspace: string;
  depth: ColorDepth;
  width: number;
}): { top: string; prefix: string; bottom: string } {
  const { mode, workspace, depth } = options;
  const width = Math.max(12, options.width);
  const modeColor = MODE_COLORS[mode] ?? CYAN;
  const head = `${paint("✦", CYAN, depth)} ${paint("nova", CYAN, depth)} · ${paint(mode, modeColor, depth)} · `;
  // The workspace is the part most likely to overrun a narrow window; give it its own budget
  // and clip it rather than let it push the right-hand corner off screen. The extra column
  // keeps the header (plus its ellipsis) within width - 6 so the closing corner always fits.
  const budget = Math.max(4, width - visibleWidth(head) - 7);
  const clipped = sliceToWidth(workspace, budget);
  const shown = visibleWidth(clipped) < visibleWidth(workspace) ? `${clipped}…` : workspace;
  const title = `${head}${paint(shown, DIM, depth)}`;
  const filler = Math.max(1, width - visibleWidth(title) - 5);
  const top = `${paint("╭─", CYAN, depth)} ${title} ${paint("─".repeat(filler), CYAN, depth)}${paint("╮", CYAN, depth)}`;
  const prefix = `${paint("│", CYAN, depth)} ${paint("›", modeColor, depth)} `;
  const bottom = `${paint("╰", CYAN, depth)}${paint("─".repeat(width - 2), CYAN, depth)}${paint("╯", CYAN, depth)}`;
  return { top, prefix, bottom };
}

/** The part of a line that has wrapped past the first row, given the cursor's start column. */
export function wrappedRemainder(line: string, startColumns: number, width: number): string {
  let used = startColumns;
  for (let index = 0; index < line.length; index += 1) {
    const next = visibleWidth(line[index]);
    if (used + next > width) return line.slice(index);
    used += next;
  }
  return "";
}

/**
 * Draws and erases the chat-style input bar, tracking only what it printed so anything below
 * (the turn summary, the banner) is never touched.
 */
export class PromptBox {
  private drawn = false;
  private borderCleared = false;

  constructor(
    private readonly stream: NodeJS.WriteStream = process.stdout,
    private readonly depth: ColorDepth = "none",
  ) {}

  get isDrawn(): boolean {
    return this.drawn;
  }

  /**
   * Renders the box and parks the cursor at the start of its input row. Returns the prompt
   * string to hand to readline's `question()`.
   */
  draw(mode: string, workspace: string): string {
    const width = this.stream.columns ?? 80;
    const { top, prefix, bottom } = renderPromptBox({ mode, workspace, depth: this.depth, width });
    this.stream.write(`${top}\n`);
    this.stream.write(`\n${bottom}`);
    // Back to the input row, column one — question() writes the prefix from there.
    this.stream.write("\x1b[1A\r");
    this.drawn = true;
    this.borderCleared = false;
    return prefix;
  }

  /**
   * Removes the box after a line resolves, leaving the cursor on the row its top border
   * occupied so the caller can print the next transcript line exactly there.
   *
   * The count follows the geometry readline leaves behind at submit: it redraws
   * `prefix + line` from column one (the prefix survives because `question(prefix)` keeps it as
   * its prompt), clears everything below the input row, and finishes with a newline. `prefix` is
   * four columns, so a line of width `W` occupies `floor((4 + W - 1) / width)` rows below the
   * border — one for the input row, one more for the newline, and one for the border itself.
   */
  erase(submitted: string): void {
    if (!this.drawn) return;
    // A degenerate stream can report zero columns (a 0x0 pty); without the floor, dividing by
    // it would spin forever. A real terminal always has a sane width, but one guard keeps the
    // erase bounded everywhere.
    const width = Math.max(1, this.stream.columns ?? 80);
    const rows = Math.floor((PROMPT_PREFIX_COLUMNS + visibleWidth(submitted) - 1) / width) + 3;
    for (let index = 0; index < rows; index += 1) this.stream.write("\x1b[1A\x1b[2K");
    this.drawn = false;
  }

  /**
   * When the typed line has wrapped past the input row, opens the box by dropping the closing
   * border and re-showing the wrapped remainder, so the border cannot sit under a line of text.
   */
  dropBorder(remainder: string): void {
    if (!this.drawn || this.borderCleared || remainder === "") return;
    // The cursor is on the border row the moment wrapping starts; clear it and rewrite the
    // remainder so the text that already wrapped is not lost.
    this.stream.write("\r\x1b[2K");
    this.stream.write(remainder);
    this.borderCleared = true;
  }
}

/**
 * Wraps plain text at a column budget, breaking at word boundaries and hard-slicing only a word
 * longer than the whole budget.
 */
export function wrapPlain(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (word === "") continue;
    const candidate = current === "" ? word : `${current} ${word}`;
    if (visibleWidth(candidate) <= width) {
      current = candidate;
      continue;
    }
    if (current !== "") lines.push(current);
    if (visibleWidth(word) > width) {
      let rest = word;
      while (visibleWidth(rest) > width) {
        const chunk = sliceToWidth(rest, width);
        lines.push(chunk);
        rest = rest.slice(chunk.length);
      }
      current = rest;
    } else {
      current = word;
    }
  }
  if (current !== "") lines.push(current);
  return lines.length === 0 ? [""] : lines;
}
