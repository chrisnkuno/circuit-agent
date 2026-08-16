import type { ColorDepth } from "./banner";
import { terminalStream, type OutputStream } from "./output";
import { borderGlyphsFor, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
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
const RED = "\x1b[31m";

function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" ? text : `${code}${text}${RESET}`;
}

/**
 * A tiny supernova rather than a generic wheel.
 *
 * Every frame is five columns wide, so the activity text never jitters left and right while the
 * core brightens and the two outer sparks collapse back in. The glyphs come from the opening
 * starfield, making this feel like a living piece of Nova instead of a borrowed loader — and from
 * the *terminal's* starfield: a console that cannot draw `✦` gets the four-frame ASCII wheel from
 * `ASCII_GLYPHS` rather than five columns of question marks rotating in place.
 */
export function novaSpinnerFrame(index: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const frames = glyphs.spinnerFrames;
  const normalized = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return frames[normalized % frames.length];
}

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly onTick: () => void,
    private readonly intervalMs = 120,
    private readonly glyphs: GlyphSet = UNICODE_GLYPHS,
  ) {}

  start(): void {
    if (this.timer) return;
    // Render immediately. Waiting one interval makes short operations look as though the CLI
    // froze and then recovered, which is precisely the uncertainty a spinner is meant to remove.
    this.onTick();
    this.timer = setInterval(() => {
      this.frame = (this.frame + 1) % this.glyphs.spinnerFrames.length;
      this.onTick();
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  get glyph(): string {
    return novaSpinnerFrame(this.frame, this.glyphs);
  }
}

export type ActivityPhase = "thinking" | "operation";

export type StatusFields = {
  mode: string;
  spinnerGlyph: string;
  elapsedMs: number;
  toolCalls: number;
  /** Tokens spent so far this turn, summed across the model's iterations. */
  tokens: number;
  cost: string;
  phase?: ActivityPhase;
  /** Exact tool name while an operation is active; omitted during model reasoning. */
  operation?: string;
  /**
   * A standing mode marker — currently the spending pace.
   *
   * Ranked just under the mode when the line has to narrow: a pace the user set and then forgot is
   * the field most likely to explain why the agent is behaving the way it is, so it survives longer
   * than the counts and the cost that merely report progress.
   */
  badge?: string;
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
 * A one-line shape for a series of numbers — session cost or tokens per turn — so the trend reads
 * without a chart. Values are relative to the series' own max, not to any absolute scale: this
 * answers "is it climbing" at a glance, which is the only question a status line has room for.
 */
export function sparkline(values: readonly number[], glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const levels = glyphs.sparkLevels;
  if (values.length === 0) return "";
  const max = Math.max(...values);
  if (max <= 0) return levels[0].repeat(values.length);
  return values.map((value) => levels[Math.min(levels.length - 1, Math.floor((Math.max(0, value) / max) * (levels.length - 1)))]).join("");
}

/**
 * What the spinner claims to be doing, rotating slowly.
 *
 * A word that never changes reads as a frozen program; one that changes every frame reads as
 * noise. Every few seconds is the rate at which it registers as alive without demanding attention.
 */
const VERBS = ["Thinking", "Reasoning", "Tracing", "Considering"];

export function thinkingVerb(elapsedMs: number): string {
  return VERBS[Math.floor(Math.max(0, elapsedMs) / 6_000) % VERBS.length];
}

/** Concise, human operation names for the animated status line. */
export function activityLabel(phase: ActivityPhase, operation: string | undefined, elapsedMs: number): string {
  if (phase === "thinking") return thinkingVerb(elapsedMs);
  switch (operation) {
    case "read_file": return "Reading file";
    case "list_files":
    case "glob_files":
    case "grep_files": return "Searching workspace";
    case "write_file":
    case "edit_file": return "Editing workspace";
    case "run_command": return "Running command";
    case "web_search": return "Searching the web";
    case "todo_write": return "Updating plan";
    default: return "Running operation";
  }
}

/**
 * Composes the status line for a given width, dropping detail in priority order before it breaks.
 *
 * The elapsed time is the one field that survives every narrowing: it is the only one that answers
 * "is this still going", which is the question a status line exists for.
 */
export function formatStatusLine(fields: StatusFields, width: number, depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const label = activityLabel(fields.phase ?? "thinking", fields.operation, fields.elapsedMs);
  const ellipsis = glyphs.ellipsis;
  const left = `${fields.spinnerGlyph} ${label}${ellipsis}`;
  const paintedLeft = `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint(`${label}${ellipsis}`, DIM, depth)}`;

  // Ordered least to most important; the front of the list is given up first.
  const optional = [
    fields.cost,
    fields.tokens > 0 ? formatTokens(fields.tokens) : "",
    fields.toolCalls > 0 ? `${fields.toolCalls} tool${fields.toolCalls === 1 ? "" : "s"}` : "",
    fields.badge ?? "",
    fields.mode,
  ].filter((segment) => segment !== "");

  let kept = [...optional].reverse(); // most important first, as they read left to right
  for (;;) {
    const right = [...kept, formatElapsed(fields.elapsedMs)].join(" · ");
    const total = visibleWidth(left) + 1 + right.length;
    if (total <= width || kept.length === 0) {
      if (total > width) {
        if (visibleWidth(left) <= width) return paintedLeft;
        const compact = `${fields.spinnerGlyph} ${ellipsis}`;
        if (visibleWidth(compact) <= width) return `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint(ellipsis, DIM, depth)}`;
        return width > 0 ? paint(glyphs.star, CYAN, depth) : "";
      }
      const gap = Math.max(1, width - visibleWidth(left) - right.length);
      return `${paintedLeft}${" ".repeat(gap)}${paint(right, DIM, depth)}`;
    }
    kept = kept.slice(0, -1); // drop the least important segment still present
  }
}

export class StatusBar {
  private linesDrawn = 0;

  constructor(private readonly stream: OutputStream = terminalStream) {}

  /** Redraws the bar in place: erase what was there, write the new line. */
  render(fields: StatusFields, depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): void {
    this.clear();
    const width = this.stream.columns ?? 80;
    const line = formatStatusLine(fields, width, depth, glyphs);
    this.stream.write(`${line}\n`);
    this.linesDrawn = 1;
  }

  /**
   * Draws an already-composed line, with the same erase-then-write discipline.
   *
   * For the idle footer, whose text is assembled by the session (mode, tabs, cost) rather than from
   * `StatusFields`. Without a pinned row to put it on, this is where that line lives — and unlike a
   * `DECSTBM` region, a bar that erases and redraws itself leaves the terminal's scrollback alone.
   */
  renderLine(text: string): void {
    this.clear();
    if (text === "") return;
    this.stream.write(`${text}\n`);
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
    private readonly stream: OutputStream = terminalStream,
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
    private readonly stream: OutputStream = terminalStream,
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
    private readonly glyphs: GlyphSet = UNICODE_GLYPHS,
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
    if (this.state.inFence) {
      const rendered = renderMarkdownLine("```", this.state, { width: this.columns(), depth: this.depth, glyphs: this.glyphs });
      this.stream.write(`${rendered.join("\n")}\n`);
    }
  }

  /** Forgets fence state between turns, so an unclosed block cannot colour the next answer. */
  reset(): void {
    this.pending = "";
    this.atLineStart = true;
    this.state = newMarkdownState();
  }

  private finalizeLine(): void {
    this.erasePending();
    const rendered = renderMarkdownLine(this.pending, this.state, { width: this.columns(), depth: this.depth, glyphs: this.glyphs });
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
  options: { width?: number; depth: ColorDepth; title?: string; titleColor?: "cyan" | "green" | "yellow"; glyphs?: GlyphSet; borderStyle?: "round" | "single" | "double" | "none" },
): string {
  const terminalWidth = options.width ?? process.stdout.columns ?? 80;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const border = borderGlyphsFor(options.borderStyle ?? "round", glyphs);
  const titleWidth = options.title ? visibleWidth(options.title) : 0;
  const titlePaint = options.titleColor === "green" ? GREEN : options.titleColor === "yellow" ? YELLOW : CYAN;
  // Measured in columns, not characters: a todo containing an emoji is two columns wide there and
  // one character long, and padding by the latter is what leaves a border short of its own corner.
  const contentWidth = Math.min(
    Math.max(titleWidth, ...lines.map((line) => visibleWidth(line)), 1),
    Math.max(1, terminalWidth - 4),
  );
  const horizontal = border.horizontal.repeat(contentWidth + 2);
  const top = options.title
    ? `${border.topLeft}${border.horizontal} ${paint(options.title, titlePaint, options.depth)} ${border.horizontal.repeat(Math.max(0, contentWidth - titleWidth - 1))}${border.topRight}`
    : `${border.topLeft}${horizontal}${border.topRight}`;
  const bottom = `${border.bottomLeft}${horizontal}${border.bottomRight}`;
  const body = lines.map((line) => {
    const clipped = visibleWidth(line) > contentWidth
      ? `${sliceToWidth(line, contentWidth - visibleWidth(glyphs.ellipsis))}${glyphs.ellipsis}`
      : line;
    return `${border.vertical} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${border.vertical}`;
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

/** The mode's accent colour in the input bar, so the permission posture is legible at a glance. */
const MODE_COLORS: Record<string, string> = { plan: YELLOW, auto: GREEN, build: CYAN, defender: RED };

/** Visible columns the `│ › ` prefix of the prompt box occupies. */
export const PROMPT_PREFIX_COLUMNS = 4;

/** `╭─ `, the space before the filler, and `─╮` — what the top border costs before any content. */
const PROMPT_CHROME_COLUMNS = 6;

/** The unpainted title text, which is what its column width has to be measured from. */
function promptTitle(mode: string, workspace: string, glyphs: GlyphSet): string {
  return `${glyphs.star} nova ${glyphs.middot} ${mode} ${glyphs.middot} ${workspace}`;
}

/**
 * Columns the top border can give a status line, once its title has been laid out.
 *
 * Exported because the caller has to size the status *before* rendering — `formatStatusLine` drops
 * segments to fit the width it is handed, and handing it the terminal's full width would have it
 * fit a row the corners and the title have already spent part of, which shows up as a status that
 * pushes the closing corner off the screen exactly when the session is busiest.
 */
export function promptStatusRoom(mode: string, workspace: string, width: number, glyphs: GlyphSet = UNICODE_GLYPHS): number {
  return Math.max(0, Math.max(12, width) - visibleWidth(promptTitle(mode, workspace, glyphs)) - PROMPT_CHROME_COLUMNS - 3);
}

/**
 * The input bar that makes the REPL read like a chat app: a titled box around the place you type,
 * drawn onto the rows `layout.ts` reserves for the footer.
 *
 * Three rows, and each is a pure string the caller paints onto a fixed row — nothing here writes
 * to a terminal or counts cursor movements. That is the whole reason the bar can be a box at all:
 * an inline version has to erase itself by walking the cursor back up over however many rows the
 * submitted line happened to wrap onto, and it loses that race against readline's own redraws. On
 * reserved rows the geometry is known in advance and never moves, so the borders simply stay drawn.
 *
 * `top` doubles as the status line — the title is the session's identity (mode, workspace) and the
 * right-hand end carries `status`, whatever the caller currently wants said there: the idle
 * cost-and-mode line between turns, the live activity line during one. Two rows of chrome for what
 * would otherwise be a status line and a separate bar.
 *
 * `prefix` is handed to readline's `question()` rather than printed, which is what keeps the left
 * border on screen through readline's editing redraws — it is part of the prompt, so readline
 * rewrites it whenever it rewrites the line.
 */
export function renderPromptBox(options: {
  mode: string;
  workspace: string;
  depth: ColorDepth;
  width: number;
  /** Right-hand text on the top border. Pre-painted by the caller; measured, never re-styled. */
  status?: string;
  glyphs?: GlyphSet;
  borderStyle?: "round" | "single" | "double" | "none";
}): { top: string; prefix: string; bottom: string } {
  const { mode, workspace, depth } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const border = borderGlyphsFor(options.borderStyle ?? "round", glyphs);
  const width = Math.max(12, options.width);
  const modeColor = MODE_COLORS[mode] ?? CYAN;
  const horizontal = (count: number) => paint(border.horizontal.repeat(Math.max(0, count)), CYAN, depth);

  const CHROME = PROMPT_CHROME_COLUMNS;
  const status = options.status ?? "";
  const separator = ` ${glyphs.middot} `;
  const full = `${paint(glyphs.star, CYAN, depth)} ${paint("nova", CYAN, depth)}${separator}${paint(mode, modeColor, depth)}`;
  // What the title falls back to when the window will not hold the product's own name: the mode is
  // the part that changes what the next keystroke is allowed to do, so it is the part that stays.
  const compact = `${paint(glyphs.star, CYAN, depth)} ${paint(mode, modeColor, depth)}`;

  // The status is shown only if the smallest usable title still fits beside it — a border reduced
  // to a cost figure and a corner has stopped being an input bar. The one column of filler the
  // border always keeps is reserved before any of this: leave it out and the title grows into the
  // gap, the filler floors at one anyway, and the row comes out a column wider than the terminal,
  // which wraps onto the input line below it.
  const statusRoom = status === "" ? 0 : visibleWidth(status) + 2;
  const showStatus = status !== "" && width - CHROME - 1 - statusRoom - visibleWidth(compact) >= 0;
  const room = width - CHROME - 1 - (showStatus ? statusRoom : 0);

  // Widest of the three that fits, longest first. The workspace needs a floor of its own — clipped
  // to two characters it says nothing the transcript above does not already say, so below that it
  // is dropped whole rather than shown as a stub.
  const workspaceRoom = room - visibleWidth(full) - visibleWidth(separator);
  let title: string;
  if (workspaceRoom >= 4) {
    // The ellipsis pays for itself out of the same budget — ASCII's `...` is three columns to
    // Unicode's one — but only when there is something to elide. Charging for it unconditionally
    // clips a workspace that would have fitted whole.
    const shown = visibleWidth(workspace) <= workspaceRoom
      ? workspace
      : `${sliceToWidth(workspace, Math.max(0, workspaceRoom - visibleWidth(glyphs.ellipsis)))}${glyphs.ellipsis}`;
    title = `${full}${separator}${paint(shown, DIM, depth)}`;
  } else if (visibleWidth(full) <= room) title = full;
  else if (visibleWidth(compact) <= room) title = compact;
  else title = paint(glyphs.star, CYAN, depth);

  const tail = showStatus ? ` ${status} ` : "";
  const filler = Math.max(1, width - visibleWidth(title) - visibleWidth(tail) - CHROME);
  const top = `${paint(`${border.topLeft}${border.horizontal}`, CYAN, depth)} ${title} ${horizontal(filler)}${tail}${horizontal(1)}${paint(border.topRight, CYAN, depth)}`;
  const prefix = `${paint(border.vertical, CYAN, depth)} ${paint(glyphs.caret, modeColor, depth)} `;
  const bottom = `${paint(border.bottomLeft, CYAN, depth)}${horizontal(width - 2)}${paint(border.bottomRight, CYAN, depth)}`;
  return { top, prefix, bottom };
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
