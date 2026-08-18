import { describe, expect, it } from "vitest";
import { sendsOnKey } from "./composer";

/**
 * What a key in the composer means.
 *
 * The rule was inverted: only `Ctrl/Cmd+Enter` sent, so a question typed and submitted the obvious
 * way — Enter — inserted a line break and went nowhere. The reader got no error and no message,
 * which reads as the app being broken rather than as the wrong chord.
 */
describe("the composer's Enter key", () => {
  it("sends on a plain Enter, which is what every chat app does", () => {
    expect(sendsOnKey({ key: "Enter" })).toBe(true);
  });

  it("inserts a newline on Shift+Enter rather than sending", () => {
    expect(sendsOnKey({ key: "Enter", shiftKey: true })).toBe(false);
  });

  it("still sends on the documented Ctrl and Cmd chords, since fingers learn them", () => {
    expect(sendsOnKey({ key: "Enter", ctrlKey: true })).toBe(true);
    expect(sendsOnKey({ key: "Enter", metaKey: true })).toBe(true);
  });

  /**
   * An IME composing Japanese, Chinese or Korean uses Enter to *commit the candidate*. Sending on
   * that Enter submits a half-finished word and eats the keystroke the writer meant for the IME.
   */
  it("never sends while an input method is mid-composition", () => {
    expect(sendsOnKey({ key: "Enter", isComposing: true })).toBe(false);
    expect(sendsOnKey({ key: "Enter", isComposing: true, ctrlKey: true })).toBe(false);
  });

  it("ignores every other key", () => {
    for (const key of ["a", "Tab", "Escape", "ArrowUp", " "]) {
      expect(sendsOnKey({ key }), key).toBe(false);
    }
  });
});
