import { terminalColumns, windowStart } from "./chooser";
import { borderGlyphsFor, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";
import { padToWidth, paginator, scrollIndicator, scrollPercent, sliceToWidth, type Align } from "./tui";

/**
 * A table you can move around in — Bubbles' `table`, as the thing `tui.ts`'s `table()` deliberately
 * is not.
 *
 * The static renderer already draws aligned columns with a header rule, and for `/providers` that is
 * the whole job: a dozen rows, printed once, read at a glance. It stops being enough the moment the
 * rows outnumber the screen or the interesting one is not the first one. Fifty models, a hundred
 * turns of spend, every background job this project has ever run — those need a cursor, a window
 * that scrolls under it, and a way to ask "which is the expensive one" without reading every row.
 *
 * So this file adds the three things a printed table cannot have, and nothing else:
 *
 * - **A selection**, which is what makes Enter mean something.
 * - **A window**, derived from the selection rather than stored beside it. Bubbles keeps a viewport
 *   offset in the model; here `windowStart` computes it, the same call the chooser and the model
 *   picker make. Two fields that must agree about where the screen is looking are two fields that
 *   eventually don't, and the bug that produces — a cursor on a row the window is not showing — is
 *   exactly the one `chooser.ts` already records having fixed by deriving instead of storing.
 * - **Sorting**, because a column of numbers you cannot order is a column you have to scan. It is
 *   numeric-aware: `$1.20`, `37,274,000` and `4.5s` sort by magnitude, not by the string, since
 *   sorting spend lexicographically puts `$9` above `$10` and quietly answers the question wrong.
 *
 * Everything here is a pure function over `TableState`. Same split as `file-browser.ts` and
 * `editor.ts`: no keys are listened for and nothing is written to a terminal, because the
 * interesting behaviour is the state machine and a state machine that owns a terminal can only be
 * tested by driving a terminal.
 */

export type TableColumn = {
  title: string;
  /**
   * Preferred width in columns. A ceiling, not a floor — a table that insists on its columns is a
   * table that wraps on an 80-column terminal, and a wrapped row costs the frame a line it did not
   * reserve, which is how a repaint leaves a stripe of the previous frame behind.
   */
  width?: number;
  /** Numbers right, text left. Not cosmetic: a left-aligned money column cannot be compared down its own length. */
  align?: Align;
};

export type TableRow = readonly string[];

export type TableSort = { column: number; direction: "asc" | "desc" };

/**
 * Everything a table remembers between keystrokes.
 *
 * `focused` earns its place because a table is not always the only thing on screen: embedded under
 * a prompt or beside a preview it has to be able to hand the keyboard back, and a blurred table
 * still has to show *where* the cursor will resume — so it dims the cursor rather than dropping it.
 */
export type TableState = {
  /** Index into the *sorted* rows, which is the only order the user has seen. */
  selected: number;
  focused: boolean;
  /**
   * Which column the sort key is aimed at, kept separate from the order in force.
   *
   * Two fields rather than one because aiming and sorting are two acts. Left/Right walk the marker
   * along the header while the rows hold still; `s` is what re-orders them. Folding the aim into
   * `sort` makes moving the marker onto a column look like that column is already sorted ascending,
   * so the first `s` there flips straight to descending and the ascending order is unreachable.
   */
  aim?: number;
  sort?: TableSort;
};

export const INITIAL_TABLE_STATE: TableState = { selected: 0, focused: true };

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * A cell's value as a number, when it is really one.
 *
 * Generous about *decoration* and strict about everything else. Thousands separators (including the
 * non-breaking and thin spaces `toLocaleString` emits in some locales), a leading currency symbol
 * and a trailing `%` come off, because those are how this codebase already formats the columns most
 * worth sorting — `formatMoney` and `toLocaleString` produce exactly `$1.20` and `37,274,000`.
 *
 * A trailing *unit* deliberately does not come off. Stripping one is how a sort silently answers the
 * question wrong: `120ms` and `4.5s` reduce to 120 and 4.5, and the slower turn sorts as the faster
 * one. A column that mixes units is a column whose builder should have picked one and named it in
 * the header, so a unit suffix demotes the whole column to string comparison instead — visibly
 * imperfect rather than invisibly false.
 *
 * `undefined` rather than `NaN` for a non-number: a `NaN` comparator does not sort, it shuffles.
 */
export function numericValue(cell: string): number | undefined {
  const bare = cell.replace(ANSI, "").trim()
    .replace(/[,_\u00a0\u2009\u202f]/g, "")
    .replace(/^[^\d+\-.]*/, "")
    .replace(/%$/, "");
  if (bare === "" || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(bare)) return undefined;
  const value = Number(bare);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The rows in the order the sort asks for — a new array; the caller's own order is left intact.
 *
 * Stable within equal keys, so sorting by status does not reshuffle rows that share one. A column
 * counts as numeric only when *every* non-empty cell in it parses, because one stray `—` in a price
 * column should not demote the whole column to string comparison and put `$100` before `$9`.
 */
export function sortRows(rows: readonly TableRow[], sort: TableSort | undefined): TableRow[] {
  if (!sort) return [...rows];
  const cells = rows.map((row) => row[sort.column] ?? "");
  const numbers = cells.map(numericValue);
  const numeric = cells.every((cell, index) => cell.replace(ANSI, "").trim() === "" || numbers[index] !== undefined);
  const direction = sort.direction === "asc" ? 1 : -1;

  return rows
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const compared = numeric
        // An unparseable cell in an otherwise numeric column (a blank, a dash) sorts as the
        // smallest thing there is, so "no price known" collects at one end instead of interleaving.
        ? (numbers[left.index] ?? Number.NEGATIVE_INFINITY) - (numbers[right.index] ?? Number.NEGATIVE_INFINITY)
        : cells[left.index].replace(ANSI, "").localeCompare(cells[right.index].replace(ANSI, ""));
      return compared === 0 ? left.index - right.index : compared * direction;
    })
    .map((entry) => entry.row);
}

/**
 * Column widths for the space actually available.
 *
 * Each column asks for its content (its header or its widest cell, whichever is longer), capped by
 * any width it declared. If the total does not fit, the *widest* column gives up a character at a
 * time until it does — the same "clip the thing that has room to lose, not everything equally"
 * choice `box()` and the static `table()` already make, and the reason a long model id shrinks while
 * the four-character price column beside it does not.
 */
export function columnWidths(
  columns: readonly TableColumn[],
  rows: readonly TableRow[],
  width: number,
  /**
   * The header text as it will actually be drawn, when that is not just the column title — a sorted
   * column carries a marker after its name. Measured rather than assumed, because a column sized to
   * its bare title clips the very marker that says which order you are looking at.
   */
  headers?: readonly string[],
): number[] {
  const widths = columns.map((column, index) => {
    const header = headers?.[index] ?? column.title;
    const content = Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? "")), 1);
    // A declared width caps the *content*; the header still gets to be legible, or a `width: 4`
    // column named "Rank ↓" shows "Ran…" and the table stops explaining itself.
    const cap = column.width === undefined ? content : Math.max(column.width, visibleWidth(header));
    return Math.max(1, Math.min(content, cap));
  });

  // Furniture: a cursor column, then one space of padding either side of every column plus the
  // vertical rules bracketing them — count + 1 rules for count columns.
  const furniture = CURSOR_WIDTH + columns.length * 2 + (columns.length + 1);
  const budget = Math.max(columns.length, width - furniture);
  let guard = widths.reduce((sum, value) => sum + value, 0);
  while (widths.reduce((sum, value) => sum + value, 0) > budget && guard-- > 0) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest] <= 1) break; // nothing left worth shrinking
    widths[widest] -= 1;
  }
  return widths;
}

/** `> ` or `  ` in front of every row, header and rule included, so nothing shifts when the cursor moves. */
const CURSOR_WIDTH = 2;

const RESET = "\x1b[0m";

/**
 * A cell clipped and padded to exactly `width` columns, with the colour codes in it left intact.
 *
 * A cell too wide to fit is truncated with the terminal's own ellipsis glyph rather than simply cut,
 * so a clipped value is visibly clipped and not silently a different value.
 *
 * The walk itself now lives in `sliceToWidth`, which was fixed to copy escape sequences through
 * free — the bug was never this table's alone, since `tui.ts`'s own `table()` documents pre-painted
 * cells and clipped them through the same broken measure. What stays here is the part specific to a
 * cell: the ellipsis, the alignment, and closing a colour the cut left open.
 */
export function fitCell(text: string, width: number, align: Align = "left", glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (width <= 0) return "";
  const size = visibleWidth(text);
  if (size <= width) return padToWidth(text, width, align);

  const cut = sliceToWidth(text, Math.max(0, width - visibleWidth(glyphs.ellipsis)));
  // A cut that lands inside a painted run drops that run's terminator and bleeds the colour down the
  // rest of the page, so the ellipsis is preceded by a reset whenever a sequence was left open.
  const opened = cut.match(/\x1b\[[0-9;]*m/g)?.at(-1);
  const closed = opened === undefined || opened === RESET;
  return padToWidth(`${cut}${closed ? "" : RESET}${glyphs.ellipsis}`, width, align);
}

export type TableStep = {
  state: TableState;
  /** Set once the interaction is over: the chosen index into the *sorted* rows, or none. */
  done?: { index?: number };
};

export type AdvanceTableOptions = {
  /** Visible body rows. Drives paging and the window a digit is numbered against. */
  height?: number;
  columns?: number;
};

/**
 * Advances a table one keystroke.
 *
 * The movement vocabulary is the chooser's on purpose — arrows, `Ctrl+P`/`Ctrl+N`, page keys, Home,
 * End, digits, Escape to leave. A table is a menu with more columns, and learning one set of
 * navigation rules should teach every surface Nova has; `chooser.ts` makes that argument at length
 * and it does not stop being true when the rows gain a second field.
 *
 * What is new is only what columns make possible: `s` sorts, and Left/Right choose which column `s`
 * is talking about.
 */
export function advanceTable(
  state: TableState,
  rows: readonly TableRow[],
  input: { str?: string; key: KeypressEvent },
  options: AdvanceTableOptions = {},
): TableStep {
  const name = input.key.name;
  const last = Math.max(0, rows.length - 1);
  const height = Math.max(1, options.height ?? 10);
  const columnCount = Math.max(1, options.columns ?? 1);
  const clamp = (index: number) => Math.max(0, Math.min(last, index));

  // Ctrl+C leaves from anywhere, focused or not: a blurred table must not be able to trap the
  // keyboard somewhere the usual escape hatch has stopped working.
  if (input.key.ctrl && (name === "c" || name === "g")) return { state, done: {} };
  // Tab, not Escape, hands the keyboard over. Escape leaving outright is what every other Nova
  // surface has trained, and a table that instead swallowed it into a focus toggle would be the one
  // screen where the reflex to back out does nothing visible.
  if (name === "tab") return { state: { ...state, focused: !state.focused } };
  if (!state.focused) return { state };

  if (name === "escape" || input.str === "q") return { state, done: {} };
  if (name === "return" || name === "enter") {
    // Clamped, not trusted: a selection left over from a longer set of rows would otherwise resolve
    // to nothing, and an Enter that quietly cancels is indistinguishable from a broken table.
    return { state, done: rows.length > 0 ? { index: clamp(state.selected) } : {} };
  }

  // Clamped rather than wrapped, as everywhere else here: wrapping past the end of a list you
  // cannot see all of reads as the cursor having teleported.
  if (name === "up" || (input.key.ctrl && name === "p") || input.str === "k") return { state: { ...state, selected: clamp(state.selected - 1) } };
  if (name === "down" || (input.key.ctrl && name === "n") || input.str === "j") return { state: { ...state, selected: clamp(state.selected + 1) } };
  if (name === "pageup") return { state: { ...state, selected: clamp(state.selected - height) } };
  if (name === "pagedown") return { state: { ...state, selected: clamp(state.selected + height) } };
  if (name === "home" || input.str === "g") return { state: { ...state, selected: 0 } };
  if (name === "end" || input.str === "G") return { state: { ...state, selected: last } };

  /**
   * Sorting, as two keys rather than one.
   *
   * Left/Right move which column the sort marker sits over, and `s` cycles that column through
   * ascending, descending and unsorted. Splitting it that way keeps the *current* order visible
   * while you aim: pressing Right to reach the price column would otherwise re-sort the table three
   * times on the way there, and a cursor that lands on a different row than the one you were
   * looking at is how a table loses your place.
   */
  if (name === "left" || name === "right") {
    const step = name === "right" ? 1 : -1;
    const from = state.aim ?? state.sort?.column ?? (step > 0 ? -1 : columnCount);
    // Clamped at both ends rather than wrapping: a marker that leaps from the last column back to
    // the first reads as having been lost, not moved.
    return { state: { ...state, aim: Math.max(0, Math.min(columnCount - 1, from + step)) } };
  }
  if (input.str === "s" && !input.key.ctrl && !input.key.meta) {
    const column = state.aim ?? state.sort?.column ?? 0;
    // Ascending first on a column that was not the sorted one, then descending, then back to the
    // caller's own order — which is a real answer and not a missing one: the order `/jobs` and
    // `/cost` hand their rows over in is chronological, and getting back to it should not mean
    // guessing which column reproduces it.
    const next: TableSort | undefined = state.sort === undefined || state.sort.column !== column
      ? { column, direction: "asc" }
      : state.sort.direction === "asc" ? { column, direction: "desc" } : undefined;
    // Back to the top, because the row under the cursor is about to be a different row: holding the
    // index across a re-sort keeps the highlight in place and moves the data out from under it,
    // which reads as the selection having jumped on its own.
    return next
      ? { state: { ...state, selected: 0, aim: column, sort: next } }
      : { state: { selected: 0, focused: state.focused, aim: column } };
  }

  // A digit jumps to the row the renderer numbered — relative to the window on screen, so `3` means
  // the third row you can see. Kept for the same reason `chooser.ts` keeps it: a moving highlight is
  // the state a screen reader reports worst, and a numbered row is the one it reports perfectly.
  if (input.str && /^[1-9]$/.test(input.str) && !input.key.ctrl && !input.key.meta) {
    const start = windowStart(state.selected, rows.length, height);
    const shown = Math.min(height, rows.length - start);
    const digit = Number(input.str);
    if (digit > shown) return { state };
    return { state: { ...state, selected: start + digit - 1 } };
  }
  return { state };
}

export type TablePaint = {
  dim(text: string): string;
  cyan(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  /** Optional so the four-colour paint objects the chooser and the picker already pass work unchanged. */
  bold?(text: string): string;
};

export type RenderTableOptions = {
  paint: TablePaint;
  /** Terminal columns. Rows are clipped to it; a wrapped row corrupts the repaint. */
  width?: number;
  /** Visible body rows before the table scrolls under the selection. */
  height?: number;
  glyphs?: GlyphSet;
  borderStyle?: "round" | "single" | "double" | "none";
  title?: string;
  /** Replaces the default key legend. An empty string drops the legend entirely, for a printed table. */
  legend?: string;
  /** One transient line under the legend: "sorted by cost", "started job 4f2a". */
  status?: string;
  /** Numbers each visible row, matching what a digit keypress jumps to. Off for a printed table. */
  numbered?: boolean;
  /** Pads the body with blank rows to `height`, for a frame that repaints in place. */
  fixedHeight?: boolean;
  /**
   * Whether to mark a selected row at all. On by default; off for a table that is being *printed*.
   *
   * A cursor is a promise that something will happen if you press Enter, and printed output has no
   * Enter to press — `/cost` and `/jobs` write their table into the transcript and move on. Drawing a
   * marker there points at a row for no reason and reads as "this one is special".
   */
  cursor?: boolean;
};

/** Which way the marker in a sorted column's header points; empty for every other column. */
export function sortMark(sort: TableSort | undefined, index: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (!sort || sort.column !== index) return "";
  return sort.direction === "asc" ? glyphs.arrowUp : glyphs.arrowDown;
}

/**
 * The whole table as one block of text, ready to write.
 *
 * The rows arrive already painted where a caller wants colour (a red `failed`, a green `current`);
 * `visibleWidth` discounts the escape codes, which is the only reason colouring one column does not
 * throw off every column after it. Each cell is clipped *before* the border and cursor are painted
 * around it — clipping a coloured string mid-sequence bleeds that colour down the rest of the page.
 */
export function renderTable(
  columns: readonly TableColumn[],
  rows: readonly TableRow[],
  state: TableState,
  options: RenderTableOptions,
): string {
  const { paint } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const border = borderGlyphsFor(options.borderStyle ?? "round", glyphs);
  const width = terminalColumns(options.width);
  const height = Math.max(1, options.height ?? 10);
  const sorted = sortRows(rows, state.sort);
  const bold = paint.bold ?? ((text: string) => text);

  // Header text first, widths second: a sorted column's name grows by its marker, and a column sized
  // to the bare title would clip the very mark that says what order the rows are in.
  const titles = columns.map((column, index) => {
    const mark = sortMark(state.sort, index, glyphs);
    return mark ? `${column.title} ${mark}` : column.title;
  });
  const widths = columnWidths(columns, sorted, width, titles);

  const start = windowStart(state.selected, sorted.length, height);
  const window = sorted.slice(start, start + height);

  const cells = (values: readonly string[]): string =>
    widths.map((columnWidth, index) => fitCell(values[index] ?? "", columnWidth, columns[index]?.align ?? "left", glyphs)).join(` ${border.vertical} `);
  const rule = (left: string, mid: string, right: string): string =>
    `${left}${widths.map((columnWidth) => border.horizontal.repeat(columnWidth + 2)).join(mid)}${right}`;
  // The cursor gutter sits outside the frame so the border stays a rectangle: a marker drawn inside
  // the leftmost cell would eat a character of content on exactly the row you are reading.
  const line = (cursor: string, body: string) => {
    const text = `${cursor}${body}`;
    return visibleWidth(text) <= width ? text : fitCell(text, width, "left", glyphs);
  };

  const lines: string[] = [];
  if (options.title) lines.push(line(" ".repeat(CURSOR_WIDTH), paint.cyan(bold(options.title))));

  lines.push(line(" ".repeat(CURSOR_WIDTH), paint.dim(rule(border.topLeft, border.horizontal, border.topRight))));
  const headers = titles.map((title, index) => {
    // Three states, three weights: the sorted column is bright and carries an arrow, the column the
    // sort key is *aimed* at is bright without one, and the rest stay dim. Without the middle one,
    // moving the marker with Left/Right would be invisible until you pressed `s`.
    if (state.sort?.column === index) return paint.cyan(title);
    return state.aim === index ? paint.yellow(title) : paint.dim(title);
  });
  lines.push(line(" ".repeat(CURSOR_WIDTH), `${paint.dim(border.vertical)} ${cells(headers)} ${paint.dim(border.vertical)}`));
  lines.push(line(" ".repeat(CURSOR_WIDTH), paint.dim(rule(border.teeLeft, border.cross, border.teeRight))));

  const showCursor = options.cursor ?? true;
  for (const [offset, row] of window.entries()) {
    const active = showCursor && start + offset === state.selected;
    // A focused table's cursor is bright, a blurred one's is dim rather than absent — hiding it
    // would lose the answer to "where does the keyboard resume", which is the whole point of being
    // able to blur a table instead of closing it.
    const cursor = active
      ? `${state.focused ? paint.green(glyphs.prompt) : paint.dim(glyphs.prompt)} `
      : " ".repeat(CURSOR_WIDTH);
    const numbered = options.numbered && offset < 9 ? `${offset + 1}` : undefined;
    const body = `${paint.dim(border.vertical)} ${cells(
      columns.map((_, index) => {
        const cell = row[index] ?? "";
        // The number replaces the first column's leading character budget rather than adding a
        // column, so a numbered table and a printed one are the same width.
        const withNumber = numbered !== undefined && index === 0 ? `${paint.dim(numbered)} ${cell}` : cell;
        return active && state.focused ? bold(withNumber) : withNumber;
      }),
    )} ${paint.dim(border.vertical)}`;
    lines.push(line(cursor, body));
  }
  // Blank rows keep the frame the height it claimed, for a table that repaints in place: without
  // them a filtered-down table draws its bottom border further up than the frame before it did, and
  // the old border is left stranded on screen. A printed table wants the opposite — no caller wants
  // seven blank rows under three jobs — so it is the interactive surfaces that ask for it.
  if (options.fixedHeight) {
    const blanks = columns.map(() => "");
    for (let filler = window.length; filler < height; filler += 1) {
      lines.push(line(" ".repeat(CURSOR_WIDTH), `${paint.dim(border.vertical)} ${cells(blanks)} ${paint.dim(border.vertical)}`));
    }
  }
  lines.push(line(" ".repeat(CURSOR_WIDTH), paint.dim(rule(border.bottomLeft, border.horizontal, border.bottomRight))));

  if (options.legend !== "") {
    // Only worth naming a position once the window cannot show everything — a table that fits has
    // nothing a "3/9" would add over just seeing every row.
    const position = sorted.length > height
      ? `  ${paginator(state.selected, sorted.length)} ${glyphs.middot} ${scrollIndicator(scrollPercent(start, sorted.length, height))}`
      : "";
    lines.push(line(" ".repeat(CURSOR_WIDTH), paint.dim(`${options.legend ?? tableHelpView(glyphs)}${position}`)));
  }
  if (options.status) lines.push(line(" ".repeat(CURSOR_WIDTH), paint.green(options.status)));
  return lines.join("\n");
}

/**
 * The default key legend — Bubbles' `HelpView`, as one line.
 *
 * Printed rather than inferred from a keymap because there is only one keymap: every key it names is
 * handled unconditionally in `advanceTable`, so a legend that drifts from the behaviour is a change
 * to this file that forgot the line below it, which a test can catch.
 */
export function tableHelpView(glyphs: GlyphSet = UNICODE_GLYPHS): string {
  return `${glyphs.arrowUp}${glyphs.arrowDown} move ${glyphs.middot} ${glyphs.arrowLeft}${glyphs.arrowRight} pick column ${glyphs.middot} s sort ${glyphs.middot} Enter choose ${glyphs.middot} Esc close`;
}

export type RunTableOptions = RenderTableOptions & {
  columns: readonly TableColumn[];
  rows: readonly TableRow[];
  /** Where the cursor starts, as an index into the rows as given. */
  initialIndex?: number;
  /** Re-read before every frame so a live terminal resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
};

/**
 * Drives a table over a stream of keypresses, returning the chosen row.
 *
 * Returns the row itself rather than an index: the index is into the sorted view, which is this
 * file's business and not the caller's — a caller that had to un-sort an index to find its own datum
 * would be reimplementing `sortRows` to do it.
 */
export async function runTable(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  paint: (frame: string) => void,
  options: RunTableOptions,
): Promise<TableRow | undefined> {
  const { columns, rows } = options;
  let state: TableState = { ...INITIAL_TABLE_STATE, selected: Math.max(0, Math.min(options.initialIndex ?? 0, Math.max(0, rows.length - 1))) };
  const liveOptions = (): RenderTableOptions => {
    const size = options.getSize?.();
    // Leave room for the frame's own furniture: title, three rules, legend and status all cost rows
    // the body cannot also have, and a body sized to the whole terminal scrolls its own border away.
    const chrome = 4 + (options.title ? 1 : 0) + (options.legend === "" ? 0 : 1) + (options.status ? 1 : 0);
    const available = size?.height === undefined ? Number.POSITIVE_INFINITY : Math.max(1, size.height - chrome);
    return {
      ...options,
      // A repainting frame keeps its height, or a table that shortens leaves its old bottom border
      // stranded on screen; a caller printing once can still turn it off.
      fixedHeight: options.fixedHeight ?? true,
      width: size?.width ?? options.width,
      height: Math.max(1, Math.min(options.height ?? 10, available)),
    };
  };
  paint(renderTable(columns, rows, state, liveOptions()));

  for await (const input of keys) {
    const current = liveOptions();
    const step = advanceTable(state, rows, input, { height: current.height, columns: columns.length });
    state = step.state;
    if (step.done) {
      if (step.done.index === undefined) return undefined;
      return sortRows(rows, state.sort)[step.done.index];
    }
    paint(renderTable(columns, rows, state, liveOptions()));
  }
  return undefined;
}
