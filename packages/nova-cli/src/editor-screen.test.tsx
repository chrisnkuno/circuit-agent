/** @jsxImportSource @termuijs/jsx */
import { render } from "@termuijs/testing";
import { describe, expect, it } from "vitest";
import { EditorScreen } from "./editor-screen";
import { keyToFileAction } from "./file-browser";

/**
 * The functional level for the editor: a real render, real keystrokes, and the content that comes
 * back out. Every reducer test in `editor.test.ts` can pass while the screen is wired up wrong —
 * the wrong prop, a swallowed effect, a viewport computed from the wrong number of rows.
 */
function open(content: string, options: { columns?: number; rows?: number } = {}) {
  let saved: string | undefined;
  let exited = false;
  const view = render(
    <EditorScreen
      columns={options.columns ?? 60}
      rows={options.rows ?? 12}
      path="notes.txt"
      content={content}
      onExit={(value) => { exited = true; saved = value; }}
    />,
    { width: options.columns ?? 60, height: options.rows ?? 12 },
  );
  return {
    view,
    frame: () => String(view.lastFrame()),
    get exited() { return exited; },
    get saved() { return saved; },
  };
}

describe("the editor screen", () => {
  it("shows the file, its line numbers, and the key bar", () => {
    const screen = open("alpha\nbeta");
    const frame = screen.frame();
    expect(frame).toContain("notes.txt");
    // "alpha" renders as "█lpha": the block caret sits *on* the first character rather than
    // between characters, which is what a normal-mode cursor does.
    expect(frame).toContain("lpha");
    expect(frame).toContain("beta");
    expect(frame).toContain("1");
    // nano's one genuinely great idea: the way out is on screen from the first frame.
    expect(frame).toContain("^S save");
    expect(frame).toContain("^Q quit");
  });

  it("marks where the cursor is, so it is visible without a hardware cursor", () => {
    expect(open("abc").frame()).toContain("█");
  });

  it("reports the content when saved, and undefined when quit", () => {
    const saved = open("hi");
    saved.view.pressKey("s", { ctrl: true });
    expect(saved.saved).toBe("hi");

    const quit = open("hi");
    quit.view.pressKey("q", { ctrl: true });
    expect(quit.exited).toBe(true);
    expect(quit.saved).toBeUndefined();
  });

  it("types into the document and saves what was typed", () => {
    const screen = open("ab");
    screen.view.pressKey("A"); // append at end of line
    screen.view.pressKeys(["c", "d"]);
    screen.view.pressKey("s", { ctrl: true });
    expect(screen.saved).toBe("abcd");
  });

  it("shows the modified marker once the document changes", () => {
    const screen = open("ab");
    expect(screen.frame()).not.toContain("[+]");
    screen.view.pressKeys(["i", "z"]);
    expect(screen.frame()).toContain("[+]");
  });

  it("switches the key bar with the mode, advertising the way out of insert first", () => {
    const screen = open("ab");
    expect(screen.frame()).toContain("i insert");
    screen.view.pressKey("i");
    expect(screen.frame()).toContain("esc normal");
  });

  it("leaves room for its own chrome rather than running text under the key bar", () => {
    // 12 rows of screen, 2 of chrome: at most 10 lines of the document are visible.
    const screen = open([...Array(40).keys()].map((index) => `line ${index}`).join("\n"), { rows: 12 });
    const frame = screen.frame();
    expect(frame).toContain("line 1");
    expect(frame).not.toContain("line 11");
    expect(frame).toContain("^S save");
  });
});

describe("opening the editor from the file browser", () => {
  it("binds e to edit, distinct from Enter", () => {
    // Picking a file to mention and opening it to change are different intents, and the browser is
    // genuinely used for both.
    expect(keyToFileAction({}, "e", false)).toEqual({ kind: "edit" });
    expect(keyToFileAction({ name: "return" }, undefined, false)).toEqual({ kind: "pick" });
  });

  it("does not steal e while the reader is typing a search query", () => {
    expect(keyToFileAction({}, "e", true)).toEqual({ kind: "type", character: "e" });
  });
});
