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

  private delay: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly onTick: () => void,
    private readonly intervalMs = 120,
    private readonly glyphs: GlyphSet = UNICODE_GLYPHS,
    /**
     * How long an operation must last before it is worth animating.
     *
     * Zero renders immediately, which is right when the caller knows the wait is real. A short
     * delay is right when it does not: an operation that finishes in 40ms draws a spinner frame
     * and erases it, and a run of those reads as flicker rather than as feedback — the thing the
     * spinner exists to prevent. 200ms is the usual threshold, and is below what a person
     * perceives as a pause.
     */
    private readonly delayMs = 0,
  ) {}

  start(): void {
    if (this.timer || this.delay) return;
    const begin = () => {
      this.delay = undefined;
      this.onTick();
      this.timer = setInterval(() => {
        this.frame = (this.frame + 1) % this.glyphs.spinnerFrames.length;
        this.onTick();
      }, this.intervalMs);
    };
    if (this.delayMs <= 0) begin();
    else this.delay = setTimeout(begin, this.delayMs);
  }

  stop(): void {
    // A spinner stopped inside its own start delay never drew anything; cancelling the pending
    // start is what makes that true, and is the whole point of the delay.
    if (this.delay) {
      clearTimeout(this.delay);
      this.delay = undefined;
    }
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
 * A damped harmonic oscillator, in the spirit of Charm's Harmonica but not the same algorithm.
 *
 * Harmonica solves the spring *exactly*: `NewSpring` precomputes a state-transition matrix from the
 * closed-form analytic solution, branching on the three damping regimes (two real exponentials when
 * over-damped, `exp` against `cos`/`sin` when under-damped, the `t·exp` marginal case at exactly
 * critical). This is the implicit — backward — Euler form instead, which is an approximation of the
 * same system rather than the solution to it.
 *
 * That is a deliberate trade, for one reason: Harmonica bakes `deltaTime` into its coefficients at
 * construction, so a spring driven at a rate that changes has to be rebuilt to stay correct. This
 * takes `dt` per step, which is what a terminal actually offers — a repaint interval that slips
 * whenever the event loop is busy. It keeps the property that matters, unconditional stability: a
 * *forward* Euler spring diverges once `dt` grows past its natural period, where this one converges
 * at any timestep at all (verified out to a ten-second step, which no redraw will ever be).
 *
 * Accuracy is the thing given up, and it does not matter here. Nothing in a terminal reads the
 * intermediate positions of a settling animation as data; they are there to be looked at.
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
  /** Confirmed account credit, kept visible ahead of per-turn detail while work is running. */
  balance?: string;
  phase?: ActivityPhase;
  /** Exact tool name while an operation is active; omitted during model reasoning. */
  operation?: string;
  /**
   * Countable progress through the agent's own plan, when it has one.
   *
   * Ranked above every other optional field except the mode: "4/9" is the only thing on the line
   * that says whether the run is progressing, which is the question a person watching a long turn
   * is actually asking.
   */
  steps?: { done: number; total: number; label?: string };
  /**
   * A standing mode marker — currently the spending pace.
   *
   * Ranked just under the mode when the line has to narrow: a pace the user set and then forgot is
   * the field most likely to explain why the agent is behaving the way it is, so it survives longer
   * than the counts and the cost that merely report progress.
   */
  badge?: string;
};

export type HeaderSegment = { full: string; compact?: string };

/**
 * Fits persistent header facts without clipping ANSI styling or wrapping the terminal row.
 * Segments are ordered most-to-least important; the first survives as long as either spelling fits.
 */
export function formatHeaderSegments(segments: readonly HeaderSegment[], width: number, separator = " · "): string {
  const limit = Math.max(0, Math.floor(width));
  if (limit === 0 || segments.length === 0) return "";
  let kept = [...segments];
  while (kept.length > 0) {
    const rendered = kept.map((segment) => segment.full).join(separator);
    if (visibleWidth(rendered) <= limit) return rendered;
    kept = kept.slice(0, -1);
  }
  const first = segments[0];
  const compact = first.compact ?? first.full;
  return visibleWidth(compact) <= limit ? compact : "";
}

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
    // Named apart from web_search because it is a visibly longer wait — up to a minute — and a
    // spinner that says "Searching the web" for that long reads as a hang rather than as work.
    case "deep_research": return "Researching in depth";
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
/**
 * Countable work, counted: `3/8` rather than a spinner that says only "still going".
 *
 * A spinner answers one question — is it alive — and cannot answer the two that matter during a
 * long run: how far along is it, and has it stalled. Whenever the work has steps that can be
 * counted, X-of-Y is the right display and a spinner is a fallback, not a default. The bar is a
 * rendering of the same two numbers and never appears without them, so the reader is never asked
 * to estimate a fraction from a length.
 *
 * Out-of-range input is clamped rather than rejected: a progress display that throws is worse than
 * one that shows `8/8` for a moment while a count catches up.
 */
export function stepProgress(
  done: number,
  total: number,
  options: { label?: string; width?: number; depth: ColorDepth; glyphs?: GlyphSet; from?: Rgb; to?: Rgb },
): string {
  const safeTotal = Math.max(0, Math.floor(Number.isFinite(total) ? total : 0));
  const safeDone = Math.max(0, Math.min(safeTotal, Math.floor(Number.isFinite(done) ? done : 0)));
  const counted = `${safeDone}/${safeTotal}`;
  const label = options.label ? `${options.label} ` : "";
  if (safeTotal === 0) return `${label}${counted}`;
  const width = Math.floor(options.width ?? 0);
  if (width <= 0) return `${label}${counted}`;
  const bar = progressBar(safeDone / safeTotal, width, {
    depth: options.depth,
    glyphs: options.glyphs ?? UNICODE_GLYPHS,
    ...(options.from ? { from: options.from } : {}),
    ...(options.to ? { to: options.to } : {}),
  });
  return `${label}${counted} ${bar}`;
}

export function formatStatusLine(fields: StatusFields, width: number, depth: ColorDepth, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  const label = activityLabel(fields.phase ?? "thinking", fields.operation, fields.elapsedMs);
  const ellipsis = glyphs.ellipsis;
  const separator = ` ${glyphs.middot} `;
  const left = `${fields.spinnerGlyph} ${label}${ellipsis}`;
  const paintedLeft = `${paint(fields.spinnerGlyph, CYAN, depth)} ${paint(`${label}${ellipsis}`, DIM, depth)}`;

  // Ordered least to most important; the front of the list is given up first.
  const optional = [
    fields.cost,
    fields.tokens > 0 ? formatTokens(fields.tokens) : "",
    fields.toolCalls > 0 ? `${fields.toolCalls} tool${fields.toolCalls === 1 ? "" : "s"}` : "",
    fields.badge ?? "",
    fields.steps && fields.steps.total > 0 ? stepProgress(fields.steps.done, fields.steps.total, { label: fields.steps.label ?? "steps", depth: "none" }) : "",
    fields.mode,
    fields.balance ?? "",
  ].filter((segment) => segment !== "");

  let kept = [...optional].reverse(); // most important first, as they read left to right
  for (;;) {
    // The terminal's own separator, not a hardcoded middot: this line is on screen for the whole
    // of every turn, so a glyph the terminal cannot draw is a replacement box the user stares at
    // for minutes rather than one that flickers past.
    const right = [...kept, formatElapsed(fields.elapsedMs)].join(`${separator}`);
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
  options: {
    width?: number;
    depth: ColorDepth;
    title?: string;
    titleColor?: BoxTone;
    /**
     * Colours the border itself, not just the title — how Lip Gloss users conventionally signal
     * state, since a red *edge* reads as "this block is the problem" from across a screen where a
     * red word inside a default-coloured frame reads as one emphasised label. Left unset the border
     * is unpainted, exactly as every box drew before this existed.
     */
    borderColor?: BoxTone;
    glyphs?: GlyphSet;
    borderStyle?: "round" | "single" | "double" | "none";
  },
): string {
  const terminalWidth = options.width ?? process.stdout.columns ?? 80;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const border = borderGlyphsFor(options.borderStyle ?? "round", glyphs);
  const titleWidth = options.title ? visibleWidth(options.title) : 0;
  const titlePaint = TONE_CODES[options.titleColor ?? "cyan"];
  // Each border run is painted and reset on its own rather than one code being opened around the
  // whole row: the title in between carries its own colour, and an unclosed run would bleed this
  // one over it (and over the content of every row after, since the box is joined into one string).
  const edge = (text: string) => (options.borderColor === undefined ? text : paint(text, TONE_CODES[options.borderColor], options.depth));
  // Measured in columns, not characters: a todo containing an emoji is two columns wide there and
  // one character long, and padding by the latter is what leaves a border short of its own corner.
  const contentWidth = Math.min(
    Math.max(titleWidth, ...lines.map((line) => visibleWidth(line)), 1),
    Math.max(1, terminalWidth - 4),
  );
  const horizontal = border.horizontal.repeat(contentWidth + 2);
  const top = options.title
    ? `${edge(`${border.topLeft}${border.horizontal}`)} ${paint(options.title, titlePaint, options.depth)} ${edge(`${border.horizontal.repeat(Math.max(0, contentWidth - titleWidth - 1))}${border.topRight}`)}`
    : edge(`${border.topLeft}${horizontal}${border.topRight}`);
  const bottom = edge(`${border.bottomLeft}${horizontal}${border.bottomRight}`);
  const body = lines.map((line) => {
    const clipped = visibleWidth(line) > contentWidth
      ? `${sliceToWidth(line, contentWidth - visibleWidth(glyphs.ellipsis))}${glyphs.ellipsis}`
      : line;
    return `${edge(border.vertical)} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${edge(border.vertical)}`;
  });
  return [top, ...body, bottom].join("\n");
}

/**
 * Takes as many characters as fit in a column budget, counting wide characters as two and colour
 * codes as nothing.
 *
 * The colour clause is the fix for a bug the callers of this function all shared. It used to walk the
 * string a character at a time, and a lone `\x1b` is not a *sequence* the ANSI pattern can match, so
 * `visibleWidth` measured it one column wide: every escape character in a painted cell spent a column
 * of the budget nobody can see. `table()` a few hundred lines up documents that its cells arrive
 * pre-painted, and a painted cell that needed clipping therefore lost roughly as many visible
 * characters as it carried bytes of colour code.
 *
 * Sequences now copy through free, which is the only reading of "as many characters as fit" that is
 * true of a string with colour in it.
 */
export function sliceToWidth(text: string, width: number): string {
  let taken = "";
  let used = 0;
  // Code-point tokens, not code units: `u` makes `[\s\S]` match an astral character whole rather than
  // splitting a surrogate pair into two halves that render as replacement characters.
  for (const token of text.match(/\x1b\[[0-9;]*m|[\s\S]/gu) ?? []) {
    if (token.startsWith("\x1b")) {
      taken += token;
      continue;
    }
    const next = visibleWidth(token);
    if (used + next > width) break;
    taken += token;
    used += next;
  }
  return taken;
}

/**
 * Clips or pads to exactly `width` columns — Lip Gloss's `Width()`, which sets a block's minimum
 * and lets its own renderer handle the maximum.
 *
 * Every full-screen surface needs this and, until it lived here, every one of them grew its own:
 * `guide-browser.ts` and `file-browser.ts` each carried a byte-identical `pad`, and `tui.ts` a
 * third copy of the `sliceToWidth` underneath it. Three implementations of "make this cell exactly
 * this wide" is three places for a wide-character bug to hide, and only one of them would get fixed.
 */
export function padToWidth(text: string, width: number, align: Align = "left"): string {
  const size = visibleWidth(text);
  if (size >= width) return sliceToWidth(text, width);
  const slack = width - size;
  if (align === "right") return " ".repeat(slack) + text;
  if (align === "center") return " ".repeat(Math.floor(slack / 2)) + text + " ".repeat(Math.ceil(slack / 2));
  return text + " ".repeat(slack);
}

/**
 * Which edge a cell's content sits against — Lip Gloss's `Align`.
 *
 * Worth a named parameter rather than leaving each caller to `padStart`, because the choice is not
 * cosmetic: a column of numbers left-aligned cannot be compared down its own length, since the
 * digit that means "hundreds" is in a different place on every row. `code-view.ts`,
 * `patch-view.ts` and `models.ts` had each independently reached for `padStart` to fix that
 * locally; the charts had not, and read wrong as a result.
 */
export type Align = "left" | "right" | "center";

/**
 * Two columns side by side with a separator between them — Lip Gloss's `JoinHorizontal`, reduced to
 * the single-row case every one of Nova's split-pane screens actually builds with.
 *
 * Both cells are sized before joining, so the result is always exactly
 * `leftWidth + separator + rightWidth` columns regardless of what either side contains. That is the
 * property the layouts depend on: a preview pane whose text happens to be one column too long must
 * not push the divider a column right on that row alone, which is precisely how a two-pane frame
 * develops a ragged seam down its middle.
 */
export function joinHorizontal(
  left: string,
  right: string,
  options: { leftWidth: number; rightWidth: number; separator?: string; leftAlign?: Align; rightAlign?: Align },
): string {
  const separator = options.separator ?? " ";
  return `${padToWidth(left, options.leftWidth, options.leftAlign)}${separator}${padToWidth(right, options.rightWidth, options.rightAlign)}`;
}

/** The tones a box can be given, for its title or its border. */
export type BoxTone = "cyan" | "green" | "yellow" | "red";

const TONE_CODES: Record<BoxTone, string> = { cyan: CYAN, green: GREEN, yellow: YELLOW, red: RED };

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
  // The live account/status reading outranks the workspace on a constrained header. Reserve
  // against the compact title (`✦ build`), which `renderPromptBox` already falls back to, so a
  // balance does not disappear merely because the current directory has a long name.
  const compactTitle = `${glyphs.star} ${mode}`;
  return Math.max(0, Math.max(12, width) - visibleWidth(compactTitle) - PROMPT_CHROME_COLUMNS - 3);
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
 * The part of a line that has wrapped past its first row, given the column the cursor started at.
 *
 * Exists because readline wraps. Bubbles' `textinput` has no equivalent and needs none: its
 * `handleOverflow` slides a horizontal viewport (`offset`/`offsetRight`) so the field is always
 * exactly one row tall and the cursor is always inside it — the text scrolls sideways instead of
 * ever reaching a second row. That is the better design and it is not available here, because
 * readline owns echo and line editing (which is what buys history, completion and bracketed paste)
 * and it wraps. So the box has to know what spilled, rather than prevent the spill.
 */
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
 * Draws and erases the chat-style input bar *inline*, tracking only the rows it printed.
 *
 * The counterpart to `PinnedScreen`'s reserved-row version, and the one almost every session
 * actually gets: pinning the footer costs the terminal's scrollback (a held `DECSTBM` region means
 * scrolled-off lines are never saved), so it is off unless asked for — which left the default
 * session with a bare `nova ›` and no bar at all. This draws the same box by printing it and then
 * erasing exactly what it printed, which costs no scrollback and holds no region.
 *
 * The trade is that readline is redrawing the same rows. `question(prefix)` is what makes it
 * survivable: the left border is handed over as the *prompt*, so readline reprints it as part of
 * every editing redraw instead of overwriting it. The closing border has no such protection and is
 * only guaranteed while the line is typed forward — hence `dropBorder`, which opens the box rather
 * than letting the border sit under a line of text.
 */
/**
 * Paints suggestion rows that already exist, without moving the cursor as far as readline knows.
 *
 * `DECSC`/`DECRC` (`\x1b7`/`\x1b8`) save and restore the absolute cursor position around the whole
 * write, which is what makes this safe to call mid-keystroke: readline's model of where the cursor
 * is never stops being true, because by the time control returns the cursor is exactly where it was.
 * The same technique the ghost-text completion already uses, one row further up.
 *
 * Every motion is *relative*. The cursor is on the input row by construction, so `up (rows + 1)`
 * finds the top of the list — past the input row and the top border — without anything here needing
 * to know which absolute screen row the bar has reached. That is the difference from
 * `PinnedScreen.renderSuggestions`, which addresses rows absolutely and therefore only works when a
 * held region has pinned the bar to a known row.
 *
 * Valid only when the row count is unchanged: rows are overwritten here, never created.
 */
export function dropupPaintInPlace(lines: readonly string[]): string {
  if (lines.length === 0) return "";
  const parts = ["\x1b7\x1b[?25l", `\x1b[${lines.length + 1}A`];
  for (const line of lines) parts.push(`\r\x1b[2K${line}\x1b[1B`);
  parts.push("\x1b8\x1b[?25h");
  return parts.join("");
}

/**
 * Moves to the top of the whole bar block and erases everything from there down.
 *
 * `ED 0` rather than a clear-per-row loop: one sequence, and no arithmetic about how far the closing
 * border or a wrapped line reached. It is also exactly what readline uses for the same job, so the
 * block is being torn down the same way its own occupant tears down a line. The caller reprints
 * immediately afterwards, which is what lets the block *grow*: printing more rows than were erased
 * scrolls the terminal, and scrolled-off transcript enters real scrollback rather than being
 * overwritten in place.
 */
export function dropupEraseBlock(currentRows: number): string {
  return `\x1b[?25l\x1b[${currentRows + 1}A\r\x1b[0J`;
}

export class PromptBox {
  private drawn = false;
  private borderCleared = false;
  /**
   * The suggestion rows currently printed above the box's top border.
   *
   * Held here rather than in a separate object because the rows are part of the same printed block:
   * they are erased by the same `erase()` and their count shifts every row below them. Two owners of
   * this block is the mistake that produced the earlier blank-space bug — the box moved, and the
   * list kept painting where the box used to be. One owner is the rule.
   */
  private suggestions: string[] = [];

  constructor(
    private readonly stream: OutputStream = terminalStream,
    private readonly options: {
      depth: ColorDepth;
      glyphs?: GlyphSet;
      borderStyle?: "round" | "single" | "double" | "none";
      columns?: () => number;
    } = { depth: "none" },
  ) {}

  get isDrawn(): boolean {
    return this.drawn;
  }

  private get width(): number {
    // Floored at one: a degenerate stream can report zero columns (a 0x0 pty), and the erase below
    // divides by this.
    return Math.max(1, this.options.columns?.() ?? this.stream.columns ?? 80);
  }

  /**
   * Renders the box and parks the cursor at the start of its input row, returning the prefix to
   * hand to readline's `question()`.
   */
  draw(mode: string, workspace: string, status?: string): string {
    const { prefix } = this.paintBlock(mode, workspace, status);
    this.drawn = true;
    this.borderCleared = false;
    return prefix;
  }

  /**
   * Prints the whole block — suggestion rows, top border, input row, closing border — from the
   * cursor's current row, and leaves the cursor at column one of the input row.
   *
   * Shared by `draw()` and by a relayout, because they differ only in what came before them: the
   * first prints into fresh rows at the end of the transcript, the second prints into rows a
   * relayout has just erased. Both need the block to be one contiguous print so that a block which
   * has outgrown the screen scrolls exactly once, and so the transcript it pushes up goes into real
   * scrollback rather than being overwritten in place.
   */
  private paintBlock(mode: string, workspace: string, status?: string): { prefix: string } {
    const { top, prefix, bottom } = renderPromptBox({
      mode,
      workspace,
      depth: this.options.depth,
      width: this.width,
      ...(status === undefined ? {} : { status }),
      ...(this.options.glyphs === undefined ? {} : { glyphs: this.options.glyphs }),
      ...(this.options.borderStyle === undefined ? {} : { borderStyle: this.options.borderStyle }),
    });
    // The list first, so it ends up above the border it belongs to.
    for (const line of this.suggestions) this.stream.write(`${line}\n`);
    this.stream.write(`${top}\n`);
    this.stream.write(`\n${bottom}`);
    // Back onto the input row at column one; `question()` writes the prefix from there.
    this.stream.write("\x1b[1A\r");
    return { prefix };
  }

  /** How many rows the suggestion list is currently occupying. Zero when there is no list. */
  get suggestionRows(): number {
    return this.suggestions.length;
  }

  /**
   * Updates the suggestion list, and says whether the bar had to move to do it.
   *
   * Two paths, and the split is the whole reason this is fast enough to run on every keystroke:
   *
   * - **Same row count** — the rows already exist, so they are overwritten in place with the cursor
   *   saved and restored around the write. Readline's model of the cursor never changes, nothing
   *   below the list is touched, and no part of the terminal scrolls. This is the common case: a
   *   list narrowing from `/mo` to `/mod` usually keeps its height.
   * - **Different row count** — rows have to be created or destroyed above the bar, which no
   *   terminal can do without moving the bar itself. The block is erased and reprinted, and the
   *   caller is told (`moved: true`) that readline must now redraw its line, because the erase took
   *   the input row with it.
   *
   * Returning the flag rather than redrawing here keeps this class free of any readline dependency —
   * it writes to a stream and nothing else, which is what makes it testable against a fake one.
   */
  setSuggestions(lines: readonly string[], bar: { mode: string; workspace: string; status?: string }): { moved: boolean } {
    if (!this.drawn) return { moved: false };
    const next = [...lines];
    if (next.length === this.suggestions.length) {
      // Identical content is not repainted. Typing past the point where the match set stops
      // changing — the `der` of `/wander` — otherwise reissues the same rows on every keystroke,
      // which is invisible on a fast local terminal and a visible stutter over ssh or tmux.
      if (next.every((line, index) => line === this.suggestions[index])) return { moved: false };
      this.suggestions = next;
      if (next.length > 0) this.stream.write(dropupPaintInPlace(next));
      return { moved: false };
    }
    // Erase from the top of the *current* block, then reprint with the new row count.
    this.stream.write(dropupEraseBlock(this.suggestions.length));
    this.suggestions = next;
    this.paintBlock(bar.mode, bar.workspace, bar.status);
    this.stream.write("\x1b[?25h");
    this.borderCleared = false;
    return { moved: true };
  }

  /**
   * Redraws the closing border, which readline destroys whenever it refreshes its line.
   *
   * Readline's refresh moves to the start of the input line and issues `ED 0`, erasing everything
   * from there to the bottom of the screen — so the border below the input row is collateral on
   * every history recall, every completion and every relayout. Save/restore around the write is what
   * lets this run afterwards without disturbing where readline believes the cursor is.
   */
  restoreBottomBorder(mode: string, workspace: string, status?: string): void {
    if (!this.drawn || this.borderCleared) return;
    const { bottom } = renderPromptBox({
      mode,
      workspace,
      depth: this.options.depth,
      width: this.width,
      ...(status === undefined ? {} : { status }),
      ...(this.options.glyphs === undefined ? {} : { glyphs: this.options.glyphs }),
      ...(this.options.borderStyle === undefined ? {} : { borderStyle: this.options.borderStyle }),
    });
    this.stream.write(`\x1b7\x1b[?25l\x1b[1B\r\x1b[2K${bottom}\x1b8\x1b[?25h`);
  }

  /**
   * Removes the box once a line resolves, leaving the cursor on the row the top border occupied so
   * the caller can print the next transcript line exactly there.
   *
   * The count follows the geometry readline leaves behind at submit: it redraws `prefix + line`
   * from column one (the prefix survives because it is the prompt), then finishes with a newline.
   * `prefix` is four columns, so a submitted line of width `W` occupies
   * `floor((4 + W - 1) / width)` rows below the border — plus the input row, the newline row, and
   * the border row itself.
   */
  erase(submitted: string): void {
    if (!this.drawn) return;
    // Plus the suggestion rows, which sit above the top border and were printed by the same block.
    // Omitting them is what would leave the list stranded above the next transcript line — visible,
    // stale, and describing a command that has already been run.
    const rows = Math.floor((PROMPT_PREFIX_COLUMNS + visibleWidth(submitted) - 1) / this.width) + 3 + this.suggestions.length;
    for (let index = 0; index < rows; index += 1) this.stream.write("\x1b[1A\x1b[2K");
    this.suggestions = [];
    this.drawn = false;
  }

  /**
   * Opens the box once the typed line has wrapped past its input row, dropping the closing border
   * and re-showing the wrapped remainder so the border cannot sit underneath text.
   *
   * Bubbles would not need this — see `wrappedRemainder`. Given readline does wrap, opening the box
   * is the honest failure mode: a bar missing its bottom edge reads as "still typing", where a
   * border stranded in the middle of a message reads as a rendering fault.
   */
  dropBorder(remainder: string): void {
    if (!this.drawn || this.borderCleared || remainder === "") return;
    // The cursor is on the border row the moment wrapping starts: clear it and rewrite the
    // remainder, so the text that already wrapped onto it is not lost.
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
