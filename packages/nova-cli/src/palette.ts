import { COMMANDS } from "./commands";
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
export function rankPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  const needle = query.trim().toLowerCase().replace(/^\//, "");
  if (!needle) return [...entries];
  const tier = (entry: PaletteEntry): number => {
    const name = entry.command.replace(/^\//, "").toLowerCase();
    if (name.startsWith(needle)) return 0;
    if (name.includes(needle)) return 1;
    if (entry.description.toLowerCase().includes(needle)) return 2;
    return 3;
  };
  return entries
    .map((entry, index) => ({ entry, index, tier: tier(entry) }))
    .filter((candidate) => candidate.tier < 3)
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
  const queryLine = `  ${glyphs.caret} ${frame.query}${frame.matches.length === 0 ? "   (no match)" : ""}`;
  // Scroll the window with the selection so the highlighted row is always on screen; a palette
  // whose selection moves off the visible list looks like the arrow keys have stopped working.
  const start = Math.max(0, Math.min(frame.selected - Math.floor(rows / 2), frame.matches.length - rows));
  const visible = frame.matches.slice(Math.max(0, start), Math.max(0, start) + rows);
  const width = Math.max(0, ...visible.map((entry) => entry.command.length + (entry.args ? entry.args.length + 1 : 0)));
  const rendered = visible.map((entry, offset) => {
    const active = Math.max(0, start) + offset === frame.selected;
    const head = entry.args ? `${entry.command} ${entry.args}` : entry.command;
    return `  ${active ? glyphs.prompt : " "} ${head.padEnd(width + 2)}${entry.description}${entry.chord ? `  [${entry.chord}]` : ""}`;
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
export function advancePalette(state: PaletteState, entries: readonly PaletteEntry[], input: PaletteKey): {
  state: PaletteState;
  /** Set once the interaction is over: the chosen command, or undefined when dismissed. */
  done?: { command?: string };
} {
  const name = input.key.name;
  const matches = rankPaletteEntries(entries, state.query);

  if (name === "escape" || (input.key.ctrl && (name === "c" || name === "g"))) return { state, done: {} };
  if (name === "return" || name === "enter") {
    const chosen = matches[state.selected];
    return { state, done: { ...(chosen ? { command: chosen.args ? `${chosen.command} ` : chosen.command } : {}) } };
  }
  if (name === "up") return { state: { ...state, selected: Math.max(0, state.selected - 1) } };
  if (name === "down") return { state: { ...state, selected: Math.min(Math.max(0, matches.length - 1), state.selected + 1) } };
  if (name === "backspace") return { state: { query: state.query.slice(0, -1), selected: 0 } };
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
};

export async function runCommandPalette(
  keys: AsyncIterable<PaletteKey>,
  entries: readonly PaletteEntry[],
  paint: (frame: string) => void,
  options: RunPaletteOptions = {},
): Promise<string | undefined> {
  let state: PaletteState = { query: options.initialQuery ?? "", selected: 0 };
  paint(renderPalette({ query: state.query, matches: rankPaletteEntries(entries, state.query), selected: state.selected }, options));

  for await (const input of keys) {
    const step = advancePalette(state, entries, input);
    state = step.state;
    if (step.done) {
      if (step.done.command === undefined) options.onDismiss?.(state.query);
      return step.done.command;
    }
    paint(renderPalette({ query: state.query, matches: rankPaletteEntries(entries, state.query), selected: state.selected }, options));
  }
  return undefined;
}
