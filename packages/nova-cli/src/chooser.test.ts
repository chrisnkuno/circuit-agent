import { describe, expect, it } from "vitest";
import { advanceChooser, filterItems, renderChooser, runChooser, type ChooserItem } from "./chooser";
import type { KeypressEvent } from "./keybindings";

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

  it("heads a group once rather than above every row in it", () => {
    const grouped: ChooserItem<string>[] = [
      { value: "a", label: "A", header: "Group" },
      { value: "b", label: "B", header: "Group" },
    ];
    expect(renderChooser({ selected: 0, query: "" }, grouped, { paint }).match(/Group/g)).toHaveLength(1);
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
});
