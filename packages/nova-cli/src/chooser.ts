import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import type { KeypressEvent } from "./keybindings";

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

export type ChooserState = { selected: number; query: string };

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
export function advanceChooser<T>(state: ChooserState, items: readonly ChooserItem<T>[], input: { str?: string; key: KeypressEvent }, options: { filter?: boolean; page?: number } = {}): ChooserStep {
  const name = input.key.name;
  const visible = filterItems(items, state.query);
  const last = Math.max(0, visible.length - 1);
  const page = options.page ?? 8;
  const clamp = (index: number) => Math.max(0, Math.min(last, index));

  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) return { state, done: {} };
  if (name === "return" || name === "enter") {
    return { state, done: visible.length > 0 ? { index: state.selected } : {} };
  }

  // Clamped rather than wrapped. Wrapping is a nice trick on a list you can see all of and a
  // disorienting one on a list you cannot — the cursor appears to teleport to the far end.
  if (name === "up" || (input.key.ctrl && name === "p")) return { state: { ...state, selected: clamp(state.selected - 1) } };
  if (name === "down" || (input.key.ctrl && name === "n")) return { state: { ...state, selected: clamp(state.selected + 1) } };
  if (name === "pageup") return { state: { ...state, selected: clamp(state.selected - page) } };
  if (name === "pagedown") return { state: { ...state, selected: clamp(state.selected + page) } };
  if (name === "home") return { state: { ...state, selected: 0 } };
  if (name === "end") return { state: { ...state, selected: last } };

  // A digit jumps, and always means the same row the renderer numbered.
  if (input.str && /^[1-9]$/.test(input.str) && !input.key.ctrl && !input.key.meta) {
    const index = Number(input.str) - 1;
    return index <= last ? { state: { ...state, selected: index } } : { state };
  }

  if (options.filter) {
    if (name === "backspace") return { state: { selected: 0, query: state.query.slice(0, -1) } };
    if (input.key.ctrl && name === "u") return { state: { selected: 0, query: "" } };
    const char = input.str;
    // Printable characters only. An unhandled escape sequence otherwise arrives as raw bytes and
    // silently poisons the query with characters nobody typed.
    if (char && char.length === 1 && char >= " " && !input.key.ctrl && !input.key.meta) {
      return { state: { selected: 0, query: state.query + char } };
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
  /** Visible rows before the list scrolls under the selection. */
  height?: number;
  filter?: boolean;
  paint: ChooserPaint;
  /** Replaces the default key legend. */
  legend?: string;
  /** Characters this terminal can draw; the cursor and the legend's arrows come from here. */
  glyphs?: GlyphSet;
};

export function renderChooser<T>(state: ChooserState, items: readonly ChooserItem<T>[], options: RenderChooserOptions): string {
  const { paint } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const height = options.height ?? 10;
  const visible = filterItems(items, state.query);
  const lines: string[] = [];

  // "No match" is about the options, not the rows. A pinned escape hatch survives every filter, so
  // counting visible rows would call a query that matched nothing a success and leave the user
  // staring at a lone "Clear this setting" with no idea their search failed.
  const matched = visible.some((item) => !item.pinned);
  if (options.title) lines.push(`  ${paint.cyan(options.title)}`);
  if (options.filter && state.query) lines.push(`  ${paint.dim("filter:")} ${state.query}${matched ? "" : paint.dim("   (no match)")}`);
  else if (!matched) lines.push(`  ${paint.dim("(no match)")}`);

  // Keep the selection on screen, or the arrow keys look like they have stopped working.
  const start = Math.max(0, Math.min(state.selected - Math.floor(height / 2), visible.length - height));
  const window = visible.slice(Math.max(0, start), Math.max(0, start) + height);
  const width = Math.max(0, ...window.map((item) => item.label.length));

  let lastHeader: string | undefined;
  for (const [offset, item] of window.entries()) {
    const index = Math.max(0, start) + offset;
    if (item.header && item.header !== lastHeader) lines.push(`  ${paint.cyan(item.header)}`);
    lastHeader = item.header ?? lastHeader;
    const active = index === state.selected;
    const number = index < 9 ? `${index + 1}.` : "  ";
    const row = `${active ? paint.green(glyphs.prompt) : " "} ${paint.dim(number)} ${item.label.padEnd(width + 2)}`;
    const hint = item.hint ? ` ${paint.dim(item.hint)}` : "";
    const description = item.description ? `  ${paint.dim(item.description)}` : "";
    lines.push(`  ${row}${hint}${description}`);
  }

  lines.push(`  ${paint.dim(options.legend ?? `${glyphs.arrowUp}${glyphs.arrowDown} move ${glyphs.middot} Enter choose ${glyphs.middot} ${options.filter ? `type to filter ${glyphs.middot} ` : ""}Esc cancel`)}`);
  return lines.join("\n");
}

export type RunChooserOptions = RenderChooserOptions & {
  /** Where the cursor starts, as an index into the unfiltered list. */
  initialIndex?: number;
  page?: number;
};

/** Drives a chooser over a stream of keypresses, returning the chosen value. */
export async function runChooser<T>(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  items: readonly ChooserItem<T>[],
  paint: (frame: string) => void,
  options: RunChooserOptions,
): Promise<T | undefined> {
  let state: ChooserState = { selected: Math.max(0, Math.min(options.initialIndex ?? 0, Math.max(0, items.length - 1))), query: "" };
  paint(renderChooser(state, items, options));

  for await (const input of keys) {
    const step = advanceChooser(state, items, input, { filter: options.filter ?? false, page: options.page ?? options.height ?? 8 });
    state = step.state;
    if (step.done) {
      if (step.done.index === undefined) return undefined;
      return filterItems(items, state.query)[step.done.index]?.value;
    }
    paint(renderChooser(state, items, options));
  }
  return undefined;
}
