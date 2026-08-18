import { describe, expect, it } from "vitest";
import { advanceChooser, clipTo, filterItems, renderChooser, runChooser, type ChooserItem } from "./chooser";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";
import { buildPickerRows, renderModelPicker } from "./model-picker";
import { buildModelCatalog } from "./models";
import { renderPalette } from "./palette";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const paint = { dim: (t: string) => t, cyan: (t: string) => t, green: (t: string) => t, yellow: (t: string) => t };
const press = (name: string, key: Partial<KeypressEvent> = {}, str?: string) => ({ ...(str === undefined ? {} : { str }), key: { name, ...key } as KeypressEvent });
const type = (text: string) => [...text].map((char) => press(char, {}, char));

const items: ChooserItem<string>[] = [
  { value: "rw", label: "Rwanda (RW) — RWF" },
  { value: "ke", label: "Kenya (KE) — KES" },
  { value: "us", label: "United States (US) — USD" },
  { value: "gb", label: "United Kingdom (GB) — GBP" },
  { value: "clear", label: "Clear this setting", pinned: true },
];

describe("moving through a chooser", () => {
  it("moves with the arrows and clamps at both ends", () => {
    // Wrapping is a nice trick on a list you can see all of and disorienting on one you cannot.
    expect(advanceChooser({ selected: 0, query: "" }, items, press("up")).state.selected).toBe(0);
    expect(advanceChooser({ selected: 0, query: "" }, items, press("down")).state.selected).toBe(1);
    expect(advanceChooser({ selected: 4, query: "" }, items, press("down")).state.selected).toBe(4);
  });

  it("supports the emacs pair, Home, End and paging", () => {
    expect(advanceChooser({ selected: 0, query: "" }, items, press("n", { ctrl: true })).state.selected).toBe(1);
    expect(advanceChooser({ selected: 3, query: "" }, items, press("p", { ctrl: true })).state.selected).toBe(2);
    expect(advanceChooser({ selected: 3, query: "" }, items, press("home")).state.selected).toBe(0);
    expect(advanceChooser({ selected: 0, query: "" }, items, press("end")).state.selected).toBe(4);
    expect(advanceChooser({ selected: 0, query: "" }, items, press("pagedown"), { page: 2 }).state.selected).toBe(2);
    expect(advanceChooser({ selected: 4, query: "" }, items, press("pageup"), { page: 2 }).state.selected).toBe(2);
  });

  it("keeps the number shortcut alive, because it is the accessible path", () => {
    // A moving highlight is exactly the state a screen reader reports badly; "3." it reads fine.
    expect(advanceChooser({ selected: 0, query: "" }, items, press("3", {}, "3")).state.selected).toBe(2);
  });

  it("ignores a number past the end rather than jumping somewhere arbitrary", () => {
    expect(advanceChooser({ selected: 1, query: "" }, items, press("9", {}, "9")).state.selected).toBe(1);
  });

  it("returns the highlighted index on Return, and nothing on Escape or Ctrl-C", () => {
    expect(advanceChooser({ selected: 2, query: "" }, items, press("return")).done).toEqual({ index: 2 });
    expect(advanceChooser({ selected: 2, query: "" }, items, press("escape")).done).toEqual({});
    expect(advanceChooser({ selected: 2, query: "" }, items, press("c", { ctrl: true })).done).toEqual({});
  });

  it("chooses nothing when Return lands on an empty filtered list", () => {
    const unpinned = items.filter((item) => !item.pinned);
    expect(advanceChooser({ selected: 0, query: "zzz" }, unpinned, press("return")).done).toEqual({});
  });

  it("still picks the pinned row a filter left behind, since that is what is highlighted", () => {
    // Return takes what the user can see. With "zzz" typed, the only row on screen is the escape
    // hatch, so choosing it is the honest reading of Enter — the list is not empty, it is one row.
    expect(advanceChooser({ selected: 0, query: "zzz" }, items, press("return")).done).toEqual({ index: 0 });
  });
});

describe("filtering", () => {
  it("narrows on typed letters and keeps pinned rows reachable", () => {
    // The escape hatch has to survive the filter, or a query matching nothing traps the user.
    const filtered = filterItems(items, "united");
    expect(filtered.map((item) => item.value)).toEqual(["us", "gb", "clear"]);
  });

  it("is case-insensitive and matches inside the label, not just at the front", () => {
    expect(filterItems(items, "RWF").map((item) => item.value)).toEqual(["rw", "clear"]);
    expect(filterItems(items, "kenya").map((item) => item.value)).toEqual(["ke", "clear"]);
  });

  it("ranks a label that starts with the query above one that merely contains it", () => {
    // The bug this pins: `rwa` matches "No(rwa)y" as readily as "Rwanda", and in list order Norway
    // came first — so typing toward Rwanda and pressing Enter selected Norway.
    const withNorway: ChooserItem<string>[] = [
      { value: "no", label: "Norway (NO) — NOK" },
      { value: "rw", label: "Rwanda (RW) — RWF" },
    ];
    expect(filterItems(withNorway, "rwa").map((item) => item.value)).toEqual(["rw", "no"]);
  });

  it("matches at a word boundary, so a second word finds its row", () => {
    expect(filterItems(items, "states").map((item) => item.value)).toEqual(["us", "clear"]);
    expect(filterItems(items, "kingdom").map((item) => item.value)).toEqual(["gb", "clear"]);
  });

  it("keeps pinned rows last, below anything that actually matched", () => {
    expect(filterItems(items, "united").map((item) => item.value)).toEqual(["us", "gb", "clear"]);
  });

  it("does not let a query with regex characters throw", () => {
    // The needle goes into a RegExp for the word-boundary tier; an unescaped "(" would be a crash
    // on a perfectly ordinary keystroke, since every country label contains parentheses.
    expect(() => filterItems(items, "(rw)")).not.toThrow();
    expect(filterItems(items, "(rw)").map((item) => item.value)).toEqual(["rw", "clear"]);
  });

  it("only builds a query when filtering is on, so digits still jump elsewhere", () => {
    expect(advanceChooser({ selected: 0, query: "" }, items, press("k", {}, "k"), { filter: true }).state.query).toBe("k");
    expect(advanceChooser({ selected: 0, query: "" }, items, press("k", {}, "k")).state.query).toBe("");
  });

  it("resets the selection when the query changes, so the cursor is never off the visible list", () => {
    const step = advanceChooser({ selected: 3, query: "" }, items, press("r", {}, "r"), { filter: true });
    expect(step.state.selected).toBe(0);
  });

  it("backspaces and clears the query", () => {
    expect(advanceChooser({ selected: 0, query: "rwa" }, items, press("backspace"), { filter: true }).state.query).toBe("rw");
    expect(advanceChooser({ selected: 0, query: "rwa" }, items, press("u", { ctrl: true }), { filter: true }).state.query).toBe("");
  });

  it("does not let escape sequences leak into the query as raw bytes", () => {
    expect(advanceChooser({ selected: 0, query: "rw" }, items, press("f1", {}, "OP"), { filter: true }).state.query).toBe("rw");
    expect(advanceChooser({ selected: 0, query: "rw" }, items, press("left"), { filter: true }).state.query).toBe("rw");
  });
});

describe("rendering a chooser", () => {
  it("shows the cursor, the numbers and each row's current value", () => {
    const rendered = renderChooser({ selected: 1, query: "" }, items, { title: "Location", paint });
    expect(rendered).toContain("Location");
    expect(rendered).toContain("❯");
    expect(rendered).toContain("1.");
    expect(rendered).toContain("Kenya");
  });

  it("teaches its own keys", () => {
    expect(renderChooser({ selected: 0, query: "" }, items, { paint })).toContain("Esc");
    expect(renderChooser({ selected: 0, query: "" }, items, { paint, filter: true })).toContain("type to filter");
  });

  it("shows the query and says plainly when it matches nothing", () => {
    const rendered = renderChooser({ selected: 0, query: "zzz" }, items, { paint, filter: true });
    expect(rendered).toContain("zzz");
    expect(rendered).toContain("(no match)");
  });

  it("keeps the selection inside the window on a list longer than the screen", () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({ value: index, label: `row ${index}` }));
    expect(renderChooser({ selected: 37, query: "" }, many, { paint, height: 5 })).toContain("row 37");
  });

  it("names where the selection sits once the list overflows the window, and stays silent when it fits", () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({ value: index, label: `row ${index}` }));
    expect(renderChooser({ selected: 37, query: "" }, many, { paint, height: 5 })).toContain("38/40");
    expect(renderChooser({ selected: 0, query: "" }, items, { paint, height: 20 })).not.toMatch(/\d+\/\d+/);
  });

  it("heads a group once rather than above every row in it", () => {
    const grouped: ChooserItem<string>[] = [
      { value: "a", label: "A", header: "Group" },
      { value: "b", label: "B", header: "Group" },
    ];
    expect(renderChooser({ selected: 0, query: "" }, grouped, { paint }).match(/Group/g)).toHaveLength(1);
  });

  it("marks the outgoing row alongside the incoming one during a transition, not just the new selection", () => {
    const withTransition = renderChooser({ selected: 1, query: "" }, items, { paint, transitionFrom: 0 });
    expect((withTransition.match(/❯/g) ?? []).length).toBe(2);
    const withoutTransition = renderChooser({ selected: 1, query: "" }, items, { paint });
    expect((withoutTransition.match(/❯/g) ?? []).length).toBe(1);
  });

  it("never double-marks a row transitioning to itself", () => {
    const rendered = renderChooser({ selected: 1, query: "" }, items, { paint, transitionFrom: 1 });
    expect((rendered.match(/❯/g) ?? []).length).toBe(1);
  });
});

describe("driving a chooser end to end", () => {
  async function* keys(sequence: ReturnType<typeof press>[]) {
    for (const key of sequence) yield key;
  }

  it("filters to one row and chooses it", async () => {
    const chosen = await runChooser(keys([...type("kenya"), press("return")]), items, () => {}, { paint, filter: true });
    expect(chosen).toBe("ke");
  });

  it("resolves the value under the cursor after the list has been filtered", async () => {
    // The index Return reports is into the *filtered* list; resolving it against the full list
    // would silently return a different row than the one highlighted.
    const chosen = await runChooser(keys([...type("united"), press("down"), press("return")]), items, () => {}, { paint, filter: true });
    expect(chosen).toBe("gb");
  });

  it("starts where it is told, so a menu opens on the value already set", async () => {
    const chosen = await runChooser(keys([press("return")]), items, () => {}, { paint, initialIndex: 2 });
    expect(chosen).toBe("us");
  });

  it("returns nothing when dismissed or when the key stream ends", async () => {
    expect(await runChooser(keys([press("escape")]), items, () => {}, { paint })).toBeUndefined();
    expect(await runChooser(keys([press("down")]), items, () => {}, { paint })).toBeUndefined();
  });

  it("repaints once per keystroke, plus the opening frame", async () => {
    const frames: string[] = [];
    await runChooser(keys([press("down"), press("down"), press("return")]), items, (frame) => frames.push(frame), { paint });
    expect(frames).toHaveLength(3);
  });

  /** Like `keys()`, but a plain number in the sequence is a real millisecond pause instead of a key. */
  async function* keysWithDelay(sequence: readonly (ReturnType<typeof press> | number)[]) {
    for (const item of sequence) {
      if (typeof item === "number") { await new Promise((resolve) => setTimeout(resolve, item)); continue; }
      yield item;
    }
  }

  it("glides a single-step move: one extra frame appears if given real time, none if dismissed immediately", async () => {
    // Fast: the next key arrives before the glide's settle tick ever fires, so it never paints —
    // a person moving quickly must not feel the glide as latency.
    const fast: string[] = [];
    await runChooser(keys([press("down"), press("return")]), items, (frame) => fast.push(frame), { paint });
    expect(fast).toHaveLength(2); // opening frame, one transitional frame for the step

    // Slow: real time passes before the next key, so the glide actually reaches its settle frame.
    const slow: string[] = [];
    await runChooser(keysWithDelay([press("down"), 150, press("return")]), items, (frame) => slow.push(frame), { paint });
    expect(slow).toHaveLength(3); // opening, transitional, and the settled repaint
  });

  it("does not glide a jump — Home, End, paging, or a digit — only a single arrow-key step", async () => {
    const frames: string[] = [];
    await runChooser(keysWithDelay([press("end"), 150, press("return")]), items, (frame) => frames.push(frame), { paint });
    // A jump paints once and stays there; the extra 150ms bought a glide nothing to settle.
    expect(frames).toHaveLength(2);
  });
});

describe("the bugs that made menus feel broken", () => {
  const many = Array.from({ length: 40 }, (_unused, index) => ({ value: index, label: `row ${index}` }));

  it("lets a digit be text once a filter is being typed", () => {
    // "gpt-5.6" and "claude-4-5" are unfindable if 5 moves the cursor instead of narrowing the
    // list — and a cursor that jumps mid-word is the whole "it selects the wrong thing" report.
    const typed = advanceChooser({ selected: 0, query: "gpt-" }, many, press("5", {}, "5"), { filter: true });
    expect(typed.state.query).toBe("gpt-5");
    expect(typed.state.selected).toBe(0);
  });

  it("still jumps on a digit before a query is started, and in every non-filtering menu", () => {
    expect(advanceChooser({ selected: 0, query: "" }, many, press("3", {}, "3"), { filter: true }).state.selected).toBe(2);
    expect(advanceChooser({ selected: 0, query: "" }, many, press("3", {}, "3")).state.selected).toBe(2);
  });

  it("numbers the row you can see, not the row in the list", () => {
    // Scrolled past the first screenful, the old code numbered nothing and a digit jumped to an
    // absolute index that was off screen.
    const scrolled = { selected: 30, query: "" };
    const rendered = plain(renderChooser(scrolled, many, { paint, height: 5, width: 60 }));
    expect(rendered).toContain("1. row 28");
    // Pressing 1 lands on exactly the row labelled 1.
    expect(advanceChooser(scrolled, many, press("1", {}, "1"), { height: 5 }).state.selected).toBe(28);
  });

  it("clears the query on Escape before abandoning the menu", () => {
    const cleared = advanceChooser({ selected: 3, query: "rw" }, many, press("escape"), { filter: true });
    expect(cleared.done).toBeUndefined();
    expect(cleared.state).toEqual({ selected: 0, query: "" });
    // A second Escape, with nothing left to clear, leaves.
    expect(advanceChooser({ selected: 0, query: "" }, many, press("escape"), { filter: true }).done).toEqual({});
  });

  it("never returns a selection past the end of the list it is choosing from", () => {
    // Resolved against the filtered list by the runner; an out-of-range index becomes `undefined`,
    // and an Enter that silently cancels is indistinguishable from a broken menu.
    const step = advanceChooser({ selected: 39, query: "row 1" }, many, press("return"));
    const visible = filterItems(many, "row 1");
    expect(step.done?.index).toBeLessThan(visible.length);
  });

  it("clips every row to the terminal instead of wrapping it", () => {
    const wide = [{ value: 1, label: "a".repeat(50), description: "b".repeat(80), hint: "c".repeat(30) }];
    for (const width of [1, 8, 19, 40, 60, 100]) {
      const rendered = plain(renderChooser({ selected: 0, query: "" }, wide, { paint, width }));
      for (const line of rendered.split("\n")) {
        expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("aligns by visible width, so a wide glyph does not push its neighbours out", () => {
    const mixed = [
      { value: 1, label: "日本語", hint: "wide" },
      { value: 2, label: "ascii", hint: "narrow" },
    ];
    const rows = plain(renderChooser({ selected: 0, query: "" }, mixed, { paint, width: 60 })).split("\n");
    // Measured in *cells*, not characters: 日本語 is three characters and six columns, and a test
    // that counts characters would report a misalignment the terminal never shows.
    const hintColumns = rows
      .filter((row) => row.includes("wide") || row.includes("narrow"))
      .map((row) => {
        const hint = row.includes("wide") ? "wide" : "narrow";
        return visibleWidth(row.slice(0, row.indexOf(hint)));
      });
    expect(new Set(hintColumns).size).toBe(1);
  });

  it("tells the reader that Escape clears a filter before it cancels", () => {
    expect(plain(renderChooser({ selected: 0, query: "" }, many, { paint, filter: true }))).toContain("Esc clear/cancel");
    expect(plain(renderChooser({ selected: 0, query: "" }, many, { paint }))).toContain("Esc cancel");
  });

  it("clips the complete filtered status row, including its no-match suffix", () => {
    const rendered = plain(renderChooser({ selected: 0, query: "a-query-that-is-far-too-long" }, items, { paint, filter: true, width: 12 }));
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
  });

  it("does not split a joined emoji while clipping", () => {
    const family = "👨‍👩‍👧‍👦";
    expect(clipTo(`${family} family`, visibleWidth(family) + 1)).toBe(`${family}…`);
  });
});


describe("every menu obeys the same rules", () => {
  /**
   * The palette and the model picker are the same menu wearing different clothes. They each grew
   * their own width arithmetic, which is how two of them wrapped on a narrow terminal while the
   * third did not. These assert the shared invariants against all three at once.
   */
  const rows = Array.from({ length: 30 }, (_unused, index) => ({
    value: index,
    label: `option ${index} with a fairly long label`,
    description: "a description long enough to run past the edge of a narrow terminal",
    hint: "hint",
  }));

  it("never draws a row wider than the terminal", () => {
    const pickerRows = buildPickerRows(buildModelCatalog({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" }, "2026-08-10"));
    const paletteMatches = Array.from({ length: 30 }, (_unused, index) => ({
      command: `/option-${index}-with-a-fairly-long-command`,
      description: "a description long enough to run past the edge of a narrow terminal",
    }));
    for (const width of [1, 8, 19, 30, 40, 80, 120]) {
      const frames = [
        plain(renderChooser({ selected: 15, query: "" }, rows, { paint, width, height: 6 })),
        renderPalette({ query: "q".repeat(40), matches: paletteMatches, selected: 15 }, { width, rows: 6 }),
        renderModelPicker({ rows: pickerRows, selected: Math.min(15, pickerRows.length - 1) }, { paint, width, height: 6, current: { provider: "anthropic", model: "claude-sonnet-5" }, price: () => "$2/$10" }),
      ];
      for (const [index, rendered] of frames.entries()) {
        for (const line of rendered.split("\n")) {
          expect(visibleWidth(line), `menu ${index} width ${width}: ${line}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("always keeps the selection on screen, at either end of the list", () => {
    for (const selected of [0, 7, 15, 29]) {
      const rendered = plain(renderChooser({ selected, query: "" }, rows, { paint, width: 80, height: 6 }));
      expect(rendered, `selected ${selected}`).toContain(`option ${selected} `);
    }
  });

  it("agrees with the key handler about which row is which number", () => {
    for (const selected of [0, 15, 29]) {
      const rendered = plain(renderChooser({ selected, query: "" }, rows, { paint, width: 80, height: 6 }));
      const firstNumbered = rendered.split("\n").find((line) => line.includes("1."))!;
      const jumped = advanceChooser({ selected, query: "" }, rows, press("1", {}, "1"), { height: 6 }).state.selected;
      expect(firstNumbered, `selected ${selected}`).toContain(`option ${jumped} `);
    }
  });

  it("re-reads terminal size before every frame so a live resize cannot leave stale geometry", async () => {
    let size = { width: 80, height: 12 };
    async function* keys() {
      yield press("down");
      size = { width: 18, height: 4 };
      yield press("down");
      yield press("escape");
    }
    const frames: string[] = [];
    await runChooser(keys(), rows, (frame) => frames.push(plain(frame)), {
      paint,
      height: 10,
      getSize: () => size,
    });
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const line of frames.at(-1)!.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(18);
    // A digit past the live window height is ignored — the screen never showed that number.
    expect(advanceChooser({ selected: 0, query: "" }, rows, press("9", {}, "9"), { height: 4 }).state.selected).toBe(0);
    expect(advanceChooser({ selected: 0, query: "" }, rows, press("3", {}, "3"), { height: 4 }).state.selected).toBe(2);
  });
});

/**
 * The furniture around the rows — a title, a status line, a position, a legend.
 *
 * Bubbles' list can hide each of these because a list rarely owns the whole screen; Nova's could not,
 * so a caller sharing the screen had no way to get those rows back. The invariants worth holding are
 * that hiding one part hides only that part, and that a transient status behaves like a message about
 * the last keystroke rather than a permanent row.
 */
describe("the chooser's chrome", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ value: index, label: `option ${index + 1}` }));
  const frame = (state: Parameters<typeof renderChooser>[0], height = 5) =>
    plain(renderChooser(state, items, { paint, title: "Pick one", width: 60, height }));

  it("shows title, position and legend by default", () => {
    const lines = frame({ selected: 0, query: "" });
    expect(lines).toContain("Pick one");
    expect(lines).toContain("1/20");
    expect(lines).toContain("move");
  });

  it("hides only what it was asked to hide", () => {
    expect(frame({ selected: 0, query: "", chrome: { title: false } })).not.toContain("Pick one");
    expect(frame({ selected: 0, query: "", chrome: { title: false } })).toContain("option 1");
    expect(frame({ selected: 0, query: "", chrome: { pagination: false } })).not.toContain("1/20");
    expect(frame({ selected: 0, query: "", chrome: { help: false } })).not.toContain("move");
  });

  it("keeps the position visible when the legend is hidden, since the rows cannot say it", () => {
    const lines = frame({ selected: 0, query: "", chrome: { help: false } });
    expect(lines).toContain("1/20");
  });

  it("gives back a row per hidden part, which is the point of hiding them", () => {
    const all = frame({ selected: 0, query: "" }).split("\n").length;
    // Help alone still leaves the position row behind — that is the rule above, and it costs a line.
    expect(frame({ selected: 0, query: "", chrome: { help: false } }).split("\n")).toHaveLength(all);
    const bare = frame({ selected: 0, query: "", chrome: { title: false, help: false, pagination: false } }).split("\n").length;
    expect(bare).toBe(all - 2);
  });

  it("draws a status line under everything, and only when there is one", () => {
    const lines = frame({ selected: 0, query: "", status: "added Anthropic key" }).split("\n");
    expect(lines.at(-1)).toContain("added Anthropic key");
    expect(frame({ selected: 0, query: "" })).not.toContain("added");
    // Suppressible with the rest of the furniture.
    expect(frame({ selected: 0, query: "", status: "added Anthropic key", chrome: { status: false } })).not.toContain("added");
  });

  it("retires the status on the next keystroke, rather than leaving it under a list it no longer describes", () => {
    const after = advanceChooser({ selected: 0, query: "", status: "added Anthropic key" }, items, press("down"));
    expect(after.state.status).toBeUndefined();
    expect(after.state.selected).toBe(1);
  });

  it("carries the chrome through every transition, including the ones that reset the query", () => {
    // The bug this closes: the filtering branches returned a fresh `{ selected, query }` literal, so a
    // list told to hide its help showed it again after one backspace.
    const hidden = { title: false as const, help: false as const };
    const state = { selected: 3, query: "opt", chrome: hidden };
    for (const input of [press("backspace"), press("u", { ctrl: true }), press("escape"), press("x", {}, "x")]) {
      const next = advanceChooser(state, items, input, { filter: true });
      if (next.done) continue;
      expect(next.state.chrome, `chrome lost on ${input.key.name}`).toEqual(hidden);
    }
  });

  it("shows a spinner beside the title while a caller is still fetching", () => {
    const lines = plain(renderChooser({ selected: 0, query: "" }, items, { paint, title: "Models", spinner: "✦", width: 60, height: 5 }));
    expect(lines.split("\n")[0]).toContain("✦ Models");
  });
});
