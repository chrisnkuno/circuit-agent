import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { withBorrowedKeyboard, type KeyboardHost } from "./shortcuts";

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
