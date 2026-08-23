import { visibleWidth } from "./markdown";
import { applyViewport, atBottom, maxTop, newViewport, scrollFraction, visibleLines, type ViewportState } from "./viewport";

/**
 * The transcript as something Nova owns, rather than something it has already given away.
 *
 * Nova's default layout writes each line to stdout and forgets it: the terminal keeps the history,
 * the terminal scrolls it, and the terminal searches it. That is a genuinely good trade — copy,
 * `Cmd+F` and scroll-up all keep working, and `screen.ts` records it as the reason the pinned
 * footer was chosen over a full-screen app.
 *
 * A *fixed* layout is the other trade. The frame stays put, scrolling happens inside the body, and
 * the price is that Nova must now do the three things the terminal was doing for free. This module
 * is the first of them: keeping the lines.
 *
 * Everything here is pure. No escape sequences, no stdout, no key reading — those live in
 * `fixed-screen.ts`, which is thin precisely because all the arithmetic that can be wrong is here
 * and under test. The behaviours worth naming:
 *
 * **Following is conditional, always.** New output pins the view to the bottom only if the reader
 * was already there. Being yanked away from something you scrolled up to read is the single most
 * common way a fixed-layout TUI becomes unbearable, and it is one `atBottom` check.
 *
 * **Wrapping is a view concern, not a storage one.** The buffer holds logical lines as they were
 * written; wrapping happens against the current width. That is what makes a resize re-flow instead
 * of re-truncate, and it is why the buffer can be re-rendered at any width without loss.
 *
 * **Dropping old lines must not move the view.** A bounded buffer that forgets its oldest line
 * while the reader sits mid-history would shift everything under them by one row per line dropped.
 * The drop is compensated in `top`.
 */

/** Logical lines retained. Beyond this the oldest are dropped; see `appendLines` for the compensation. */
export const DEFAULT_BUFFER_LINES = 20_000;

/**
 * Written as escapes rather than as the byte itself.
 *
 * A raw control character in source survives until the first person copies the line, a linter
 * normalises it, or a diff viewer swallows it — and then the wrapping silently counts colour codes
 * as visible columns.
 */
const ESCAPE = "\u001b";
const STYLE_PATTERN = /\u001b\[[0-9;]*m/g;

export type FixedLayoutState = {
  /** Logical lines, unwrapped, oldest first. */
  buffer: readonly string[];
  /** The window over the *wrapped* projection of `buffer`. */
  viewport: ViewportState;
  /** Terminal size the wrapped projection was computed at. */
  columns: number;
  rows: number;
  /** How many rows the frame spends on things that are not transcript. */
  chrome: number;
  /** Active search, if any. */
  search: { query: string; matches: readonly number[]; index: number } | null;
  /** Lines dropped from the front over the session's life, for an honest "history truncated" note. */
  dropped: number;
  maxBufferLines: number;
};

export type FixedLayoutOptions = {
  columns: number;
  rows: number;
  /** Rows reserved for header, composer and status. Defaults to a header line plus a two-row composer. */
  chrome?: number;
  maxBufferLines?: number;
};

/** Rows the transcript body actually gets. Never below one: a terminal can always show something. */
export function bodyHeight(rows: number, chrome: number): number {
  return Math.max(1, Math.floor(rows) - Math.max(0, Math.floor(chrome)));
}

/**
 * Wraps logical lines to a width, preserving blank lines.
 *
 * A blank line means a paragraph break in a transcript, and dropping it while wrapping turns two
 * separated answers into one wall of text. Lines already narrower than the width are passed through
 * untouched so styled output keeps its escape sequences intact.
 */
export function wrapToWidth(lines: readonly string[], columns: number): string[] {
  const width = Math.max(1, Math.floor(columns));
  const wrapped: string[] = [];
  for (const line of lines) {
    if (line === "") {
      wrapped.push("");
      continue;
    }
    if (visibleWidth(line) <= width) {
      wrapped.push(line);
      continue;
    }
    // Hard-sliced by visible width, so a styled line wraps where it *looks* like it should rather
    // than where its escape sequences happen to fall.
    let remaining = line;
    while (remaining.length > 0 && visibleWidth(remaining) > width) {
      let cut = 0;
      let shown = 0;
      while (cut < remaining.length && shown < width) {
        // Escape sequences cost no visible width, so they are carried into the current slice whole.
        if (remaining[cut] === ESCAPE) {
          const end = remaining.indexOf("m", cut);
          cut = end === -1 ? remaining.length : end + 1;
          continue;
        }
        cut += 1;
        shown += 1;
      }
      wrapped.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut);
    }
    if (remaining.length > 0) wrapped.push(remaining);
  }
  return wrapped;
}

export function newFixedLayout(options: FixedLayoutOptions): FixedLayoutState {
  const chrome = options.chrome ?? 3;
  return {
    buffer: [],
    viewport: newViewport([], bodyHeight(options.rows, chrome)),
    columns: Math.max(1, Math.floor(options.columns)),
    rows: Math.max(1, Math.floor(options.rows)),
    chrome,
    search: null,
    dropped: 0,
    maxBufferLines: options.maxBufferLines ?? DEFAULT_BUFFER_LINES,
  };
}

/** Recomputes the window over the buffer, following the tail only when the reader was already there. */
function project(state: FixedLayoutState, options: { follow: boolean; droppedRows?: number }): FixedLayoutState {
  const lines = wrapToWidth(state.buffer, state.columns);
  const height = bodyHeight(state.rows, state.chrome);
  const resized = applyViewport(state.viewport, { kind: "resize", height });
  const withContent = applyViewport(resized, { kind: "content", lines, follow: options.follow });
  // Compensating for lines that fell off the front keeps the reader looking at the same text.
  const compensated = options.droppedRows && !options.follow
    ? applyViewport(withContent, { kind: "up", rows: options.droppedRows })
    : withContent;
  return { ...state, viewport: compensated };
}

/**
 * Appends output and re-projects.
 *
 * `follow` is decided *before* the content changes, because "was the reader at the bottom" is a
 * question about the view they were looking at, not the one they are about to get.
 */
export function appendLines(state: FixedLayoutState, incoming: readonly string[]): FixedLayoutState {
  if (incoming.length === 0) return state;
  const follow = atBottom(state.viewport);
  const combined = [...state.buffer, ...incoming];
  const overflow = Math.max(0, combined.length - state.maxBufferLines);
  const buffer = overflow > 0 ? combined.slice(overflow) : combined;
  // Rows lost from the top, measured after wrapping, since one logical line can be several rows.
  const droppedRows = overflow > 0 ? wrapToWidth(combined.slice(0, overflow), state.columns).length : 0;
  const next: FixedLayoutState = { ...state, buffer, dropped: state.dropped + overflow };
  return project(next, { follow, droppedRows });
}

/** A terminal resize: re-flow at the new width, keeping the reader where they were. */
export function resize(state: FixedLayoutState, columns: number, rows: number): FixedLayoutState {
  const follow = atBottom(state.viewport);
  const next = { ...state, columns: Math.max(1, Math.floor(columns)), rows: Math.max(1, Math.floor(rows)) };
  return project(next, { follow });
}

export type FixedLayoutAction =
  | { kind: "up" | "down"; rows?: number }
  | { kind: "halfUp" | "halfDown" | "pageUp" | "pageDown" | "top" | "bottom" };

export function scroll(state: FixedLayoutState, action: FixedLayoutAction): FixedLayoutState {
  return { ...state, viewport: applyViewport(state.viewport, action) };
}

/**
 * Finds every wrapped row containing `query`, and moves to the first match at or after the view.
 *
 * Case-insensitive and literal: someone searching a transcript for `TypeError` is not writing a
 * regular expression, and treating their query as one turns a `(` into an error message.
 */
export function search(state: FixedLayoutState, query: string): FixedLayoutState {
  const trimmed = query.trim();
  if (!trimmed) return { ...state, search: null };
  const needle = trimmed.toLowerCase();
  const matches: number[] = [];
  state.viewport.lines.forEach((line, index) => {
    if (stripStyles(line).toLowerCase().includes(needle)) matches.push(index);
  });
  if (matches.length === 0) return { ...state, search: { query: trimmed, matches: [], index: 0 } };
  const from = matches.findIndex((line) => line >= state.viewport.top);
  const index = from === -1 ? 0 : from;
  return revealMatch({ ...state, search: { query: trimmed, matches, index } });
}

/** Next or previous match, wrapping around — a search that stops at the end is a search you repeat by hand. */
export function stepSearch(state: FixedLayoutState, direction: 1 | -1): FixedLayoutState {
  const current = state.search;
  if (!current || current.matches.length === 0) return state;
  const index = (current.index + direction + current.matches.length) % current.matches.length;
  return revealMatch({ ...state, search: { ...current, index } });
}

/** Puts the current match on screen, a third of the way down, so its context comes with it. */
function revealMatch(state: FixedLayoutState): FixedLayoutState {
  const current = state.search;
  if (!current || current.matches.length === 0) return state;
  const line = current.matches[current.index];
  const offset = Math.floor(state.viewport.height / 3);
  const top = Math.max(0, Math.min(line - offset, maxTop(state.viewport)));
  return { ...state, viewport: { ...state.viewport, top } };
}

/** Style-free text, for matching and for measuring. */
function stripStyles(line: string): string {
  return line.replace(STYLE_PATTERN, "");
}

export type RenderedFrame = {
  /** Exactly the body rows to paint, padded to the body height so the frame never collapses. */
  body: string[];
  /** Right-hand indicator: where in the history this window sits, and whether it is following. */
  position: string;
  following: boolean;
  /** Present only when history has actually been dropped, so a full buffer says nothing. */
  truncated?: string;
};

export function renderFrame(state: FixedLayoutState): RenderedFrame {
  const height = state.viewport.height;
  const shown = visibleLines(state.viewport);
  const body = [...shown, ...Array(Math.max(0, height - shown.length)).fill("")];
  const following = atBottom(state.viewport);
  const percent = Math.round(scrollFraction(state.viewport) * 100);
  const searching = state.search && state.search.matches.length > 0
    ? ` · ${state.search.index + 1}/${state.search.matches.length} for "${state.search.query}"`
    : state.search
      ? ` · no match for "${state.search.query}"`
      : "";
  return {
    body,
    following,
    position: `${following ? "live" : `${percent}%`}${searching}`,
    ...(state.dropped > 0 ? { truncated: `${state.dropped.toLocaleString()} earlier lines dropped from this view` } : {}),
  };
}

/**
 * The whole retained transcript as text, for handing to something that is better at text.
 *
 * This is the other half of the bargain a fixed layout strikes. Owning the viewport means owning
 * scrollback, search and selection — and selection is the one a terminal does better than any TUI
 * ever will, because it is the terminal's own. Rather than reimplement copy, Nova hands the buffer
 * to `$PAGER` or an editor, where selection, search and saving already work the way the user's
 * muscle memory expects.
 *
 * Logical lines, not wrapped ones: the destination will wrap to its own width, and re-wrapping text
 * that was already wrapped for a 60-column window is how a pager shows a ragged left margin.
 */
export function transcriptText(state: FixedLayoutState): string {
  const header = state.dropped > 0
    ? [`[${state.dropped.toLocaleString()} earlier lines are not in this view]`, ""]
    : [];
  return [...header, ...state.buffer].join("\n");
}
