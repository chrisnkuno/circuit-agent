import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS } from "./glyphs";
import { ExpandableStore, expandHint, parseExpandCommand, renderExpandableList } from "./expandable";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("the fold store", () => {
  it("hands out ids that never repeat, so a printed hint stays valid", () => {
    const store = new ExpandableStore();
    const first = store.add("a", "A", 1);
    const second = store.add("b", "B", 2);
    expect(second).toBe(first + 1);
    expect(store.get(first)?.full).toBe("A");
    expect(store.get(second)?.label).toBe("b");
  });

  it("keeps the whole text, which is the difference between folding and truncating", () => {
    const store = new ExpandableStore();
    const full = Array.from({ length: 500 }, (_unused, index) => `line ${index}`).join("\n");
    const id = store.add("big", full, 486);
    expect(store.get(id)?.full).toBe(full);
  });

  it("bounds what it holds, and drops the oldest — never the block still on screen", () => {
    const store = new ExpandableStore();
    for (let index = 0; index < 100; index += 1) store.add(`entry ${index}`, "x", 1);
    expect(store.size).toBeLessThanOrEqual(64);
    expect(store.last?.label).toBe("entry 99");
    // Ids stay meaningful even after eviction: an old one simply resolves to nothing.
    expect(store.get(1)).toBeUndefined();
  });

  it("forgets everything when the thread does", () => {
    const store = new ExpandableStore();
    store.add("a", "A", 1);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.last).toBeUndefined();
  });
});

describe("the /expand grammar", () => {
  it("treats a bare /expand as the most recent fold, which is what the word means out loud", () => {
    expect(parseExpandCommand("/expand")).toEqual({ kind: "last" });
    expect(parseExpandCommand("/expand last")).toEqual({ kind: "last" });
  });

  it("takes a number, all, and list", () => {
    expect(parseExpandCommand("/expand 3")).toEqual({ kind: "one", id: 3 });
    expect(parseExpandCommand("/expand all")).toEqual({ kind: "all" });
    expect(parseExpandCommand("/expand list")).toEqual({ kind: "list" });
  });

  it("explains a bad argument instead of guessing at one", () => {
    const parsed = parseExpandCommand("/expand banana");
    expect(parsed?.kind).toBe("invalid");
    expect(parsed && "reason" in parsed && parsed.reason).toContain("banana");
  });

  it("ignores anything that is not the command", () => {
    expect(parseExpandCommand("/expandable")).toBeNull();
    expect(parseExpandCommand("please expand the tests")).toBeNull();
  });
});

describe("what the reader is offered", () => {
  it("names the id in the hint, so expanding needs no counting back up the screen", () => {
    expect(plain(expandHint(7, 42, "none"))).toContain("/expand 7");
    expect(plain(expandHint(7, 42, "none"))).toContain("42 more lines");
  });

  it("says line rather than lines when there is one", () => {
    expect(plain(expandHint(1, 1, "none"))).toContain("1 more line ");
  });

  it("draws the hint in ASCII when the glyph set says so", () => {
    expect(expandHint(1, 2, "none", ASCII_GLYPHS)).not.toMatch(/[▸·]/);
  });

  it("says plainly when there is nothing folded, rather than printing an empty list", () => {
    expect(plain(renderExpandableList([], "none"))).toContain("nothing folded");
  });

  it("lists what is foldable with its id and its size", () => {
    const store = new ExpandableStore();
    store.add("src/app.ts", "x", 12);
    const rendered = plain(renderExpandableList(store.all, "none"));
    expect(rendered).toContain("[1]");
    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain("12 hidden lines");
  });
});
