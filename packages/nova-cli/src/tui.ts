import type { ColorDepth } from "./banner";
import { terminalStream, type OutputStream } from "./output";
import { ASCII_GLYPHS, borderGlyphsFor, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { newMarkdownState, renderMarkdownLine, visibleWidth, type MarkdownState } from "./markdown";
import { rgbTo256, type Rgb } from "./theme";

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

/** `6s`, or `1m 05s` once a minute is on the clock — Bubbles' Timer output format. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/**
 * Counts down to zero and says so on the way — Nova's answer to Bubbles' `timer`, for the one place
 * that used to go silent for the whole wait: the pace's cooldown between turns printed one static
 * "pausing 6s" line and then `setTimeout`'d through it, so a slow pace looked frozen rather than
 * counting down.
 *
 * A plain `setInterval` wrapped for the same reason `Spinner` is: so the call site owns only "what
 * a tick looks like," not clock arithmetic, and ticking against a fixed end time rather than
 * counting down a mutable remainder means a slow event loop cannot make the timer drift long.
 */
export class CountdownTimer {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly endsAt: number;

  constructor(
    durationMs: number,
    private readonly onTick: (remainingMs: number) => void,
    private readonly onDone: () => void,
    private readonly intervalMs = 1_000,
  ) {
    this.endsAt = Date.now() + Math.max(0, durationMs);
  }

  get remaining(): number {
    return Math.max(0, this.endsAt - Date.now());
  }

  start(): void {
    if (this.timer) return;
    if (this.remaining <= 0) { this.onDone(); return; }
    this.onTick(this.remaining);
    this.timer = setInterval(() => {
      const left = this.remaining;
      if (left <= 0) { this.stop(); this.onDone(); return; }
      this.onTick(left);
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}

/**
 * A damped harmonic oscillator — Charm's Harmonica, ported: the same closed-form spring integrator,
 * unconditionally stable at any timestep rather than only small ones. A naive Euler spring blows up
 * or visibly stutters once `dt` gets coarse; a terminal repaints at whatever rate is comfortable to
 * look at (tens of milliseconds), which is coarse enough that stability at real redraw intervals —
 * not just at 60fps — is the property that actually matters here.
 */
export class Spring {
  constructor(private readonly angularFrequency: number, private readonly dampingRatio: number) {}

  /** One step forward. `dt` in seconds. Returns the new `[position, velocity]`. */
  update(position: number, velocity: number, target: number, dt: number): [number, number] {
    const omega = this.angularFrequency;
    const zeta = this.dampingRatio;
    const f = 1 + 2 * dt * zeta * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const detInv = 1 / (f + hhoo);
    const detX = f * position + dt * velocity + hhoo * target;
    const detV = velocity + hoo * (target - position);
    return [detX * detInv, detV * detInv];
  }
}

export type SpringAnimatorOptions = {
  /** How stiff the spring is — higher settles faster. Tuned for a redraw a person is meant to notice, not a snap. */
  angularFrequency?: number;
  /** 1 is critically damped (no overshoot); below 1 oscillates before settling. */
  dampingRatio?: number;
  intervalMs?: number;
  /** Stops ticking once within this distance of the target with near-zero velocity, rather than running forever on an unnoticeable tail. */
  epsilon?: number;
};

/**
 * Drives a `Spring` toward a moving target over real time, ticking a callback with the current
 * position until it settles — the same shape `Spinner` and `CountdownTimer` already use, so a
 * caller manages this exactly like the other two: `start`/`stop`, one `onTick`.
 *
 * The target can change mid-flight — `retarget` just updates where the spring is headed without
 * resetting its current position or velocity, which is the whole point: a second keystroke while a
 * resize is still animating should redirect it, not restart it from a standstill.
 */
export class SpringAnimator {
  private readonly spring: Spring;
  private position: number;
  private velocity = 0;
  private target: number;
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly intervalMs: number;
  private readonly epsilon: number;

  constructor(initial: number, private readonly onTick: (position: number) => void, options: SpringAnimatorOptions = {}) {
    this.position = initial;
    this.target = initial;
    this.spring = new Spring(options.angularFrequency ?? 18, options.dampingRatio ?? 0.86);
    this.intervalMs = options.intervalMs ?? 40;
    this.epsilon = options.epsilon ?? 0.01;
  }

  get value(): number {
    return this.position;
  }

  get settled(): boolean {
    return !this.timer;
  }

  /** Redirects the spring at its current position and velocity — it does not jump or reset. */
  retarget(target: number): void {
    this.target = target;
    if (Math.abs(this.target - this.position) < this.epsilon && Math.abs(this.velocity) < this.epsilon) {
      this.position = target;
      this.onTick(target);
      return;
    }
    this.ensureRunning();
  }

  /** Jumps straight there — no animation — and stops. For the moments a spring would be wrong: dismissal, not resize. */
  snapTo(target: number): void {
    this.stop();
    this.position = target;
    this.velocity = 0;
    this.target = target;
    this.onTick(target);
  }

  private ensureRunning(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const dt = this.intervalMs / 1_000;
      const [pos, vel] = this.spring.update(this.position, this.velocity, this.target, dt);
      this.position = pos;
      this.velocity = vel;
      if (Math.abs(this.target - pos) < this.epsilon && Math.abs(vel) < this.epsilon) {
        this.position = this.target;
        this.stop();
        this.onTick(this.target);
        return;
      }
      this.onTick(pos);
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
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

/** Sub-character fill precision, low to high — the partial cell at the fill's leading edge. */
const PARTIAL_BLOCKS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const FULL_BLOCK = "█";
const TRACK_BLOCK = "░";

export type ProgressBarOptions = {
  depth: ColorDepth;
  /** ASCII terminals get `#`/`-` at whole-cell precision; anything else gets eighth-cell blocks. */
  glyphs?: GlyphSet;
  /** Gradient endpoints. Defaults to Nova's own sky: starlight blue cooling into warm gold. */
  from?: Rgb;
  to?: Rgb;
};

const DEFAULT_GRADIENT_FROM: Rgb = { r: 138, g: 180, b: 248 }; // starry-night --primary
const DEFAULT_GRADIENT_TO: Rgb = { r: 255, g: 138, b: 155 }; // starry-night --error

function lerp(from: Rgb, to: Rgb, t: number): Rgb {
  return { r: from.r + (to.r - from.r) * t, g: from.g + (to.g - from.g) * t, b: from.b + (to.b - from.b) * t };
}

function paintRgb(text: string, rgb: Rgb, depth: ColorDepth): string {
  if (depth === "none") return text;
  const r = Math.round(rgb.r);
  const g = Math.round(rgb.g);
  const b = Math.round(rgb.b);
  const code = depth === "truecolor" ? `\x1b[38;2;${r};${g};${b}m` : `\x1b[38;5;${rgbTo256({ r, g, b })}m`;
  return `${code}${text}\x1b[0m`;
}

/**
 * A gradient-filled meter — Nova's answer to Bubbles' `progress` component. Bounded to `width`
 * cells, filled left to right at eighth-cell precision so a fraction like 37% lands somewhere
 * *inside* a cell rather than always rounding to the nearest whole block.
 *
 * The gradient runs across the bar's *full* width, not just its filled portion, so how much of it
 * you see is itself information: a bar barely filled shows only the gradient's cool end, and one
 * nearly full reveals almost the whole run toward its warm end — the same "starts calm, gets more
 * urgent as it fills" read a budget or health bar earns by design, for free, from one mechanism.
 */
export function progressBar(fraction: number, width: number, options: ProgressBarOptions): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const cells = Math.max(1, Math.floor(width));
  const from = options.from ?? DEFAULT_GRADIENT_FROM;
  const to = options.to ?? DEFAULT_GRADIENT_TO;
  const ascii = options.glyphs === ASCII_GLYPHS;
  const eighths = ascii ? cells : cells * 8;
  const filledEighths = Math.round(clamped * eighths);

  let bar = "";
  for (let index = 0; index < cells; index += 1) {
    const t = cells <= 1 ? 0 : index / (cells - 1);
    const rgb = lerp(from, to, t);
    if (ascii) {
      bar += index < filledEighths ? paintRgb("#", rgb, options.depth) : "-";
      continue;
    }
    const cellStart = index * 8;
    if (filledEighths >= cellStart + 8) bar += paintRgb(FULL_BLOCK, rgb, options.depth);
    else if (filledEighths > cellStart) bar += paintRgb(PARTIAL_BLOCKS[filledEighths - cellStart], rgb, options.depth);
    else bar += options.depth === "none" ? TRACK_BLOCK : `\x1b[2m${TRACK_BLOCK}\x1b[0m`;
  }
  return bar;
}

/**
 * Aligned columns with a header rule — Nova's answer to Bubbles' `table` component, for the two
 * places that were hand-padding strings with `.padEnd()` instead: `/providers` and the model list.
 *
 * Column widths come from the content itself (header or widest cell, whichever is longer), then
 * shrink the widest column first if the total would not fit — the same "clip the thing that has
 * room to lose, not everything equally" choice `box()` already makes for a single block of text.
 * Cells arrive pre-painted (colour codes and all); `visibleWidth` already discounts ANSI, which is
 * the only reason colouring a status column doesn't throw off every column after it.
 */
export function table(
  columns: readonly string[],
  rows: readonly (readonly string[])[],
  options: { depth: ColorDepth; width?: number; glyphs?: GlyphSet; borderStyle?: "round" | "single" | "double" | "none" },
): string {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const border = borderGlyphsFor(options.borderStyle ?? "round", glyphs);
  const terminalWidth = Math.max(1, options.width ?? process.stdout.columns ?? 80);
  const count = columns.length;
  const widths = columns.map((header, index) =>
    Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ""))));

  // Each column costs its content plus one space of padding on each side, plus the vertical rules:
  // count + 1 of them bracket count columns.
  const budget = terminalWidth - (count + 1) - count * 2;
  while (widths.reduce((sum, width) => sum + width, 0) > Math.max(count, budget)) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 3) break; // nothing left worth shrinking
    widths[widest] -= 1;
  }

  const cell = (text: string, width: number): string => {
    const clipped = visibleWidth(text) > width
      ? `${sliceToWidth(text, Math.max(0, width - visibleWidth(glyphs.ellipsis)))}${glyphs.ellipsis}`
      : text;
    return `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
  };
  const rule = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((width) => border.horizontal.repeat(width + 2)).join(mid)}${right}`;
  const row = (cells: readonly string[]): string =>
    `${border.vertical} ${widths.map((width, index) => cell(cells[index] ?? "", width)).join(` ${border.vertical} `)} ${border.vertical}`;

  return [
    rule(border.topLeft, border.horizontal, border.topRight),
    row(columns.map((header) => paint(header, DIM, options.depth))),
    rule(border.teeLeft, border.cross, border.teeRight),
    ...rows.map((line) => row(line)),
    rule(border.bottomLeft, border.horizontal, border.bottomRight),
  ].join("\n");
}

/**
 * How far a window has scrolled through content taller than it — Bubbles' viewport `ScrollPercent`,
 * generalised so either scroll convention (offset counted from the top, as the guide does, or from
 * the bottom, as the workspace panel does) can produce it without knowing about the other.
 *
 * `offsetFromTop` is always measured the same way regardless of what a caller calls "scroll": zero
 * is the very first line on screen, and `contentLines - viewportHeight` is the last possible
 * position. A caller whose own scroll counts from the bottom converts once at the call site.
 *
 * Content that fully fits already has nothing to scroll through, so it reports fully shown (`1`)
 * rather than dividing by zero.
 */
export function scrollPercent(offsetFromTop: number, contentLines: number, viewportHeight: number): number {
  const maxOffset = Math.max(0, contentLines - viewportHeight);
  if (maxOffset === 0) return 1;
  return Math.max(0, Math.min(1, offsetFromTop / maxOffset));
}

/** `scrollPercent` as the label a footer shows: `Top`/`Bot` at the edges, a rounded percentage between. */
export function scrollIndicator(fraction: number): string {
  if (fraction >= 1) return "Bot";
  if (fraction <= 0) return "Top";
  return `${Math.round(fraction * 100)}%`;
}

/**
 * "Where am I in this list" — Bubbles' `paginator`, for the menus (`/palette`, the model picker,
 * settings) whose window scrolls continuously rather than in fixed pages. `"arabic"` (the default)
 * is what fits that: a position among a count, not a page among pages, since nothing here is
 * actually paged. `"dots"` is kept for a caller that genuinely does have discrete pages — a handful
 * of them, or the row becomes longer than the thing it is describing the position of.
 */
export function paginator(current: number, total: number, options: { style?: "arabic" | "dots"; glyphs?: GlyphSet } = {}): string {
  const count = Math.max(1, Math.floor(total));
  const index = Math.max(0, Math.min(Math.floor(current), count - 1));
  if (options.style === "dots") {
    const glyphs = options.glyphs ?? UNICODE_GLYPHS;
    return Array.from({ length: count }, (_, position) => (position === index ? glyphs.bullet : glyphs.middot)).join(" ");
  }
  return `${index + 1}/${count}`;
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

  /**
   * Rewrites every line in one redraw, for a caller updating them all on the same tick — an
   * animation repainting a whole multi-line block would otherwise call `update` once per line and
   * pay for a full redraw each time, turning one frame into as many redraws as the block has lines.
   */
  updateAll(texts: readonly string[]): void {
    for (let row = 0; row < this.rows; row += 1) this.stream.write("\x1b[1A\x1b[2K");
    this.stream.write("\r");
    for (let index = 0; index < texts.length && index < this.entries.length; index += 1) this.entries[index] = texts[index];
    this.rows = 0;
    for (const entry of this.entries) {
      this.stream.write(`${entry}\n`);
      this.rows += rowsOccupied(entry, this.columns());
    }
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
