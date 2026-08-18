import { describe, expect, it } from "vitest";
import { dropupRowBudget, dropupWindow, renderDropup, type DropupEntry } from "./dropup";
import { dropupEraseBlock, dropupPaintInPlace, PromptBox } from "./tui";
import { ASCII_GLYPHS } from "./glyphs";

const entry = (command: string, description = "does a thing", extra: Partial<DropupEntry> = {}): DropupEntry => ({ command, description, ...extra });

/** Strips the escape sequences so a row's *text* can be asserted without matching colour codes. */
const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("dropup rows", () => {
  it("puts the best match on the row nearest the prompt", () => {
    // The defining property of an upward list, and the one that is invisible in a screenshot of a
    // single row: rank order is reversed, so the eye lands on the row Return would take.
    const lines = renderDropup([entry("/mode"), entry("/model"), entry("/models")], { width: 80 });
    expect(plain(lines.at(-1)!)).toContain("/mode");
    expect(plain(lines[0])).toContain("/models");
  });

  it("never emits a row wider than the terminal", () => {
    // A wrapped row occupies two screen rows while the paint arithmetic believes it occupies one,
    // and every row above it is then written to the wrong place — the list eats the transcript.
    const wide = entry("/history", "browse, search or pick up durable conversation history across every session in this project");
    for (const width of [8, 20, 40, 80]) {
      for (const line of renderDropup([wide, entry("/help")], { width })) {
        expect(plain(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("survives a terminal too narrow to lay out columns", () => {
    const lines = renderDropup([entry("/mode"), entry("/model")], { width: 4 });
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(plain(line).length).toBeLessThanOrEqual(4);
  });

  it("shows the chord beside the command, so the list teaches its own shortcuts", () => {
    const lines = renderDropup([entry("/wander", "explore", { chord: "Ctrl+W" })], { width: 80 });
    expect(plain(lines[0])).toContain("[Ctrl+W]");
  });

  it("keeps the chord and clips the description, not the other way round", () => {
    // The bug this pins produced rows ending "...[Ctrl+" — a clip that ate the one part of the row
    // that would stop the user needing the list next time. The description is long and variable,
    // the chord is short and fixed, so the chord is charged for first.
    const long = entry("/wander", "Run a bounded research lab and grade what it finds", { chord: "Ctrl+W, F4, Alt+W" });
    const line = plain(renderDropup([long], { width: 100 })[0]);
    expect(line).toContain("[Ctrl+W, F4, Alt+W]");
    expect(line.length).toBeLessThanOrEqual(100);
  });

  it("drops the chord rather than leaving a row with no description at all", () => {
    // A chord with no hint of what the command does is a worse row than a description alone, so the
    // description keeps a floor. Below it the chord goes; above it the chord is what survives.
    const wander = entry("/wander", "Run a bounded research lab", { chord: "Ctrl+W, F4, Alt+W" });
    const narrow = plain(renderDropup([wander], { width: 30 })[0]);
    expect(narrow).not.toContain("[Ctrl+W");
    expect(narrow).toContain("Run");
    expect(narrow.length).toBeLessThanOrEqual(30);

    const roomier = plain(renderDropup([wander], { width: 46 })[0]);
    expect(roomier).toContain("[Ctrl+W, F4, Alt+W]");
    expect(roomier).toContain("Run");
    expect(roomier.length).toBeLessThanOrEqual(46);
  });

  it("marks the selected row and leaves the others unmarked", () => {
    const entries = [entry("/mode"), entry("/model"), entry("/models")];
    const lines = renderDropup(entries, { width: 80, selected: 1, glyphs: ASCII_GLYPHS });
    const marked = lines.filter((line) => plain(line).startsWith(`  ${ASCII_GLYPHS.prompt}`));
    expect(marked).toHaveLength(1);
    expect(plain(marked[0])).toContain("/model ");
  });

  it("clips to the row budget rather than growing past it", () => {
    const entries = Array.from({ length: 30 }, (_unused, index) => entry(`/command${index}`));
    expect(renderDropup(entries, { width: 80, maxRows: 5 })).toHaveLength(5);
  });
});

describe("the row budget", () => {
  it("leaves the transcript visible on a short terminal", () => {
    // A list that covers the error message you are responding to has optimised the wrong thing.
    expect(dropupRowBudget(24, 20)).toBe(8);
    expect(dropupRowBudget(12, 20)).toBe(6);
    expect(dropupRowBudget(9, 20)).toBe(3);
  });

  it("asks for nothing when there is no room at all", () => {
    expect(dropupRowBudget(6, 20)).toBe(0);
    expect(dropupRowBudget(3, 20)).toBe(0);
    expect(dropupRowBudget(1, 20)).toBe(0);
  });

  it("never asks for more rows than there are entries", () => {
    expect(dropupRowBudget(40, 2)).toBe(2);
  });
});

describe("the visible window", () => {
  it("keeps the selection on screen", () => {
    // A selection that walks off the window looks exactly like the arrow keys having stopped
    // working, and no single frame reveals it.
    for (let selected = 0; selected < 30; selected += 1) {
      const { start, length } = dropupWindow(30, 6, selected);
      expect(selected).toBeGreaterThanOrEqual(start);
      expect(selected).toBeLessThan(start + length);
    }
  });

  it("shows the head of the list when nothing is selected", () => {
    expect(dropupWindow(30, 6)).toEqual({ start: 0, length: 6 });
  });

  it("never windows past the end of the list", () => {
    const { start, length } = dropupWindow(4, 10, 3);
    expect(start).toBe(0);
    expect(length).toBe(4);
  });
});

describe("cursor control", () => {
  it("returns the cursor exactly where it found it", () => {
    // The property that makes this safe to run mid-keystroke: readline's model of where the cursor
    // is must still be true when control returns to it.
    const painted = dropupPaintInPlace(["a", "b", "c"]);
    expect(painted.startsWith("\x1b7")).toBe(true);
    expect(painted.endsWith("\x1b8\x1b[?25h")).toBe(true);
  });

  it("reaches past the input row and the top border to find the list", () => {
    // Three list rows sit four rows above the cursor: the input row, the top border, then the list.
    expect(dropupPaintInPlace(["a", "b", "c"])).toContain("\x1b[4A");
    expect(dropupPaintInPlace(["only"])).toContain("\x1b[2A");
  });

  it("writes nothing at all for an empty list", () => {
    expect(dropupPaintInPlace([])).toBe("");
  });

  it("erases the whole block from its top row down", () => {
    // `ED 0` from the top of the block, so no arithmetic is needed about how far the closing border
    // or a wrapped line reached.
    expect(dropupEraseBlock(3)).toBe("\x1b[?25l\x1b[4A\r\x1b[0J");
    expect(dropupEraseBlock(0)).toBe("\x1b[?25l\x1b[1A\r\x1b[0J");
  });
});

/** A stream that records what was written, standing in for a terminal. */
function fakeStream(columns = 80) {
  const writes: string[] = [];
  return { writes, columns, write: (text: string) => { writes.push(text); return true; }, get all() { return writes.join(""); } };
}

describe("the prompt box owning the list", () => {
  it("prints the list above the top border, so readline can never erase it", () => {
    // Readline refreshes its line with an `ED 0` from the input row, which destroys everything
    // below it — the closing border included. Rows above the top border are the one region it
    // never touches, which is why the list goes up rather than down.
    const stream = fakeStream();
    const box = new PromptBox(stream, { depth: "none", columns: () => 80 });
    box.draw("build", "~/project");
    stream.writes.length = 0;
    box.setSuggestions(["ROW-ONE", "ROW-TWO"], { mode: "build", workspace: "~/project" });
    const output = stream.all;
    expect(output.indexOf("ROW-ONE")).toBeLessThan(output.indexOf("ROW-TWO"));
    // Both rows are printed before the border that closes the bar below them.
    expect(output.indexOf("ROW-TWO")).toBeLessThan(output.lastIndexOf("\x1b[1A\r"));
  });

  it("repaints in place when the row count is unchanged, and moves the bar when it is not", () => {
    // The split that makes this cheap enough to run on every keystroke. Repainting in place touches
    // no row outside the list; a count change has to move the bar, and the caller must be told so it
    // can ask readline to redraw the line the erase took with it.
    const stream = fakeStream();
    const box = new PromptBox(stream, { depth: "none", columns: () => 80 });
    box.draw("build", "~/project");
    expect(box.setSuggestions(["a", "b"], { mode: "build", workspace: "~/project" }).moved).toBe(true);

    stream.writes.length = 0;
    const same = box.setSuggestions(["c", "d"], { mode: "build", workspace: "~/project" });
    expect(same.moved).toBe(false);
    expect(stream.all).toContain("\x1b7");
    expect(stream.all).not.toContain("\x1b[0J");

    expect(box.setSuggestions(["e"], { mode: "build", workspace: "~/project" }).moved).toBe(true);
    expect(box.suggestionRows).toBe(1);
  });

  it("erases the list rows along with the box, never stranding them above the transcript", () => {
    // A list left behind after Enter is worse than no list: it is on screen, stale, and describing
    // a command that has already run.
    const stream = fakeStream();
    const box = new PromptBox(stream, { depth: "none", columns: () => 80 });
    box.draw("build", "~/project");
    box.setSuggestions(["a", "b", "c"], { mode: "build", workspace: "~/project" });

    stream.writes.length = 0;
    box.erase("/mode");
    // Three list rows on top of the three the bar itself occupies.
    expect(stream.all.match(/\x1b\[1A\x1b\[2K/g)).toHaveLength(6);
    expect(box.suggestionRows).toBe(0);
  });

  it("does nothing when there is no box drawn to hang a list on", () => {
    const stream = fakeStream();
    const box = new PromptBox(stream, { depth: "none", columns: () => 80 });
    expect(box.setSuggestions(["a"], { mode: "build", workspace: "~" }).moved).toBe(false);
    expect(stream.all).toBe("");
  });
});
