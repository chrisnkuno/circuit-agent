import { describe, expect, it } from "vitest";
import {
  applyEditorAction,
  editorContent,
  editorKeyBar,
  editorStatus,
  initialEditorState,
  keyToEditorAction,
  visibleEditorLines,
  type EditorAction,
  type EditorState,
} from "./editor";

const open = (content: string, rows = 10) => initialEditorState("app.ts", content, rows);

/** Applies a sequence of actions, discarding effects — for tests about the document, not the host. */
function run(state: EditorState, actions: EditorAction[]): EditorState {
  return actions.reduce((current, action) => applyEditorAction(current, action).state, state);
}

/**
 * Drives the editor by keystroke, the way a terminal actually would. A multi-character string is
 * expanded into one keypress per character, so `"hello"` types five keys rather than one absurd one.
 */
function type(state: EditorState, keys: Array<string | { name: string; ctrl?: boolean }>): EditorState {
  const presses = keys.flatMap<string | { name: string; ctrl?: boolean }>((entry) => (typeof entry === "string" ? [...entry] : [entry]));
  return presses.reduce((current, entry) => {
    const key = typeof entry === "string" ? { name: entry } : entry;
    const character = typeof entry === "string" ? entry : undefined;
    return applyEditorAction(current, keyToEditorAction(key, character, current)).state;
  }, state);
}

describe("opening a file", () => {
  it("round-trips content exactly, so opening and closing changes nothing", () => {
    for (const content of ["", "one", "one\ntwo", "trailing\n", "\n\nblank\n\n", "tabs\tand  spaces"]) {
      expect(editorContent(open(content)), JSON.stringify(content)).toBe(content);
    }
  });

  it("treats an empty file as one empty line, not as no lines", () => {
    // The document invariant everything else depends on: the cursor always has a line to sit on.
    const state = open("");
    expect(state.lines).toEqual([""]);
    expect(state.cursor).toEqual({ row: 0, col: 0 });
  });

  it("starts in normal mode, unmodified", () => {
    expect(open("x").mode).toBe("normal");
    expect(open("x").dirty).toBe(false);
  });
});

describe("moving around", () => {
  const state = open("first line\nsecond\nthird line here");

  it("never lets the cursor leave the document, however hard it is pushed", () => {
    for (const action of [
      { kind: "move", rows: -99 }, { kind: "move", rows: 99 },
      { kind: "move", cols: -99 }, { kind: "move", cols: 99 },
    ] as EditorAction[]) {
      const moved = applyEditorAction(state, action).state;
      expect(moved.cursor.row).toBeGreaterThanOrEqual(0);
      expect(moved.cursor.row).toBeLessThan(moved.lines.length);
      expect(moved.cursor.col).toBeGreaterThanOrEqual(0);
      expect(moved.cursor.col).toBeLessThanOrEqual(moved.lines[moved.cursor.row].length);
    }
  });

  /**
   * The mode-dependent column bound. In insert mode the cursor sits *after* the last character so
   * text can be appended; in normal mode it sits *on* a character, so the last column is one less.
   */
  it("allows one more column in insert mode than in normal mode", () => {
    const atEnd = run(state, [{ kind: "jump", to: "lineEnd" }]);
    expect(atEnd.cursor.col).toBe("first line".length - 1);
    const inserting = run(state, [{ kind: "insert", at: "lineEnd" }]);
    expect(inserting.cursor.col).toBe("first line".length);
  });

  it("clamps the column when moving onto a shorter line, instead of hanging past its end", () => {
    const moved = run(state, [{ kind: "jump", to: "lineEnd" }, { kind: "move", rows: 1 }]);
    expect(moved.cursor).toEqual({ row: 1, col: "second".length - 1 });
  });

  it("jumps by word, forward and back", () => {
    const start = open("alpha beta gamma");
    const first = run(start, [{ kind: "jump", to: "wordForward" }]);
    expect(first.cursor.col).toBe(6); // start of "beta"
    const second = run(first, [{ kind: "jump", to: "wordForward" }]);
    expect(second.cursor.col).toBe(11); // start of "gamma"
    expect(run(second, [{ kind: "jump", to: "wordBack" }]).cursor.col).toBe(6);
    // At the very start, `b` stays put rather than underflowing.
    expect(run(start, [{ kind: "jump", to: "wordBack" }]).cursor.col).toBe(0);
  });

  it("jumps to the ends of the file", () => {
    expect(run(state, [{ kind: "jump", to: "fileEnd" }]).cursor.row).toBe(2);
    expect(run(state, [{ kind: "jump", to: "fileEnd" }, { kind: "jump", to: "fileStart" }]).cursor.row).toBe(0);
  });
});

describe("scrolling", () => {
  const long = open([...Array(50).keys()].map((index) => `line ${index}`).join("\n"), 10);

  it("keeps the cursor on screen, wherever it goes", () => {
    for (const row of [0, 5, 9, 10, 25, 49]) {
      const moved = run(long, [{ kind: "jump", to: "fileStart" }, { kind: "move", rows: row }]);
      expect(moved.cursor.row, `row ${row}`).toBeGreaterThanOrEqual(moved.scroll);
      expect(moved.cursor.row).toBeLessThan(moved.scroll + moved.viewportRows);
    }
  });

  it("does not scroll while the cursor is still inside the window", () => {
    // Scrolling on every keypress is the thing that makes a terminal editor feel seasick.
    expect(run(long, [{ kind: "move", rows: 5 }]).scroll).toBe(0);
  });

  it("shows exactly the viewport, with absolute line numbers for the gutter", () => {
    const scrolled = run(long, [{ kind: "move", rows: 20 }]);
    const visible = visibleEditorLines(scrolled);
    expect(visible).toHaveLength(10);
    expect(visible[0].number).toBe(scrolled.scroll + 1);
    expect(visible.at(-1)!.number).toBe(scrolled.scroll + 10);
  });

  it("does not pad past the end of a short file", () => {
    expect(visibleEditorLines(open("a\nb", 10))).toHaveLength(2);
  });
});

describe("editing", () => {
  it("inserts text at the cursor and moves past it", () => {
    const state = type(open("hello"), ["A", " world"]);
    expect(editorContent(state)).toBe("hello world");
    expect(state.dirty).toBe(true);
  });

  it("splits a line on enter and joins it back on backspace", () => {
    const split = run(open("hello world"), [{ kind: "insert" }, { kind: "move", cols: 5 }, { kind: "newline" }]);
    expect(split.lines).toEqual(["hello", " world"]);
    expect(split.cursor).toEqual({ row: 1, col: 0 });
    // Backspace at column zero joins onto the previous line, cursor landing at the seam.
    const joined = applyEditorAction(split, { kind: "backspace" }).state;
    expect(joined.lines).toEqual(["hello world"]);
    expect(joined.cursor).toEqual({ row: 0, col: 5 });
  });

  it("does nothing on backspace at the very start, rather than corrupting the document", () => {
    const state = run(open("abc"), [{ kind: "insert" }, { kind: "backspace" }]);
    expect(editorContent(state)).toBe("abc");
  });

  it("opens a line below and above, entering insert mode on it", () => {
    const below = run(open("one\ntwo"), [{ kind: "insert", at: "below" }]);
    expect(below.lines).toEqual(["one", "", "two"]);
    expect(below.mode).toBe("insert");
    expect(below.cursor).toEqual({ row: 1, col: 0 });

    const above = run(open("one\ntwo"), [{ kind: "insert", at: "above" }]);
    expect(above.lines).toEqual(["", "one", "two"]);
    expect(above.cursor.row).toBe(0);
  });

  it("deletes a character and a whole line", () => {
    expect(editorContent(run(open("abc"), [{ kind: "deleteChar" }]))).toBe("bc");
    expect(editorContent(run(open("one\ntwo\nthree"), [{ kind: "move", rows: 1 }, { kind: "deleteLine" }]))).toBe("one\nthree");
  });

  it("leaves one empty line when the last line is deleted", () => {
    const state = run(open("only"), [{ kind: "deleteLine" }]);
    expect(state.lines).toEqual([""]);
    expect(state.cursor).toEqual({ row: 0, col: 0 });
  });

  it("deletes nothing on an empty line rather than eating the newline", () => {
    expect(editorContent(run(open("a\n\nb"), [{ kind: "move", rows: 1 }, { kind: "deleteChar" }]))).toBe("a\n\nb");
  });
});

describe("undo and redo", () => {
  /**
   * The property that matters: undo restores the document *exactly*, whatever the edit was. Tested
   * over a mixed sequence rather than one edit, because the bugs live in interactions — an edit
   * that forgets its checkpoint is invisible until another edit follows it.
   */
  it("restores the exact document, for every kind of edit", () => {
    for (const edits of [
      [{ kind: "type", character: "x" }],
      [{ kind: "deleteLine" }],
      [{ kind: "insert" }, { kind: "newline" }],
      [{ kind: "insert", at: "below" }],
      [{ kind: "deleteChar" }],
      [{ kind: "type", character: "a" }, { kind: "type", character: "b" }, { kind: "deleteChar" }],
    ] as EditorAction[][]) {
      const before = open("first\nsecond\nthird");
      const after = run(before, edits);
      expect(editorContent(after), JSON.stringify(edits)).not.toBe(editorContent(before));
      const undone = run(after, edits.map(() => ({ kind: "undo" }) as EditorAction));
      expect(editorContent(undone), JSON.stringify(edits)).toBe(editorContent(before));
    }
  });

  it("redoes what it just undid, and undo/redo round-trips", () => {
    const edited = run(open("abc"), [{ kind: "type", character: "z" }]);
    const undone = run(edited, [{ kind: "undo" }]);
    const redone = run(undone, [{ kind: "redo" }]);
    expect(editorContent(redone)).toBe(editorContent(edited));
  });

  it("drops the redo stack once a new edit lands, since that future no longer exists", () => {
    const state = run(open("abc"), [{ kind: "type", character: "1" }, { kind: "undo" }, { kind: "type", character: "2" }]);
    expect(state.future).toHaveLength(0);
    expect(run(state, [{ kind: "redo" }]).message).toBe("nothing to redo");
  });

  it("says so rather than silently doing nothing when there is nothing to undo", () => {
    expect(run(open("abc"), [{ kind: "undo" }]).message).toBe("nothing to undo");
  });

  it("does not checkpoint pure cursor movement, so undo never replays a cursor", () => {
    const moved = run(open("abc\ndef"), [{ kind: "move", rows: 1 }, { kind: "jump", to: "lineEnd" }, { kind: "insert" }]);
    expect(moved.history).toHaveLength(0);
  });
});

describe("search", () => {
  const state = open("alpha\nbeta\ngamma\nbeta again");

  it("finds the next match and moves the cursor onto it", () => {
    const found = type(state, ["/", "b", "e", "t", "a", { name: "return" }]);
    expect(found.cursor).toEqual({ row: 1, col: 0 });
  });

  it("wraps around the end of the file, so n keeps working at the last match", () => {
    const first = type(state, ["/", "b", "e", "t", "a", { name: "return" }]);
    const second = applyEditorAction(first, { kind: "searchNext" }).state;
    expect(second.cursor.row).toBe(3);
    // Past the last match, the next search wraps to the first rather than going quiet.
    expect(applyEditorAction(second, { kind: "searchNext" }).state.cursor.row).toBe(1);
  });

  it("reports a miss instead of moving the cursor somewhere arbitrary", () => {
    const missed = type(state, ["/", "z", "z", { name: "return" }]);
    expect(missed.message).toContain("no match");
    expect(missed.cursor).toEqual({ row: 0, col: 0 });
  });

  it("takes every printable key as query text, not as a command", () => {
    // Typing "i" or "dd" mid-search must filter, not enter insert mode or delete a line.
    const searching = type(state, ["/", "i", "d", "d"]);
    expect(searching.search.query).toBe("idd");
    expect(searching.mode).toBe("normal");
    expect(searching.lines).toHaveLength(4);
  });
});

describe("keys", () => {
  it("reads the same byte differently depending on mode", () => {
    // The defining property of a modal editor, and the one that makes it feel haunted when wrong.
    const normal = open("abc");
    expect(keyToEditorAction({ name: "i" }, "i", normal)).toEqual({ kind: "insert" });
    const inserting = run(normal, [{ kind: "insert" }]);
    expect(keyToEditorAction({ name: "i" }, "i", inserting)).toEqual({ kind: "type", character: "i" });
  });

  it("honours save and quit from every mode, because they are what a stuck user tries", () => {
    for (const state of [open("abc"), run(open("abc"), [{ kind: "insert" }]), type(open("abc"), ["/"])]) {
      expect(keyToEditorAction({ name: "s", ctrl: true }, undefined, state)).toEqual({ kind: "save" });
      expect(keyToEditorAction({ name: "q", ctrl: true }, undefined, state)).toEqual({ kind: "quit" });
    }
  });

  it("completes two-key sequences, and abandons them cleanly when the second key does not match", () => {
    expect(editorContent(type(open("one\ntwo"), ["d", "d"]))).toBe("two");
    // `dx` is not a command: it must abandon the pending `d` without deleting anything.
    const abandoned = type(open("one\ntwo"), ["d", "x"]);
    expect(editorContent(abandoned)).toBe("one\ntwo");
    expect(abandoned.pending).toBeUndefined();
    expect(editorContent(type(open("one\ntwo"), ["G", "g", "g"]))).toBe("one\ntwo");
    expect(type(open("one\ntwo"), ["G", "g", "g"]).cursor.row).toBe(0);
  });

  it("escapes out of insert mode and out of a search, never deeper in", () => {
    expect(type(open("abc"), ["i", { name: "escape" }]).mode).toBe("normal");
    expect(type(open("abc"), ["/", "a", { name: "escape" }]).search.typing).toBe(false);
  });

  it("types a tab as spaces, since there is nothing else here to focus", () => {
    expect(editorContent(type(open(""), ["i", { name: "tab" }, "x"]))).toBe("  x");
  });
});

describe("what the host is told to do", () => {
  it("asks the host to save, and reports the file as clean afterwards", () => {
    const edited = run(open("abc"), [{ kind: "type", character: "z" }]);
    expect(edited.dirty).toBe(true);
    const { state, effect } = applyEditorAction(edited, { kind: "save" });
    expect(effect).toEqual({ kind: "save" });
    expect(state.dirty).toBe(false);
    expect(state.message).toContain("saved app.ts");
  });

  it("asks the host to quit without touching the document", () => {
    const edited = run(open("abc"), [{ kind: "type", character: "z" }]);
    const { state, effect } = applyEditorAction(edited, { kind: "quit" });
    expect(effect).toEqual({ kind: "quit" });
    // Still dirty: whether to warn about unsaved changes is the host's call, and it needs the flag.
    expect(state.dirty).toBe(true);
    expect(editorContent(state)).toBe(editorContent(edited));
  });
});

describe("what the user is shown", () => {
  it("advertises the way out first when in insert mode", () => {
    const bar = editorKeyBar(run(open("abc"), [{ kind: "insert" }]));
    expect(bar.startsWith("esc")).toBe(true);
    expect(bar).toContain("^S save");
  });

  /**
   * The bar used to be clipped to the terminal width, which cut `^S save` and `^Q quit` off the
   * right-hand end — losing exactly the two hints someone who cannot get out of the editor needs.
   */
  it("keeps save and quit visible however narrow the terminal, dropping lesser hints instead", () => {
    for (const columns of [80, 60, 40, 24, 16, 8]) {
      const bar = editorKeyBar(open("abc"), columns);
      expect(bar, `${columns} columns`).toContain("^S save");
      expect(bar).toContain("^Q quit");
      // "^S save   ^Q quit" is 17 cells, and that is the floor: below it the bar overflows rather
      // than hiding the way out, which is the right trade at a width nothing is readable at anyway.
      if (columns >= 20) expect(bar.length, `${columns} columns`).toBeLessThanOrEqual(columns);
    }
    expect(editorKeyBar(open("abc"), 8)).toBe("^S save   ^Q quit");
  });

  it("keeps every hint when there is room for them", () => {
    const bar = editorKeyBar(open("abc"), 120);
    for (const hint of ["i insert", "o new line", "x del", "dd del line", "u undo", "/ find"]) {
      expect(bar).toContain(hint);
    }
  });

  it("shows the search query itself while searching", () => {
    expect(editorKeyBar(type(open("abc"), ["/", "a", "b"]))).toContain("/ab");
  });

  it("reports file, modified state, position and length", () => {
    const edited = run(open("one\ntwo\nthree"), [{ kind: "move", rows: 1 }, { kind: "type", character: "x" }]);
    const status = editorStatus(edited);
    expect(status).toContain("app.ts");
    expect(status).toContain("[+]");
    expect(status).toContain("2:2"); // 1-based row and column, as every editor reports them
    expect(status).toContain("3 lines");
  });
});
