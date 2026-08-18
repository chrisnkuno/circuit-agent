import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";
import {
  advanceTable,
  columnWidths,
  INITIAL_TABLE_STATE,
  numericValue,
  renderTable,
  runTable,
  sortRows,
  tableHelpView,
  type TableColumn,
  type TableRow,
  type TableState,
} from "./table";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const paint = {
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

const COLUMNS: TableColumn[] = [
  { title: "Rank", width: 4, align: "right" },
  { title: "City", width: 14 },
  { title: "Country", width: 12 },
  { title: "Population", width: 12, align: "right" },
];

const ROWS: TableRow[] = [
  ["1", "Tokyo", "Japan", "37,274,000"],
  ["2", "Delhi", "India", "32,065,760"],
  ["3", "Shanghai", "China", "28,516,904"],
  ["4", "Dhaka", "Bangladesh", "22,478,116"],
  ["5", "São Paulo", "Brazil", "22,429,800"],
  ["6", "Mexico City", "Mexico", "22,085,140"],
  ["7", "Cairo", "Egypt", "21,750,020"],
];

const key = (name: string, extra: Partial<KeypressEvent> = {}): { str?: string; key: KeypressEvent } =>
  ({ key: { name, ...extra } as KeypressEvent });
const typed = (str: string): { str?: string; key: KeypressEvent } => ({ str, key: { name: str } as KeypressEvent });

describe("numericValue", () => {
  it("reads through the decoration this codebase's own formatters add", () => {
    expect(numericValue("37,274,000")).toBe(37_274_000);
    expect(numericValue("$1.20")).toBe(1.2);
    expect(numericValue("-0.5")).toBe(-0.5);
    expect(numericValue("42%")).toBe(42);
    expect(numericValue("\x1b[32m17\x1b[0m")).toBe(17);
  });

  it("refuses a value carrying a unit, rather than sorting two units against each other", () => {
    // The bug this closes: stripping the suffix makes 120ms sort above 4.5s, so the slowest turn in
    // a table reads as the fastest. A unit means "this column is text" instead.
    expect(numericValue("120ms")).toBeUndefined();
    expect(numericValue("4.5s")).toBeUndefined();
    expect(numericValue("1.2k")).toBeUndefined();
    expect(numericValue("running")).toBeUndefined();
    expect(numericValue("")).toBeUndefined();
  });
});

describe("sortRows", () => {
  it("orders a numeric column by magnitude, not by its string", () => {
    const rows: TableRow[] = [["a", "$9.00"], ["b", "$10.00"], ["c", "$1.00"]];
    const ascending = sortRows(rows, { column: 1, direction: "asc" }).map((row) => row[0]);
    expect(ascending).toEqual(["c", "a", "b"]);
    expect(sortRows(rows, { column: 1, direction: "desc" }).map((row) => row[0])).toEqual(["b", "a", "c"]);
  });

  it("leaves the caller's array untouched and returns a new one", () => {
    const rows: TableRow[] = [["b"], ["a"]];
    sortRows(rows, { column: 0, direction: "asc" });
    expect(rows.map((row) => row[0])).toEqual(["b", "a"]);
  });

  it("keeps rows that share a key in the caller's order", () => {
    const rows: TableRow[] = [["x", "done"], ["y", "done"], ["z", "done"]];
    expect(sortRows(rows, { column: 1, direction: "asc" }).map((row) => row[0])).toEqual(["x", "y", "z"]);
    expect(sortRows(rows, { column: 1, direction: "desc" }).map((row) => row[0])).toEqual(["x", "y", "z"]);
  });

  it("collects unpriced rows at one end rather than interleaving them", () => {
    // One blank in a price column must not demote the column to string comparison, or $100 lands
    // above $9 for every other row.
    const rows: TableRow[] = [["a", "$100.00"], ["b", ""], ["c", "$9.00"]];
    expect(sortRows(rows, { column: 1, direction: "asc" }).map((row) => row[0])).toEqual(["b", "c", "a"]);
  });

  it("falls back to text comparison when the column really is text", () => {
    const rows: TableRow[] = [["gamma"], ["alpha"], ["beta"]];
    expect(sortRows(rows, { column: 0, direction: "asc" }).map((row) => row[0])).toEqual(["alpha", "beta", "gamma"]);
  });

  it("sorts by what is on screen, ignoring the colour codes around it", () => {
    const rows: TableRow[] = [["a", "\x1b[31mfailed\x1b[0m"], ["b", "\x1b[32mdone\x1b[0m"]];
    expect(sortRows(rows, { column: 1, direction: "asc" }).map((row) => row[0])).toEqual(["b", "a"]);
  });
});

describe("columnWidths", () => {
  it("gives a column its content, capped by the width it asked for", () => {
    const widths = columnWidths([{ title: "id", width: 4 }, { title: "objective" }], [["abcdefgh", "hi"]], 80);
    expect(widths[0]).toBe(4);
    expect(widths[1]).toBe(visibleWidth("objective"));
  });

  it("shrinks the widest column first, so a narrow terminal costs the long text and not the numbers", () => {
    const columns: TableColumn[] = [{ title: "model" }, { title: "price" }];
    const rows: TableRow[] = [["claude-opus-5-with-a-very-long-identifier", "$1.20"]];
    const wide = columnWidths(columns, rows, 200);
    const narrow = columnWidths(columns, rows, 40);
    expect(narrow[0]).toBeLessThan(wide[0]);
    expect(narrow[1]).toBe(wide[1]);
  });

  it("never asks for more than the terminal has, however many columns there are", () => {
    for (const width of [20, 40, 80, 120]) {
      const widths = columnWidths(COLUMNS, ROWS, width);
      const furniture = 2 + COLUMNS.length * 2 + (COLUMNS.length + 1);
      expect(widths.reduce((sum, value) => sum + value, 0) + furniture).toBeLessThanOrEqual(Math.max(width, furniture + COLUMNS.length));
    }
  });
});

describe("renderTable", () => {
  const render = (state: TableState, options: Partial<Parameters<typeof renderTable>[3]> = {}) =>
    renderTable(COLUMNS, ROWS, state, { paint, width: 80, height: 4, ...options }).split("\n");

  it("never draws a row wider than the terminal, at any width", () => {
    for (const width of [20, 32, 48, 80, 120]) {
      for (const line of render(INITIAL_TABLE_STATE, { width })) {
        expect(visibleWidth(plain(line)), `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps every body row the same width, so the frame is a rectangle", () => {
    const lines = render(INITIAL_TABLE_STATE).map((line) => visibleWidth(plain(line)));
    // Header rule, header, separator, four body rows, bottom rule — the legend is allowed to differ.
    const frame = lines.slice(0, -1);
    expect(new Set(frame).size).toBe(1);
  });

  it("shows the selection with a cursor, and keeps the cursor on screen as it moves down", () => {
    const first = render({ ...INITIAL_TABLE_STATE, selected: 0 });
    expect(plain(first[3]).startsWith(UNICODE_GLYPHS.prompt)).toBe(true);
    // Past the window, the marked row is still visible: the window scrolls under the selection.
    const late = render({ ...INITIAL_TABLE_STATE, selected: 6 }).map(plain);
    const marked = late.filter((line) => line.startsWith(UNICODE_GLYPHS.prompt));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("Cairo");
  });

  it("dims the cursor rather than dropping it when the table is blurred", () => {
    const focused = render({ ...INITIAL_TABLE_STATE, focused: true });
    const blurred = render({ ...INITIAL_TABLE_STATE, focused: false });
    // Still says where the keyboard will resume...
    expect(plain(blurred[3]).startsWith(UNICODE_GLYPHS.prompt)).toBe(true);
    // ...but not in the focused colour.
    expect(blurred[3]).not.toBe(focused[3]);
    expect(blurred[3]).not.toContain("\x1b[32m");
  });

  it("marks which column is sorted, and which way, without clipping the mark off", () => {
    const ascending = render({ ...INITIAL_TABLE_STATE, sort: { column: 3, direction: "asc" } }).map(plain);
    expect(ascending[1]).toContain(`Population ${UNICODE_GLYPHS.arrowUp}`);
    const descending = render({ ...INITIAL_TABLE_STATE, sort: { column: 3, direction: "desc" } }).map(plain);
    expect(descending[1]).toContain(`Population ${UNICODE_GLYPHS.arrowDown}`);
    // Even where the column declared a width too small for its own name plus a marker.
    const narrowColumn = renderTable([{ title: "Rank", width: 2 }], [["1"]], { ...INITIAL_TABLE_STATE, sort: { column: 0, direction: "asc" } }, { paint, width: 40 });
    expect(plain(narrowColumn)).toContain(`Rank ${UNICODE_GLYPHS.arrowUp}`);
  });

  it("shows where the sort key is aimed before it is pressed", () => {
    const aimed = render({ ...INITIAL_TABLE_STATE, aim: 2 });
    // Highlighted, but with no arrow: the rows are still in the caller's order.
    expect(aimed[1]).toContain("\x1b[33mCountry");
    expect(plain(aimed[1])).not.toContain(UNICODE_GLYPHS.arrowUp);
  });

  it("keeps a painted cell's content, rather than spending its width on escape characters", () => {
    // The bug this closes: `padToWidth` measures a lone \x1b as one column, so a coloured cell was
    // clipped by however many bytes of colour code it carried — `Rank` in a four-wide column
    // rendered as nothing at all.
    const painted: TableRow[] = [["\x1b[31m37,274,000\x1b[0m"]];
    const frame = plain(renderTable([{ title: "Population", width: 12, align: "right" }], painted, INITIAL_TABLE_STATE, { paint, width: 40 }));
    expect(frame).toContain("37,274,000");
    expect(frame).toContain("Population");
  });

  it("closes a colour it had to cut, so it cannot bleed down the page", () => {
    const painted: TableRow[] = [["\x1b[31mBangladesh and more\x1b[0m"]];
    const frame = renderTable([{ title: "Country", width: 6 }], painted, INITIAL_TABLE_STATE, { paint, width: 40, legend: "" });
    const cut = frame.split("\n").find((row) => row.includes("Bang")) ?? "";
    expect(cut).toContain("\x1b[31m");
    // Every opened colour is terminated before the row's own border is drawn.
    expect(cut.lastIndexOf("\x1b[0m")).toBeGreaterThan(cut.lastIndexOf("\x1b[31m"));
  });

  it("draws the rows in the sorted order, not the caller's", () => {
    const lines = render({ ...INITIAL_TABLE_STATE, sort: { column: 2, direction: "asc" } }).map(plain);
    expect(lines[3]).toContain("Bangladesh");
  });

  it("names a position only once the window cannot show everything", () => {
    const scrolling = render(INITIAL_TABLE_STATE, { height: 4 }).map(plain).at(-1) ?? "";
    expect(scrolling).toContain("1/7");
    const fits = render(INITIAL_TABLE_STATE, { height: 20 }).map(plain).at(-1) ?? "";
    expect(fits).not.toContain("/7");
  });

  it("holds its height when asked, so a repaint cannot strand the previous frame's border", () => {
    const tall = renderTable(COLUMNS, ROWS.slice(0, 2), INITIAL_TABLE_STATE, { paint, width: 80, height: 6, fixedHeight: true });
    const short = renderTable(COLUMNS, ROWS.slice(0, 2), INITIAL_TABLE_STATE, { paint, width: 80, height: 6 });
    expect(tall.split("\n")).toHaveLength(short.split("\n").length + 4);
  });

  it("writes no character an ASCII terminal cannot draw when given the ASCII set", () => {
    const frame = renderTable(COLUMNS, ROWS, { ...INITIAL_TABLE_STATE, sort: { column: 0, direction: "asc" } }, {
      paint, width: 80, height: 4, glyphs: ASCII_GLYPHS, title: "Cities",
    });
    for (const character of plain(frame).replace(/São Paulo/, "")) {
      expect(character.codePointAt(0), `${character} is not ASCII`).toBeLessThan(128);
    }
  });

  it("marks no row at all when the table is being printed rather than driven", () => {
    // A cursor promises that Enter does something, and printed output has no Enter — `/cost` writes
    // its table into the transcript and moves on, so a marker there just points at row one.
    const printed = render(INITIAL_TABLE_STATE, { cursor: false, legend: "" }).map(plain);
    expect(printed.some((line) => line.startsWith(UNICODE_GLYPHS.prompt))).toBe(false);
    // And the gutter is still there, so the frame stays a rectangle with the driven version.
    const driven = render(INITIAL_TABLE_STATE, { legend: "" }).map(plain);
    expect(printed.map((line) => line.length)).toEqual(driven.map((line) => line.length));
  });

  it("drops the legend entirely for a printed table", () => {
    const lines = render(INITIAL_TABLE_STATE, { legend: "" }).map(plain);
    expect(lines.at(-1)).toContain(UNICODE_GLYPHS.boxBottomLeft);
  });
});

describe("advanceTable", () => {
  const state = INITIAL_TABLE_STATE;

  it("moves with arrows, ctrl-p/n and vim keys, clamped at both ends", () => {
    expect(advanceTable(state, ROWS, key("down")).state.selected).toBe(1);
    expect(advanceTable(state, ROWS, key("up")).state.selected).toBe(0);
    expect(advanceTable(state, ROWS, key("n", { ctrl: true })).state.selected).toBe(1);
    expect(advanceTable(state, ROWS, typed("j")).state.selected).toBe(1);
    expect(advanceTable({ ...state, selected: 6 }, ROWS, key("down")).state.selected).toBe(6);
  });

  it("pages and jumps to the ends", () => {
    expect(advanceTable(state, ROWS, key("pagedown"), { height: 4 }).state.selected).toBe(4);
    expect(advanceTable({ ...state, selected: 4 }, ROWS, key("pageup"), { height: 4 }).state.selected).toBe(0);
    expect(advanceTable(state, ROWS, key("end")).state.selected).toBe(6);
    expect(advanceTable({ ...state, selected: 6 }, ROWS, key("home")).state.selected).toBe(0);
  });

  it("jumps to the row the renderer numbered, and ignores a digit past the window", () => {
    expect(advanceTable(state, ROWS, typed("3"), { height: 4 }).state.selected).toBe(2);
    // A `9` must not teleport past a four-row window that never showed a ninth row.
    expect(advanceTable(state, ROWS, typed("9"), { height: 4 }).state.selected).toBe(0);
  });

  it("returns the selected row's index on Enter, and nothing on Escape or q", () => {
    expect(advanceTable({ ...state, selected: 2 }, ROWS, key("return")).done).toEqual({ index: 2 });
    expect(advanceTable(state, ROWS, key("escape")).done).toEqual({});
    expect(advanceTable(state, ROWS, typed("q")).done).toEqual({});
    expect(advanceTable(state, ROWS, key("c", { ctrl: true })).done).toEqual({});
  });

  it("clamps a stale selection rather than resolving Enter to nothing", () => {
    expect(advanceTable({ ...state, selected: 99 }, ROWS, key("return")).done).toEqual({ index: 6 });
    expect(advanceTable(state, [], key("return")).done).toEqual({});
  });

  it("hands the keyboard over on Tab and ignores movement while blurred", () => {
    const blurred = advanceTable(state, ROWS, key("tab")).state;
    expect(blurred.focused).toBe(false);
    expect(advanceTable(blurred, ROWS, key("down")).state.selected).toBe(0);
    expect(advanceTable(blurred, ROWS, key("return")).done).toBeUndefined();
    // Tab comes back, and Ctrl+C still leaves: a blurred table must not trap the keyboard.
    expect(advanceTable(blurred, ROWS, key("tab")).state.focused).toBe(true);
    expect(advanceTable(blurred, ROWS, key("c", { ctrl: true })).done).toEqual({});
  });

  it("aims the sort with left/right without re-ordering anything on the way", () => {
    const right = advanceTable({ ...state, selected: 3 }, ROWS, key("right"), { columns: 4 }).state;
    expect(right.aim).toBe(0);
    // The rows have not moved, and neither has the cursor: aiming is not sorting.
    expect(right.sort).toBeUndefined();
    expect(right.selected).toBe(3);
    expect(advanceTable(right, ROWS, key("right"), { columns: 4 }).state.aim).toBe(1);
    // Clamped at both ends rather than wrapping round.
    expect(advanceTable({ ...state, aim: 3 }, ROWS, key("right"), { columns: 4 }).state.aim).toBe(3);
    expect(advanceTable({ ...state, aim: 0 }, ROWS, key("left"), { columns: 4 }).state.aim).toBe(0);
    expect(advanceTable({ ...state, aim: 1 }, ROWS, key("left"), { columns: 4 }).state.aim).toBe(0);
  });

  it("cycles s through ascending, descending and the caller's own order", () => {
    const first = advanceTable(state, ROWS, typed("s"), { columns: 4 }).state;
    expect(first.sort).toEqual({ column: 0, direction: "asc" });
    const second = advanceTable(first, ROWS, typed("s"), { columns: 4 }).state;
    expect(second.sort).toEqual({ column: 0, direction: "desc" });
    const third = advanceTable(second, ROWS, typed("s"), { columns: 4 }).state;
    expect(third.sort).toBeUndefined();
  });

  it("starts a freshly aimed column ascending, so the first order is not skipped", () => {
    // The bug this closes: with the aim folded into `sort`, moving the marker onto a column looked
    // like that column was already sorted ascending, and the first `s` jumped straight to descending.
    const aimed = advanceTable({ ...state, sort: { column: 0, direction: "desc" }, aim: 3 }, ROWS, typed("s"), { columns: 4 }).state;
    expect(aimed.sort).toEqual({ column: 3, direction: "asc" });
  });

  it("returns to the top when the order changes, so the highlight does not sit on a different row", () => {
    const sorted = advanceTable({ ...state, selected: 5 }, ROWS, typed("s"), { columns: 4 }).state;
    expect(sorted.selected).toBe(0);
  });
});

describe("tableHelpView", () => {
  it("names only keys advanceTable actually handles", () => {
    const legend = tableHelpView(ASCII_GLYPHS);
    for (const [fragment, input] of [["s sort", typed("s")], ["Enter choose", key("return")], ["Esc close", key("escape")]] as const) {
      expect(legend).toContain(fragment);
      const step = advanceTable(INITIAL_TABLE_STATE, ROWS, input, { columns: 4 });
      expect(step.done !== undefined || step.state !== INITIAL_TABLE_STATE).toBe(true);
    }
  });
});

describe("runTable", () => {
  async function* keys(...events: { str?: string; key: KeypressEvent }[]) {
    for (const event of events) yield event;
  }

  it("returns the row under the cursor, in the order the user was looking at", async () => {
    const frames: string[] = [];
    // Right three times aims at Population, `s` sorts it ascending, then down one row.
    const chosen = await runTable(keys(key("right"), key("right"), key("right"), key("right"), typed("s"), key("down"), key("return")), (frame) => frames.push(frame), {
      columns: COLUMNS, rows: ROWS, paint, width: 80, height: 4,
    });
    // Ascending by population, Cairo is the smallest and so the first row; one down is Mexico City.
    // The caller gets its own datum back without having to reproduce the sort to find it.
    expect(chosen?.[1]).toBe("Mexico City");
    expect(frames.length).toBe(7);
  });

  it("returns nothing when the table is dismissed", async () => {
    expect(await runTable(keys(key("escape")), () => undefined, { columns: COLUMNS, rows: ROWS, paint })).toBeUndefined();
    // Or when the keyboard is simply taken away mid-browse.
    expect(await runTable(keys(key("down")), () => undefined, { columns: COLUMNS, rows: ROWS, paint })).toBeUndefined();
  });

  it("fits the body to the live terminal, leaving the frame's own rows out of the count", async () => {
    const frames: string[] = [];
    await runTable(keys(key("escape")), (frame) => frames.push(frame), {
      columns: COLUMNS, rows: ROWS, paint, height: 20, title: "Cities",
      getSize: () => ({ width: 60, height: 10 }),
    });
    expect(frames[0].split("\n").length).toBeLessThanOrEqual(10);
  });
});
