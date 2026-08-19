import { COMMANDS } from "./commands";
import { clipTo, terminalColumns, windowStart } from "./chooser";
import { visibleWidth } from "./markdown";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import type { KeypressEvent } from "./keybindings";

/**
 * The command palette.
 *
 * `/help` lists everything and Tab completes a name you already know. The gap between them is
 * finding a command by what it does — someone who wants to see their changes will type "diff", but
 * someone who wants to undo will type "revert", "back" or "undo" and only one of those is the
 * command's name. Matching descriptions as well as names is the whole point; ranking keeps names
 * first so it never gets in the way of the people who do know what they want.
 */

export type PaletteEntry = {
  command: string;
  args?: string;
  description: string;
  /** The key that also runs it, shown so the palette teaches its own shortcuts. */
  chord?: string;
};

export function paletteEntries(chords: Readonly<Record<string, string>> = {}): PaletteEntry[] {
  return COMMANDS.map((command) => ({
    command: command.name,
    ...(command.args ? { args: command.args } : {}),
    description: command.description,
    ...(chords[command.name] ? { chord: chords[command.name] } : {}),
  }));
}

/**
 * Ranks entries against a query, names before descriptions.
 *
 * The tiers matter more than the scoring: a name match must always outrank a description match, or
 * typing `diff` puts `/undo` (whose description says "revert") above `/diff`, and the palette stops
 * being trustworthy for the case it is used most.
 */
/**
 * Whether `needle`'s characters appear in `haystack` in order, though not necessarily together.
 *
 * The behaviour every command palette worth using has, and the reason typing `wnd` finds `/wander`.
 * It earns its place here specifically because slash commands are short words with no separators —
 * there is nothing to abbreviate *by*, so a user who half-remembers a name has only the letters and
 * their order to go on.
 *
 * Deliberately the lowest tier below. Subsequence matching is generous to the point of matching
 * almost everything on a short query (`/e` alone is a subsequence of most of the catalog), so it has
 * to rank beneath every literal match or it drowns the answers people typed exactly.
 */
export function isSubsequence(needle: string, haystack: string): boolean {
  if (needle === "") return true;
  let index = 0;
  for (const character of haystack) {
    if (character === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

export function rankPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  if (!needle) return [...entries];
  const tier = (entry: PaletteEntry): number => {
    const name = entry.command.replace(/^\//, "").toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (entry.description.toLowerCase().includes(needle)) return 2;
    if (isSubsequence(needle, name)) return 3;
    return 4;
  };
  return entries
    .map((entry, index) => ({ entry, index, tier: tier(entry) }))
    .filter((candidate) => candidate.tier < 4)
    // Stable within a tier: the catalog's own order is deliberate, and reshuffling equally-good
    // matches between keystrokes makes the highlighted row jump under the user's fingers.
    .sort((left, right) => left.tier - right.tier || left.index - right.index)
    .map((candidate) => candidate.entry);
}

export type PaletteState = {
  query: string;
  /** Index into the ranked list. Clamped, never wrapped past the ends by filtering. */
  selected: number;
};

export type PaletteFrame = {
  query: string;
  matches: PaletteEntry[];
  selected: number;
};

export type PaletteOptions = {
  /** Terminal columns. Rows are clipped to it; a wrapped row corrupts the repaint. */
  width?: number;
  rows?: number;
  /**
   * Which way the list grows from the query line.
   *
   * `"up"` is what the suggestion dropdown uses. The query line goes last so it sits where the
   * user's own typing is — at the bottom, against the prompt — and the matches stack above it into
   * the transcript. The list order also inverts, keeping the best match adjacent to the query
   * rather than furthest from it: in an upward list the row nearest the cursor is the one the eye
   * lands on, and that has to be the one Return would take.
   */
  direction?: "up" | "down";
  /** Characters this terminal can draw; the query caret and the cursor come from here. */
  glyphs?: GlyphSet;
};

export function renderPalette(frame: PaletteFrame, options: PaletteOptions = {}): string {
  const rows = options.rows ?? 8;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const columns = terminalColumns(options.width);
  const queryLine = clipTo(`  ${glyphs.caret} ${frame.query}${frame.matches.length === 0 ? "   (no match)" : ""}`, columns);
  // Scroll the window with the selection so the highlighted row is always on screen; a palette
  // whose selection moves off the visible list looks like the arrow keys have stopped working.
  const start = windowStart(frame.selected, frame.matches.length, rows);
  const visible = frame.matches.slice(start, start + rows);
  // Measured in cells, not characters: a command list is ASCII today and the day it is not, padding
  // by `.length` silently misaligns every row below the first wide one.
  const naturalWidth = Math.max(0, ...visible.map((entry) => visibleWidth(entry.args ? `${entry.command} ${entry.args}` : entry.command)));
  const labelBudget = Math.max(0, Math.min(naturalWidth, Math.floor(Math.max(0, columns - 6) * 0.65)));
  const rendered = visible.map((entry, offset) => {
    const active = start + offset === frame.selected;
    const head = entry.args ? `${entry.command} ${entry.args}` : entry.command;
    if (columns < 6) return clipTo(`${active ? glyphs.prompt : ""}${head}`, columns);
    const shownHead = clipTo(head, labelBudget);
    const padded = shownHead + " ".repeat(Math.max(0, labelBudget - visibleWidth(shownHead)));
    const tail = `${entry.description}${entry.chord ? `  [${entry.chord}]` : ""}`;
    // Clipped, never wrapped: a wrapped row costs the repaint a line it did not reserve, which is
    // what leaves a stripe of the previous frame on screen.
    const room = Math.max(0, columns - visibleWidth(`  ${active ? glyphs.prompt : " "} ${padded}  `));
    return `  ${active ? glyphs.prompt : " "} ${padded}  ${clipTo(tail, room)}`;
  });
  return options.direction === "up"
    ? [...rendered.reverse(), queryLine].join("\n")
    : [queryLine, ...rendered].join("\n");
}

export type PaletteKey = { str?: string; key: KeypressEvent };

/**
 * Advances the palette one keystroke.
 *
 * Split from the reading loop so the whole interaction is testable without a terminal: the loop
 * below only turns real keypresses into these calls and paints what comes back.
 */
export function advancePalette(
  state: PaletteState,
  entries: readonly PaletteEntry[],
  input: PaletteKey,
  /** Only `rows` is read, and only to size a page jump — the window height the user can actually see. */
  options: Pick<PaletteOptions, "rows"> & Pick<RunPaletteOptions, "rank"> = {},
): {
  state: PaletteState;
  /** Set once the interaction is over: the chosen command, or undefined when dismissed. */
  done?: { command?: string };
} {
  const name = input.key.name;
  const matches = (options.rank ?? rankPaletteEntries)(entries, state.query);

  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) return { state, done: {} };
  if (name === "return" || name === "enter") {
    // Clamped when used: a selection left over from a longer match list must not cancel Enter.
    const chosen = matches.length > 0 ? matches[Math.max(0, Math.min(state.selected, matches.length - 1))] : undefined;
    return { state, done: { ...(chosen ? { command: chosen.args ? `${chosen.command} ` : chosen.command } : {}) } };
  }
  const last = Math.max(0, matches.length - 1);
  const clamp = (index: number): number => Math.max(0, Math.min(last, index));
  // A page is one row short of the window so the row you were reading stays on screen across the
  // jump — the same overlap `less` and every pager keep, and what makes paging feel continuous
  // rather than teleporting.
  const page = Math.max(1, (options.rows ?? 8) - 1);

  // Ctrl+P/Ctrl+N alongside the arrows: this menu has borrowed the keyboard from readline, so the
  // habit of moving through a list without leaving the home row would otherwise just stop working
  // for the seconds the palette is open.
  if (name === "up" || (input.key.ctrl && name === "p")) return { state: { ...state, selected: clamp(state.selected - 1) } };
  if (name === "down" || (input.key.ctrl && name === "n")) return { state: { ...state, selected: clamp(state.selected + 1) } };
  if (name === "pageup") return { state: { ...state, selected: clamp(state.selected - page) } };
  if (name === "pagedown") return { state: { ...state, selected: clamp(state.selected + page) } };
  if (name === "home") return { state: { ...state, selected: 0 } };
  if (name === "end") return { state: { ...state, selected: last } };
  if (name === "backspace") return { state: { query: state.query.slice(0, -1), selected: 0 } };
  // Word-wise erase, so correcting a mistyped query does not mean holding backspace down.
  if (input.key.ctrl && name === "w") return { state: { query: state.query.replace(/\s*\S+\s*$/, ""), selected: 0 } };
  if (input.key.ctrl && name === "u") return { state: { query: "", selected: 0 } };

  // Only printable characters extend the query. Without this filter an unhandled escape sequence
  // arrives as its raw bytes and silently poisons the search with characters nobody typed.
  const char = input.str;
  if (char && char.length === 1 && char >= " " && char !== "" && !input.key.ctrl && !input.key.meta) {
    return { state: { query: state.query + char, selected: 0 } };
  }
  return { state };
}

/**
 * Drives the palette over a stream of keypresses.
 *
 * Takes the keys as an async iterable rather than reaching for `process.stdin` so the caller owns
 * terminal setup and teardown — and so this is exercised by tests that press real keys at it.
 */
export type RunPaletteOptions = PaletteOptions & {
  /** Seeds the query, so a dropdown opened by typing "/" starts already filtered by it. */
  initialQuery?: string;
  /**
   * The query at the moment the user dismissed without choosing.
   *
   * Reported rather than dropped so a caller can hand the text back to the line editor. A dropdown
   * that opens on "/" would otherwise eat every keystroke of anyone who meant to type an absolute
   * path and pressed Escape — the characters were typed, and Escape means "not this menu", not
   * "discard what I wrote".
   */
  onDismiss?: (query: string) => void;
  /** Re-read before every frame so a live terminal resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
  /**
   * How matches are ordered. Defaults to the literal tiers below.
   *
   * Injected rather than hardcoded so a session can rank by *its own* situation — what it just
   * changed, what it has already run — without this module having to know that a session exists.
   * A ranker that breaks the tiers would break the palette's trustworthiness, which is why the
   * context-aware one in `navigation.ts` only reorders entries that already tie.
   */
  rank?: (entries: readonly PaletteEntry[], query: string) => PaletteEntry[];
};

export async function runCommandPalette(
  keys: AsyncIterable<PaletteKey>,
  entries: readonly PaletteEntry[],
  paint: (frame: string) => void,
  options: RunPaletteOptions = {},
): Promise<string | undefined> {
  let state: PaletteState = { query: options.initialQuery ?? "", selected: 0 };
  const liveOptions = (): RunPaletteOptions => {
    const size = options.getSize?.();
    const rows = Math.max(1, Math.min(options.rows ?? 8, size?.height ?? Number.POSITIVE_INFINITY));
    return { ...options, width: size?.width ?? options.width, rows };
  };
  const rank = options.rank ?? rankPaletteEntries;
  paint(renderPalette({ query: state.query, matches: rank(entries, state.query), selected: state.selected }, liveOptions()));

  for await (const input of keys) {
    const step = advancePalette(state, entries, input, liveOptions());
    state = step.state;
    if (step.done) {
      if (step.done.command === undefined) options.onDismiss?.(state.query);
      return step.done.command;
    }
    paint(renderPalette({ query: state.query, matches: rank(entries, state.query), selected: state.selected }, liveOptions()));
  }
  return undefined;
}
