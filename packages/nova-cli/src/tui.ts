import type { ColorDepth } from "./banner";
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

function paint(text: string, code: string, depth: ColorDepth): string {
  return depth === "none" ? text : `${code}${text}${RESET}`;
}

/**
 * A tiny supernova rather than a generic wheel.
 *
 * Every frame is five columns wide, so the activity text never jitters left and right while the
 * core brightens and the two outer sparks collapse back in. The glyphs come from the opening
 * starfield, making this feel like a living piece of Nova instead of a borrowed loader.
 */
const SPINNER_FRAMES = ["·   ·", "· ✧ ·", "· ✦ ·", "✧ ✶ ✧", "· ✦ ·", "· ✧ ·"] as const;

export function novaSpinnerFrame(index: number): string {
  const normalized = Number.isFinite(index) ? Math.max(0, Math.floor(index)) : 0;
  return SPINNER_FRAMES[normalized % SPINNER_FRAMES.length];
}

export class Spinner {
  private frame = 0;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly onTick: () => void, private readonly intervalMs = 120) {}

  start(): void {
    if (this.timer) return;
    // Render immediately. Waiting one interval makes short operations look as though the CLI
    // froze and then recovered, which is precisely the uncertainty a spinner is meant to remove.
    this.onTick();
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
    return novaSpinnerFrame(this.frame);
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
export function formatStatusLine(fields: StatusFields, width: number, depth: ColorDepth): string {
  const label = activityLabel(fields.phase ?? "thinking", fields.operation, fields.elapsedMs);
  const left = `${fields.spinnerGlyph} ${label}…`;
  const paintedLeft = `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint(`${label}…`, DIM, depth)}`;

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
      if (total > width) {
        if (visibleWidth(left) <= width) return paintedLeft;
        const compact = `${fields.spinnerGlyph} …`;
        if (visibleWidth(compact) <= width) return `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint("…", DIM, depth)}`;
        return width > 0 ? paint("✦", CYAN, depth) : "";
      }
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
    if (this.state.inFence) {
      const rendered = renderMarkdownLine("```", this.state, { width: this.columns(), depth: this.depth });
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
export function box(lines: readonly string[], options: { width?: number; depth: ColorDepth; title?: string }): string {
  const terminalWidth = options.width ?? process.stdout.columns ?? 80;
  const titleWidth = options.title ? visibleWidth(options.title) : 0;
  // Measured in columns, not characters: a todo containing an emoji is two columns wide there and
  // one character long, and padding by the latter is what leaves a border short of its own corner.
  const contentWidth = Math.min(
    Math.max(titleWidth, ...lines.map((line) => visibleWidth(line)), 1),
    Math.max(1, terminalWidth - 4),
  );
  const horizontal = "─".repeat(contentWidth + 2);
  const top = options.title
    ? `╭─ ${paint(options.title, CYAN, options.depth)} ${"─".repeat(Math.max(0, contentWidth - titleWidth - 1))}╮`
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
