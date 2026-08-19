import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";
import { paginator, SpringAnimator } from "./tui";

/**
 * One set of navigation rules, shared by every menu Nova shows.
 *
 * The palette, the model picker and the settings menu were three lists with three different
 * answers to "what does Home do?" — and a menu you have to re-learn per screen is the opposite of
 * friendly. Movement, selection, jumping and dismissal live here once, so learning them anywhere
 * teaches them everywhere.
 *
 * Two affordances are kept side by side on purpose:
 *
 * - **Arrows** are what most people reach for, and what makes a long list explorable when you do
 *   not already know what is in it.
 * - **Numbers** stay live because they are the accessible path. A screen reader announces "3.
 *   Anthropic API key" perfectly well, while a moving highlight is exactly the kind of state it
 *   reports badly. The numbered menu was deliberate before arrows existed; adding arrows must not
 *   quietly remove it.
 *
 * Typing letters filters. That is what makes a 39-country list usable without paging through it,
 * and it never collides with the number shortcut because nothing here is labelled with a digit.
 */

export type ChooserItem<T> = {
  value: T;
  label: string;
  /** Shown after the label, dimmed — the "what does this mean" column. */
  description?: string;
  /** Shown right of the label — a current value, a price, a status. */
  hint?: string;
  /** Group heading rendered above this item; set it on the first item of each group. */
  header?: string;
  /** Excluded from filtering and always shown, for rows like "everything else" or "done". */
  pinned?: boolean;
};

export type ChooserState = {
  selected: number;
  query: string;
  /**
   * One line of feedback under the list — "added Anthropic key", "nothing to remove".
   *
   * Transient by nature and so not cleared on a timer here: a pure state machine has no clock, and a
   * status that expired on its own would need one. It survives until the next keystroke replaces or
   * clears it, which is the same lifetime a person reading it actually has.
   */
  status?: string;
  /** Which parts of the frame are drawn. Undefined means all of them, which is what every caller wants. */
  chrome?: ChooserChrome;
};

/**
 * Which furniture the list shows — Bubbles' `SetShowTitle`/`SetShowStatusBar`/`SetShowPagination`/
 * `SetShowHelp`, as one record instead of four setters.
 *
 * It is a record because the reason to turn any of it off is the same reason: the list is sharing a
 * screen with something else and needs its rows back. A caller in that position wants to say so once,
 * not call four methods and keep them in step.
 */
export type ChooserChrome = {
  title?: boolean;
  status?: boolean;
  pagination?: boolean;
  help?: boolean;
};

const ALL_CHROME: Required<ChooserChrome> = { title: true, status: true, pagination: true, help: true };

/** What the frame draws, with anything the caller left unsaid defaulting to shown. */
export function chromeOf(chrome: ChooserChrome | undefined): Required<ChooserChrome> {
  return { ...ALL_CHROME, ...chrome };
}

export const INITIAL_CHOOSER_STATE: ChooserState = { selected: 0, query: "" };

/**
 * Items matching the query, best first. Pinned items survive filtering, at the end.
 *
 * Ranked rather than merely filtered, because a plain substring match puts the wrong row under the
 * cursor often enough to be dangerous: typing `rwa` matches "No**rwa**y" as readily as "Rwanda",
 * and in list order Norway comes first — so the obvious query for Rwanda, followed by the obvious
 * Enter, silently selects a different country. Ranking a label that *starts* with the query above
 * one that merely contains it makes the highlighted row the one the user was typing toward.
 */
export function filterItems<T>(items: readonly ChooserItem<T>[], query: string): ChooserItem<T>[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...items];

  const rank = (item: ChooserItem<T>): number => {
    const label = item.label.toLowerCase();
    if (label.startsWith(needle)) return 0;
    // A match starting any word: "united k" should find "United Kingdom", and "kingdom" too.
    if (new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(label)) return 1;
    if (label.includes(needle)) return 2;
    return item.description?.toLowerCase().includes(needle) ? 3 : 4;
  };

  return items
    .map((item, index) => ({ item, index, tier: item.pinned ? 5 : rank(item) }))
    .filter((entry) => entry.tier < 4 || entry.item.pinned)
    // Stable within a tier: the caller's order is deliberate, and reshuffling equally-good matches
    // between keystrokes makes the highlighted row jump under the user's fingers.
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map((entry) => entry.item);
}

/**
 * First visible row for a given selection.
 *
 * Shared by the renderer and the key handler on purpose: they used to compute it separately, so a
 * digit meant the Nth row *of the list* while the screen showed the Nth row *of the window*. Past
 * the first screenful they disagreed, and pressing `3` moved the cursor somewhere invisible.
 */
export function windowStart(selected: number, total: number, height: number): number {
  const rows = Math.max(1, Math.floor(height));
  const count = Math.max(0, Math.floor(total));
  if (count <= rows) return 0;
  const cursor = Math.max(0, Math.min(Math.floor(selected), count - 1));
  return Math.max(0, Math.min(cursor - Math.floor(rows / 2), count - rows));
}

/** A renderer must respect the real terminal, including unusually narrow embedded terminals. */
export function terminalColumns(width: number | undefined, fallback = 80): number {
  const value = width ?? fallback;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
}

export type ChooserStep = {
  state: ChooserState;
  /** Set once the interaction is over: the chosen index into the *filtered* list, or none. */
  done?: { index?: number };
};

/**
 * Advances a chooser one keystroke.
 *
 * Pure, so the whole interaction is testable without a terminal — the runner below does nothing
 * but turn real keypresses into these calls and paint what comes back.
 */
export function advanceChooser<T>(state: ChooserState, items: readonly ChooserItem<T>[], input: { str?: string; key: KeypressEvent }, options: { filter?: boolean; page?: number; height?: number } = {}): ChooserStep {
  const name = input.key.name;
  // A status line describes what the *last* keystroke did, so the next one retires it. Leaving it up
  // is how "added Anthropic key" ends up sitting under a list the user has since navigated away from.
  if (state.status !== undefined) return advanceChooser({ ...state, status: undefined }, items, input, options);
  const visible = filterItems(items, state.query);
  const last = Math.max(0, visible.length - 1);
  const page = options.page ?? 8;
  const clamp = (index: number) => Math.max(0, Math.min(last, index));

  // Escape closes the *inner* thing first: a typed filter is undone before the menu is abandoned,
  // which is what every editor has trained. Ctrl-C always leaves outright.
  // `keep` is what stops a transition quietly resetting the frame: several branches below used to
  // return a fresh `{ selected, query }` literal, which would now drop the caller's chrome and leave
  // a list that had been asked to hide its help suddenly showing it again after one backspace.
  const keep = state.chrome === undefined ? {} : { chrome: state.chrome };
  if (name === "escape" && options.filter && state.query !== "") return { state: { selected: 0, query: "", ...keep } };
  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) return { state, done: {} };
  if (name === "return" || name === "enter") {
    // Clamped, not trusted. A selection left over from a longer list resolves to `undefined` in the
    // runner, and an Enter that quietly cancels is indistinguishable from a broken menu.
    return { state, done: visible.length > 0 ? { index: clamp(state.selected) } : {} };
  }

  // Clamped rather than wrapped. Wrapping is a nice trick on a list you can see all of and a
  // disorienting one on a list you cannot — the cursor appears to teleport to the far end.
  if (name === "up" || (input.key.ctrl && name === "p")) return { state: { ...state, selected: clamp(state.selected - 1) } };
  if (name === "down" || (input.key.ctrl && name === "n")) return { state: { ...state, selected: clamp(state.selected + 1) } };
  if (name === "pageup") return { state: { ...state, selected: clamp(state.selected - page) } };
  if (name === "pagedown") return { state: { ...state, selected: clamp(state.selected + page) } };
  if (name === "home") return { state: { ...state, selected: 0 } };
  if (name === "end") return { state: { ...state, selected: last } };

  /**
   * A digit jumps to the row the renderer numbered — but only where a digit cannot be text.
   *
   * In a filterable list a digit is a character: "gpt-5.6" and "claude-4-5" are unfindable if `5`
   * moves the cursor instead of narrowing the list, and the cursor jumping mid-word is exactly the
   * "the menu selects the wrong thing" complaint. Numbers stay the accessible path in every menu
   * that does not filter, and remain available in a filtering one until the query starts.
   */
  const digitsJump = !options.filter || state.query === "";
  if (digitsJump && input.str && /^[1-9]$/.test(input.str) && !input.key.ctrl && !input.key.meta) {
    // Relative to the window the renderer drew, so the number pressed is the number on screen —
    // and only those numbers: a `9` must not teleport past a four-row window that never showed `9.`.
    const height = options.height ?? 10;
    const start = windowStart(state.selected, visible.length, height);
    const shown = Math.min(height, visible.length - start);
    const digit = Number(input.str);
    if (digit > shown) return { state };
    return { state: { ...state, selected: start + digit - 1 } };
  }

  if (options.filter) {
    if (name === "backspace") return { state: { selected: 0, query: state.query.slice(0, -1), ...keep } };
    if (input.key.ctrl && name === "u") return { state: { selected: 0, query: "", ...keep } };
    const char = input.str;
    // Printable characters only. An unhandled escape sequence otherwise arrives as raw bytes and
    // silently poisons the query with characters nobody typed.
    if (char && char.length === 1 && char >= " " && !input.key.ctrl && !input.key.meta) {
      return { state: { selected: 0, query: state.query + char, ...keep } };
    }
  }
  return { state };
}

export type ChooserPaint = {
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
};

export type RenderChooserOptions = {
  title?: string;
  /** Terminal columns. Rows are clipped to it; a wrapped row corrupts the repaint. */
  width?: number;
  /** Visible rows before the list scrolls under the selection. */
  height?: number;
  filter?: boolean;
  paint: ChooserPaint;
  /** Replaces the default key legend. */
  legend?: string;
  /** Characters this terminal can draw; the cursor and the legend's arrows come from here. */
  glyphs?: GlyphSet;
  /**
   * A spinner frame to show beside the title while the caller is fetching something.
   *
   * Passed in rather than animated here for the same reason the status message is not cleared here:
   * this function is pure and has no clock. `Spinner` in `tui.ts` owns the timing, and the caller
   * that started the work is the only one that knows when it has finished.
   */
  spinner?: string;
  /**
   * The row the cursor is moving away from, for one transitional frame. Marked with a dim cursor
   * alongside the new selection's bright one — a terminal grid has no cell "between" row 3 and row
   * 4 to sweep a cursor through, so the glide `runChooser` drives is this instead: the outgoing row
   * fading rather than vanishing, for the one frame before it settles to a single marker.
   */
  transitionFrom?: number;
};

export function renderChooser<T>(state: ChooserState, items: readonly ChooserItem<T>[], options: RenderChooserOptions): string {
  const { paint } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  // Clipping marks the cut with the *terminal's* ellipsis. A hardcoded "…" is a character this
  // renderer was explicitly told the terminal cannot draw, and it arrives exactly where the text
  // was already too long to read — so an ASCII terminal lost the end of the row and got a
  // replacement box in place of the sign that said so.
  const clip = (text: string, width: number) => clipTo(text, width, glyphs);
  const height = options.height ?? 10;
  // Rows are clipped, never wrapped. A wrapped row costs the menu a line it did not reserve, which
  // is how a repaint leaves a stripe of the previous frame behind and why a long description used
  // to smear the list on a narrow terminal.
  const width = terminalColumns(options.width);
  const visible = filterItems(items, state.query);
  const lines: string[] = [];

  // "No match" is about the options, not the rows. A pinned escape hatch survives every filter, so
  // counting visible rows would call a query that matched nothing a success and leave the user
  // staring at a lone "Clear this setting" with no idea their search failed.
  const matched = visible.some((item) => !item.pinned);
  const chrome = chromeOf(state.chrome);
  if (options.title && chrome.title) {
    // The spinner sits with the title because that is where a reader is already looking for "what is
    // this list", and a list still loading is answering exactly that question.
    lines.push(paint.cyan(clip(`  ${options.spinner ? `${options.spinner} ` : ""}${options.title}`, width)));
  }
  if (options.filter && state.query) lines.push(paint.dim(clip(`  filter: ${state.query}${matched ? "" : "   (no match)"}`, width)));
  else if (!matched) lines.push(paint.dim(clip("  (no match)", width)));

  // Keep the selection on screen, or the arrow keys look like they have stopped working. The same
  // maths the key handler uses, so a number on screen and a number pressed mean the same row.
  const start = windowStart(state.selected, visible.length, height);
  const window = visible.slice(start, start + height);
  const labelWidth = Math.max(0, ...window.map((item) => visibleWidth(item.label)));

  let lastHeader: string | undefined;
  for (const [offset, item] of window.entries()) {
    const index = start + offset;
    if (item.header && item.header !== lastHeader) lines.push(paint.cyan(clip(`  ${item.header}`, width)));
    lastHeader = item.header ?? lastHeader;
    const active = index === state.selected;
    const fadingOut = !active && index === options.transitionFrom;
    // Numbered by position *in the window*: the row labelled 3 is the third row you can see, which
    // is the only reading of "press 3" that survives a list longer than the screen.
    const number = offset < 9 ? `${offset + 1}.` : "  ";
    // The cursor, the number and two spaces are fixed furniture; everything after them shares what
    // the terminal has left. The label is clipped first and the tail takes the remainder, so a long
    // label cannot push a row past the edge and a long description cannot hide the label.
    const furniture = visibleWidth(`  ${active ? ">" : " "} ${number} `) + 2;
    if (width < furniture) {
      lines.push(active ? paint.green(clip(`${glyphs.prompt}${item.label}`, width)) : clip(item.label, width));
      continue;
    }
    const room = Math.max(0, width - furniture);
    const hasTail = Boolean(item.hint || item.description);
    const labelBudget = Math.min(labelWidth, hasTail ? Math.max(1, Math.floor(room * 0.6)) : room);
    const shownLabel = clip(item.label, labelBudget);
    const padded = shownLabel + " ".repeat(Math.max(0, labelBudget - visibleWidth(shownLabel)));
    const marker = active ? paint.green(glyphs.prompt) : fadingOut ? paint.dim(glyphs.prompt) : " ";
    const head = `${marker} ${paint.dim(number)} ${padded}  `;
    const tail = `${item.hint ? ` ${item.hint}` : ""}${item.description ? `  ${item.description}` : ""}`;
    // The tail is cut *before* it is painted: clipping a coloured string mid-sequence bleeds that
    // colour down the rest of the page.
    lines.push(`  ${head}${paint.dim(clip(tail, Math.max(0, room - visibleWidth(padded) - 2)))}`);
  }

  // Only worth naming once the window can't show the whole list at once — a menu that fits has
  // nothing a position would add over just seeing every row.
  const position = visible.length > height && chrome.pagination ? `  ${paginator(state.selected, visible.length)}` : "";
  if (chrome.help) {
    lines.push(paint.dim(clip(`  ${options.legend ?? `${glyphs.arrowUp}${glyphs.arrowDown} move ${glyphs.middot} Enter choose ${glyphs.middot} ${options.filter ? `type to filter ${glyphs.middot} ` : ""}${options.filter ? "Esc clear/cancel" : "Esc cancel"}`}${position}`, width)));
  } else if (position) {
    // A list with its help hidden still has somewhere to be in, and that is the one thing the rows
    // themselves cannot say once they no longer all fit.
    lines.push(paint.dim(clip(position, width)));
  }
  // Last, under everything, because it is about what just happened rather than what is on offer —
  // and green, because every caller of it so far is reporting that something worked.
  if (state.status && chrome.status) lines.push(paint.green(clip(`  ${state.status}`, width)));
  return lines.join("\n");
}

/**
 * Cuts to a visible width without splitting a colour sequence — the rows here are unpainted.
 *
 * Exported because the palette and the model picker are the same menu wearing different clothes,
 * and they each grew their own width arithmetic. Three copies is how two of them end up wrapping
 * on a narrow terminal while the third does not.
 */
export function clipTo(text: string, width: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  // Room is reserved for the mark *as the terminal will draw it*. A unicode ellipsis is one column
  // and an ASCII one is three, so reserving a single column — which was right for as long as the
  // mark was hardcoded — overflows every clipped row by two the moment the ASCII set is in use.
  // Two columns is enough to wrap a row, and a wrapped row is a line the frame did not reserve.
  const mark = visibleWidth(glyphs.ellipsis) < width ? glyphs.ellipsis : "";
  const budget = width - visibleWidth(mark);
  let out = "";
  const segments = typeof Intl.Segmenter === "function"
    ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].map((entry) => entry.segment)
    : [...text];
  for (const segment of segments) {
    if (visibleWidth(out + segment) > budget) break;
    out += segment;
  }
  return `${out}${mark}`;
}

export type RunChooserOptions = RenderChooserOptions & {
  /** Where the cursor starts, as an index into the unfiltered list. */
  initialIndex?: number;
  page?: number;
  /** Re-read before every frame so a live terminal resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
};

/** Drives a chooser over a stream of keypresses, returning the chosen value. */
export async function runChooser<T>(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  items: readonly ChooserItem<T>[],
  paint: (frame: string) => void,
  options: RunChooserOptions,
): Promise<T | undefined> {
  let state: ChooserState = { selected: Math.max(0, Math.min(options.initialIndex ?? 0, Math.max(0, items.length - 1))), query: "" };
  const liveOptions = (): RunChooserOptions => {
    const size = options.getSize?.();
    const height = Math.max(1, Math.min(options.height ?? 10, size?.height ?? Number.POSITIVE_INFINITY));
    return { ...options, width: size?.width ?? options.width, height };
  };
  paint(renderChooser(state, items, liveOptions()));

  // The cursor's glide: a terminal grid has no cell "between" two rows to sweep a marker through,
  // so a single-step move gets one transitional frame — the outgoing row's marker left dim rather
  // than erased outright — before settling to just the new row's. A real `SpringAnimator` decides
  // *when* that settle happens rather than a fixed delay, and is cancelled outright by the next
  // keystroke: a person moving quickly should never feel the glide as added latency, only ever see
  // it on a step slow enough to notice.
  let glide: SpringAnimator | undefined;
  const settleGlide = () => { glide?.stop(); glide = undefined; };

  for await (const input of keys) {
    // `height` is passed so a digit means the row the renderer numbered; without it the two
    // disagree the moment the list is longer than the screen.
    const current = liveOptions();
    const previousSelected = state.selected;
    const step = advanceChooser(state, items, input, {
      filter: options.filter ?? false,
      page: options.page ?? current.height ?? 8,
      ...(current.height === undefined ? {} : { height: current.height }),
    });
    state = step.state;
    if (step.done) {
      settleGlide(); // a chooser that returns must not leave a timer ticking after it
      if (step.done.index === undefined) return undefined;
      return filterItems(items, state.query)[step.done.index]?.value;
    }
    settleGlide();
    const isSingleStep = (input.key.name === "up" || input.key.name === "down") && Math.abs(state.selected - previousSelected) === 1;
    if (!isSingleStep || previousSelected === state.selected) {
      paint(renderChooser(state, items, liveOptions()));
      continue;
    }
    paint(renderChooser(state, items, { ...liveOptions(), transitionFrom: previousSelected }));
    const animator: SpringAnimator = new SpringAnimator(0, (value) => {
      if (value < 0.6) return;
      animator.stop();
      glide = undefined;
      paint(renderChooser(state, items, liveOptions()));
    }, { intervalMs: 30 });
    glide = animator;
    animator.retarget(1);
  }
  settleGlide(); // the keyboard was returned mid-glide (dismissed some other way) — nothing left to finish
  return undefined;
}
