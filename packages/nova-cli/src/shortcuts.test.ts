import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";
import { installShortcuts, replaceLine, withBorrowedKeyboard, type KeyboardHost } from "./shortcuts";
import { KeyBindingRegistry } from "./keybindings";

/**
 * What a menu leaves behind.
 *
 * A menu is drawn by repainting over itself, so every frame's cleanup is done by the *next* frame —
 * which means the last frame has nobody to clean it up. That is the whole of the "settings menu is
 * still on screen after I answered it" report, and it is invisible to a test that only checks the
 * value a menu returned.
 */

function host(columns = 80): KeyboardHost & { written: string[]; text: string } {
  const input = new EventEmitter() as unknown as NodeJS.ReadStream;
  const written: string[] = [];
  return {
    input,
    readline: {} as KeyboardHost["readline"],
    output: { write: (text: string) => { written.push(text); return true; }, columns } as unknown as KeyboardHost["output"],
    written,
    get text() { return written.join(""); },
  };
}

/** Cursor-up-and-erase pairs, which is how many rows the painter reclaimed. */
const erasedRows = (text: string) => (text.match(/\x1b\[1A\x1b\[2K/g) ?? []).length;

describe("borrowing the terminal for a menu", () => {
  it("takes the last frame down on the way out", async () => {
    const terminal = host();
    await withBorrowedKeyboard(terminal, undefined, async (_keys, paint) => {
      paint("one\ntwo\nthree");
      return "chosen";
    });
    // Three rows drawn, three rows reclaimed: the screen is as it was before the menu opened.
    expect(erasedRows(terminal.text)).toBe(3);
  });

  it("counts a wrapped row as the rows it actually occupies", async () => {
    const terminal = host(20);
    await withBorrowedKeyboard(terminal, undefined, async (_keys, paint) => {
      // 45 characters at 20 columns is three rows, not one — counting newlines would leave two
      // lines of a settings description on screen for every repaint.
      paint("x".repeat(45));
      return undefined;
    });
    expect(erasedRows(terminal.text)).toBe(3);
  });

  it("erases each frame before drawing the next, so frames never stack up", async () => {
    const terminal = host();
    await withBorrowedKeyboard(terminal, undefined, async (_keys, paint) => {
      paint("a\nb");
      paint("c\nd");
      return undefined;
    });
    // Two frames of two rows: two erased by the repaint, two by the teardown.
    expect(erasedRows(terminal.text)).toBe(4);
  });

  it("clears up even when the menu throws, so a failure does not leave a frame stranded", async () => {
    const terminal = host();
    await expect(withBorrowedKeyboard(terminal, undefined, async (_keys, paint) => {
      paint("one\ntwo");
      throw new Error("cancelled");
    })).rejects.toThrow("cancelled");
    expect(erasedRows(terminal.text)).toBe(2);
  });

  it("gives the keyboard back to whoever had it", async () => {
    const terminal = host();
    const listener = () => {};
    terminal.input.on("keypress", listener);
    await withBorrowedKeyboard(terminal, undefined, async () => undefined);
    expect(terminal.input.listeners("keypress")).toContain(listener);
  });

  it("paints through a caller-supplied surface instead of the default overlay, when one is given", async () => {
    // The inline suggestion dropdown already holds its own reserved rows (via the pinned footer's
    // scroll region) — it must not also get the free-floating overlay every other menu uses, or
    // two competing menus would be on screen at once.
    const terminal = host();
    const frames: string[] = [];
    let erased = false;
    const surface = { paint: (frame: string) => frames.push(frame), erase: () => { erased = true; } };
    await withBorrowedKeyboard(terminal, undefined, async (_keys, paint) => {
      paint("one\ntwo");
      return undefined;
    }, surface);
    expect(frames).toEqual(["one\ntwo"]);
    expect(erased).toBe(true);
    // Nothing reached the terminal directly — the default overlay painter never ran.
    expect(terminal.written).toEqual([]);
  });
});

describe("a feature key pressed while something is already typed", () => {
  /** A real readline over fake pipes: the line-editing behaviour under test is readline's own. */
  function typing() {
    const input = new PassThrough() as unknown as NodeJS.ReadStream & PassThrough;
    const output = new PassThrough() as unknown as NodeJS.WriteStream & PassThrough;
    Object.assign(output, { columns: 80, rows: 24, isTTY: true });
    Object.assign(input, { isTTY: true, setRawMode: () => input });
    const readline = createInterface({ input, output, terminal: true });
    const submitted: string[] = [];
    readline.on("line", (line) => submitted.push(line));
    return { input, output, readline, submitted };
  }

  it("replaces the whole line from any cursor position", async () => {
    // Ctrl+U deletes from the cursor to the *start* of the line, so on its own it clears nothing
    // when the cursor is at column zero and leaves the tail behind when it is mid-line — the
    // command was then prepended to surviving text and submitted as one nonsense line.
    for (const cursor of ["home", "end", "middle"] as const) {
      const session = typing();
      const stop = installShortcuts({
        input: session.input,
        output: session.output as unknown as NodeJS.WriteStream,
        readline: session.readline,
        registry: new KeyBindingRegistry(),
      });
      session.readline.write("write a test for the parser");
      if (cursor === "home") session.readline.write(null, { name: "home" });
      if (cursor === "middle") for (let step = 0; step < 10; step += 1) session.readline.write(null, { name: "left" });

      // Ctrl+A: the registry's /auto, and the exact key readline moves to column zero for.
      session.input.emit("keypress", "\x01", { name: "a", ctrl: true });
      await new Promise((resolve) => setImmediate(resolve));
      stop();

      expect(session.submitted).toEqual(["/auto"]);
      session.readline.close();
    }
  });

  it("submits a bound command together with its argument", async () => {
    // "/tab next" is one action from the user's point of view. Submitting only "/tab" would open the
    // tab menu instead of switching tabs — a shortcut that lands somewhere adjacent to its label.
    const session = typing();
    const stop = installShortcuts({
      input: session.input,
      output: session.output as unknown as NodeJS.WriteStream,
      readline: session.readline,
      registry: new KeyBindingRegistry(),
    });
    session.readline.write("half a thought");
    session.input.emit("keypress", undefined, { name: "right", meta: true });
    await new Promise((resolve) => setImmediate(resolve));
    stop();
    expect(session.submitted).toEqual(["/tab next"]);
    session.readline.close();
  });

  it("does not fire on a bare letter, because this prompt is where free text is typed", async () => {
    const session = typing();
    const stop = installShortcuts({
      input: session.input,
      output: session.output as unknown as NodeJS.WriteStream,
      readline: session.readline,
      registry: new KeyBindingRegistry(),
    });
    session.readline.write("auto-detect the framework");
    session.input.emit("keypress", "a", { name: "a" });
    session.input.emit("keypress", "w", { name: "w" });
    await new Promise((resolve) => setImmediate(resolve));
    stop();
    expect(session.submitted).toEqual([]);
    session.readline.close();
  });

  /**
   * A suggestion row is a whole line, not a completion of the partial one.
   *
   * Accepting one used to be a bare `write(chosen + "\n")`, which readline inserts *at the cursor* —
   * so the "/" or "/au" that opened the list survived and the shell was handed "//auto". The prefix
   * is invisible in the dropup, so the only evidence was the error afterwards.
   */
  it.each([
    ["/", "/auto"],
    ["/au", "/auto"],
    ["", "/auto"],
    ["/model ", "/model claude-sonnet-5"],
  ])("replaces the typed prefix %j when a suggestion is accepted", (typed, chosen) => {
    const session = typing();
    session.readline.write(typed);
    replaceLine(session.readline, chosen);
    session.readline.write("\n");
    expect(session.submitted).toEqual([chosen]);
    session.readline.close();
  });

  it("replaces the prefix even when the cursor is not at the end of it", () => {
    // Left-arrowing back into "/mod" and then browsing is ordinary editing, and Ctrl+U alone would
    // have left the tail behind — "/auto" submitted as "/autod".
    const session = typing();
    session.readline.write("/mod");
    session.readline.write(null, { name: "left" });
    replaceLine(session.readline, "/auto");
    session.readline.write("\n");
    expect(session.submitted).toEqual(["/auto"]);
    session.readline.close();
  });
});
