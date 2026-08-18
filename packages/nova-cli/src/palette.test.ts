import { describe, expect, it } from "vitest";
import { advancePalette, paletteEntries, rankPaletteEntries, renderPalette, runCommandPalette, type PaletteEntry, type PaletteKey } from "./palette";
import { visibleWidth } from "./markdown";

const entries: PaletteEntry[] = [
  { command: "/mode", args: "[plan|build|auto]", description: "Show or switch the permission mode" },
  { command: "/undo", description: "Revert the last turn's changes" },
  { command: "/diff", description: "What changed since the last checkpoint" },
  { command: "/cost", description: "Token and cost breakdown for this session", chord: "F7" },
];

const press = (name: string, extra: Partial<PaletteKey["key"]> = {}, str?: string): PaletteKey => ({ str, key: { name, ...extra } });
const type = (text: string): PaletteKey[] => [...text].map((char) => ({ str: char, key: { name: char } }));

describe("ranking", () => {
  it("puts a name match above a description match", () => {
    // "/undo" describes itself as reverting changes, so a naive substring search over everything
    // would rank it above "/diff" for the query "diff". Names have to win.
    expect(rankPaletteEntries(entries, "diff").map((entry) => entry.command)).toEqual(["/diff"]);
    expect(rankPaletteEntries(entries, "checkpoint").map((entry) => entry.command)).toEqual(["/diff"]);
  });

  it("finds a command by what it does, not only by its name", () => {
    // The case the palette exists for: nobody guesses "/undo" from the word "revert".
    expect(rankPaletteEntries(entries, "revert").map((entry) => entry.command)).toEqual(["/undo"]);
    expect(rankPaletteEntries(entries, "permission").map((entry) => entry.command)).toEqual(["/mode"]);
  });

  it("ignores a leading slash and surrounding space", () => {
    expect(rankPaletteEntries(entries, "  /co ").map((entry) => entry.command)).toEqual(["/cost"]);
  });

  it("returns everything for an empty query and nothing for a miss", () => {
    expect(rankPaletteEntries(entries, "")).toHaveLength(4);
    expect(rankPaletteEntries(entries, "kubernetes")).toEqual([]);
  });

  it("keeps equally good matches in catalog order", () => {
    // Reshuffling ties between keystrokes makes the highlighted row jump under the user's fingers.
    const ranked = rankPaletteEntries([...entries].reverse(), "o");
    expect(ranked.map((entry) => entry.command)).toEqual(["/cost", "/undo", "/mode", "/diff"]);
  });

  it("builds entries from the real command table", () => {
    const built = paletteEntries({ "/diff": "F8" });
    expect(built.find((entry) => entry.command === "/help")).toBeDefined();
    expect(built.find((entry) => entry.command === "/diff")?.chord).toBe("F8");
  });
});

describe("keystrokes", () => {
  it("filters as characters arrive and resets the selection", () => {
    let state = { query: "", selected: 2 };
    for (const key of type("und")) state = advancePalette(state, entries, key).state;
    expect(state).toEqual({ query: "und", selected: 0 });
  });

  it("moves the selection without running off either end", () => {
    let state = { query: "", selected: 0 };
    state = advancePalette(state, entries, press("up")).state;
    expect(state.selected).toBe(0);
    for (let index = 0; index < 10; index += 1) state = advancePalette(state, entries, press("down")).state;
    expect(state.selected).toBe(3);
  });

  it("returns the selected command on Enter", () => {
    const step = advancePalette({ query: "diff", selected: 0 }, entries, press("return"));
    expect(step.done).toEqual({ command: "/diff" });
  });

  it("leaves a trailing space on a command that takes arguments", () => {
    // Choosing "/mode" should leave the cursor ready to type "plan", not submit a bare "/mode".
    expect(advancePalette({ query: "mode", selected: 0 }, entries, press("return")).done).toEqual({ command: "/mode " });
  });

  it("dismisses on Escape and on the key that opened it", () => {
    expect(advancePalette({ query: "", selected: 0 }, entries, press("escape")).done).toEqual({});
    expect(advancePalette({ query: "", selected: 0 }, entries, press("g", { ctrl: true })).done).toEqual({});
    expect(advancePalette({ query: "", selected: 0 }, entries, press("c", { ctrl: true })).done).toEqual({});
  });

  it("chooses nothing when Enter lands on an empty result list", () => {
    expect(advancePalette({ query: "kubernetes", selected: 0 }, entries, press("return")).done).toEqual({});
  });

  it("clamps a stale selection when Enter uses it", () => {
    expect(advancePalette({ query: "diff", selected: 99 }, entries, press("return")).done).toEqual({ command: "/diff" });
  });

  it("edits the query with Backspace and Ctrl+U", () => {
    expect(advancePalette({ query: "diff", selected: 0 }, entries, press("backspace")).state.query).toBe("dif");
    expect(advancePalette({ query: "diff", selected: 3 }, entries, press("u", { ctrl: true })).state).toEqual({ query: "", selected: 0 });
  });

  it("does not let control keys and escape sequences leak into the query", () => {
    const before = { query: "di", selected: 0 };
    expect(advancePalette(before, entries, press("left")).state.query).toBe("di");
    expect(advancePalette(before, entries, press("a", { ctrl: true }, "")).state.query).toBe("di");
    expect(advancePalette(before, entries, press("f1", {}, "OP")).state.query).toBe("di");
  });
});

describe("rendering", () => {
  it("marks the selected row and shows the key that also runs it", () => {
    const rendered = renderPalette({ query: "co", matches: rankPaletteEntries(entries, "co"), selected: 0 });
    expect(rendered).toContain("❯ /cost");
    expect(rendered).toContain("[F7]");
  });

  it("keeps the selection inside the visible window on a long list", () => {
    const many = Array.from({ length: 30 }, (_unused, index) => ({ command: `/c${index}`, description: `command ${index}` }));
    const rendered = renderPalette({ query: "", matches: many, selected: 27 }, { rows: 5 });
    expect(rendered).toContain("❯ /c27");
  });

  it("says so plainly when nothing matches", () => {
    expect(renderPalette({ query: "zzz", matches: [], selected: 0 })).toContain("(no match)");
  });

  it("clips long commands, descriptions and queries at every terminal width", () => {
    const long = [{ command: `/${"command".repeat(12)}`, args: `[${"argument".repeat(8)}]`, description: "description ".repeat(20) }];
    for (const width of [1, 8, 19, 30, 80]) {
      const rendered = renderPalette({ query: "query ".repeat(20), matches: long, selected: 0 }, { width });
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}: ${line}`).toBeLessThanOrEqual(width);
    }
  });

  describe("opening upward", () => {
    const matches = rankPaletteEntries(entries, "");

    it("puts the query line last, where the user is typing", () => {
      const lines = renderPalette({ query: "", matches, selected: 0 }, { direction: "up", rows: 3 }).split("\n");
      expect(lines.at(-1)).toContain("›");
      expect(lines).toHaveLength(4);
    });

    it("puts the selected row nearest the query line, not furthest from it", () => {
      // In an upward list the row adjacent to the cursor is the one the eye lands on, so it has to
      // be the one Return would take. Rendered downward, the same selection sits at the top.
      const up = renderPalette({ query: "", matches, selected: 0 }, { direction: "up", rows: 3 }).split("\n");
      expect(up.at(-2)).toContain("❯");

      const down = renderPalette({ query: "", matches, selected: 0 }, { rows: 3 }).split("\n");
      expect(down[1]).toContain("❯");
    });

    it("shows the same rows either way, only their order differs", () => {
      const up = renderPalette({ query: "", matches, selected: 0 }, { direction: "up", rows: 3 }).split("\n");
      const down = renderPalette({ query: "", matches, selected: 0 }, { rows: 3 }).split("\n");
      expect([...up].reverse()).toEqual(down);
    });
  });
});

describe("the interaction end to end", () => {
  async function* keys(sequence: PaletteKey[]) {
    for (const key of sequence) yield key;
  }

  it("types, filters and chooses", async () => {
    const frames: string[] = [];
    const chosen = await runCommandPalette(keys([...type("revert"), press("return")]), entries, (frame) => frames.push(frame));

    expect(chosen).toBe("/undo");
    // One frame before any key, then one per keystroke: the list is repainted as the query narrows.
    expect(frames).toHaveLength(7);
    expect(frames.at(-1)).toContain("❯ /undo");
  });

  it("returns nothing when dismissed, so the caller runs no command", async () => {
    expect(await runCommandPalette(keys([...type("di"), press("escape")]), entries, () => {})).toBeUndefined();
  });

  it("starts filtered by a seeded query, so a dropdown opened by typing '/' is already narrowed", async () => {
    const chosen = await runCommandPalette(keys([...type("mode"), press("return")]), entries, () => {}, { initialQuery: "/" });
    expect(chosen).toBe("/mode ");
  });

  it("hands the typed text back on dismissal instead of swallowing it", async () => {
    // Escape means "not from this menu", not "forget that I typed" — a dropdown that opens on "/"
    // would otherwise eat every keystroke of anyone typing an absolute path.
    const dismissed: string[] = [];
    await runCommandPalette(keys([...type("/hom"), press("escape")]), entries, () => {}, { onDismiss: (query) => dismissed.push(query) });
    expect(dismissed).toEqual(["/hom"]);
  });

  it("does not report a dismissal when a command was chosen", async () => {
    const dismissed: string[] = [];
    await runCommandPalette(keys([...type("diff"), press("return")]), entries, () => {}, { onDismiss: (query) => dismissed.push(query) });
    expect(dismissed).toEqual([]);
  });

  it("returns nothing when the key stream ends without a choice", async () => {
    // Stdin closing mid-palette must not resolve to a command nobody picked.
    expect(await runCommandPalette(keys(type("di")), entries, () => {})).toBeUndefined();
  });
});

describe("finding a command you half-remember", () => {
  it("matches letters in order when they are not adjacent", () => {
    // Slash commands are short words with no separators, so there is nothing to abbreviate *by*:
    // a user who half-remembers a name has only the letters and their order to go on.
    expect(rankPaletteEntries(entries, "wnd").map((entry) => entry.command)).toEqual([]);
    expect(rankPaletteEntries(entries, "md").map((entry) => entry.command)).toContain("/mode");
    expect(rankPaletteEntries(entries, "df").map((entry) => entry.command)).toContain("/diff");
  });

  it("never lets a subsequence match outrank something typed exactly", () => {
    // Subsequence matching is generous enough to match most of the catalog on a short query, so it
    // has to sit beneath every literal match or it drowns the answers people meant.
    const ranked = rankPaletteEntries(entries, "cost").map((entry) => entry.command);
    expect(ranked[0]).toBe("/cost");
    const byName = rankPaletteEntries(entries, "diff").map((entry) => entry.command);
    expect(byName[0]).toBe("/diff");
  });

  it("still ranks a name match above a description match", () => {
    // The original guarantee, kept: typing "diff" must not put /undo first because its description
    // says "changes".
    const ranked = rankPaletteEntries(entries, "mode").map((entry) => entry.command);
    expect(ranked[0]).toBe("/mode");
  });
});

describe("moving through the palette", () => {
  const many: PaletteEntry[] = Array.from({ length: 20 }, (_unused, index) => ({ command: `/c${index}`, description: `command ${index}` }));

  it("pages with an overlap, so the row you were reading survives the jump", () => {
    const step = advancePalette({ query: "", selected: 0 }, many, press("pagedown"), { rows: 8 });
    expect(step.state.selected).toBe(7);
    const back = advancePalette(step.state, many, press("pageup"), { rows: 8 });
    expect(back.state.selected).toBe(0);
  });

  it("jumps to the ends", () => {
    expect(advancePalette({ query: "", selected: 5 }, many, press("end")).state.selected).toBe(19);
    expect(advancePalette({ query: "", selected: 5 }, many, press("home")).state.selected).toBe(0);
  });

  it("accepts Ctrl+P and Ctrl+N, since readline's own are unavailable while this is open", () => {
    expect(advancePalette({ query: "", selected: 3 }, many, press("n", { ctrl: true })).state.selected).toBe(4);
    expect(advancePalette({ query: "", selected: 3 }, many, press("p", { ctrl: true })).state.selected).toBe(2);
  });

  it("clamps at both ends rather than wrapping", () => {
    expect(advancePalette({ query: "", selected: 0 }, many, press("pageup"), { rows: 8 }).state.selected).toBe(0);
    expect(advancePalette({ query: "", selected: 19 }, many, press("pagedown"), { rows: 8 }).state.selected).toBe(19);
  });

  it("erases a word of the query with Ctrl+W", () => {
    expect(advancePalette({ query: "show mode", selected: 0 }, entries, press("w", { ctrl: true })).state.query).toBe("show");
  });

  it("keeps every navigation key inside the match list as it narrows", () => {
    // End on a filtered list must land on the last *match*, not the last entry of the full catalog.
    const step = advancePalette({ query: "c1", selected: 0 }, many, press("end"), { rows: 8 });
    const matches = rankPaletteEntries(many, "c1");
    expect(step.state.selected).toBe(matches.length - 1);
  });
});
