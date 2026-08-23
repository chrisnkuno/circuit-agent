import { describe, expect, it } from "vitest";
import {
  BEGIN_SYNC,
  DISABLE_MOUSE,
  ENABLE_MOUSE,
  END_SYNC,
  ENTER_ALTERNATE_SCREEN,
  FixedScreen,
  LEAVE_ALTERNATE_SCREEN,
  SHOW_CURSOR,
  decodeFixedKey,
  fixedStatusLine,
  frameSequence,
  openInPager,
} from "./fixed-screen";

function recorder() {
  const written: string[] = [];
  return { stream: { write: (text: string) => written.push(text) }, written, all: () => written.join("") };
}

describe("holding the alternate screen", () => {
  it("enters once, however many times it is asked", () => {
    const sink = recorder();
    const screen = new FixedScreen(sink.stream);
    screen.enter();
    screen.enter();
    expect(sink.written).toHaveLength(1);
    expect(sink.all()).toContain(ENTER_ALTERNATE_SCREEN);
    expect(screen.isEntered).toBe(true);
  });

  it("gives the terminal back, and is safe to ask twice", () => {
    // Called from the ordinary exit, from signal handlers, and from failure paths — any of which
    // may run after another. A missed leave is a terminal the user has to reset by hand.
    const sink = recorder();
    const screen = new FixedScreen(sink.stream);
    screen.enter();
    screen.leave();
    screen.leave();
    expect(sink.written).toHaveLength(2);
    const restore = sink.written[1];
    expect(restore).toContain(SHOW_CURSOR);
    expect(restore).toContain(LEAVE_ALTERNATE_SCREEN);
    expect(screen.isEntered).toBe(false);
  });

  it("never writes anything when it was never entered", () => {
    const sink = recorder();
    new FixedScreen(sink.stream).leave();
    expect(sink.written).toEqual([]);
  });

  it("takes the mouse only when asked, and always hands it back", () => {
    // Mouse reporting removes drag-to-select, so it is a setting rather than an assumption.
    const off = recorder();
    const plain = new FixedScreen(off.stream);
    plain.enter();
    plain.leave();
    expect(off.all()).not.toContain(ENABLE_MOUSE);

    const on = recorder();
    const wheeled = new FixedScreen(on.stream, { mouse: true });
    wheeled.enter();
    expect(on.all()).toContain(ENABLE_MOUSE);
    wheeled.leave();
    expect(on.all()).toContain(DISABLE_MOUSE);
  });
});

describe("painting a frame", () => {
  it("wraps the whole frame in one synchronized update", () => {
    // A frame painted row by row into a terminal also receiving streamed output tears visibly.
    const sequence = frameSequence(["one", "two"]);
    expect(sequence.startsWith(BEGIN_SYNC)).toBe(true);
    expect(sequence.endsWith(END_SYNC)).toBe(true);
  });

  it("addresses each row and clears it in place, rather than erasing the screen first", () => {
    // Erase-then-draw shows an empty frame for one paint, which reads as a flicker per keystroke.
    const sequence = frameSequence(["alpha", "beta", "gamma"]);
    expect(sequence).toContain("\u001b[1;1Halpha\u001b[K");
    expect(sequence).toContain("\u001b[2;1Hbeta\u001b[K");
    expect(sequence).toContain("\u001b[3;1Hgamma\u001b[K");
    expect(sequence).not.toContain("\u001b[2J");
  });

  it("paints an empty frame without emitting nonsense", () => {
    expect(frameSequence([])).toBe(`${BEGIN_SYNC}${END_SYNC}`);
  });
});

describe("what a key means to the transcript window", () => {
  it("reads the keys the composer has no use for", () => {
    expect(decodeFixedKey("\u001b[5~")).toEqual({ kind: "pageUp" });
    expect(decodeFixedKey("\u001b[6~")).toEqual({ kind: "pageDown" });
    expect(decodeFixedKey("\u001b[H")).toEqual({ kind: "top" });
    expect(decodeFixedKey("\u001b[F")).toEqual({ kind: "bottom" });
  });

  it("puts everything else on Alt, because a bare letter is text someone is typing", () => {
    expect(decodeFixedKey("\u001bf")).toEqual({ kind: "search" });
    expect(decodeFixedKey("\u001bn")).toEqual({ kind: "searchNext" });
    expect(decodeFixedKey("\u001bp")).toEqual({ kind: "searchPrev" });
    expect(decodeFixedKey("\u001bo")).toEqual({ kind: "openPager" });
    // The bare letters stay text.
    for (const letter of ["f", "n", "p", "o"]) expect(decodeFixedKey(letter), letter).toBeNull();
  });

  it("scrolls a line at a time on Alt+arrow, leaving the arrows for history recall", () => {
    expect(decodeFixedKey("\u001b\u001b[A")).toEqual({ kind: "up", rows: 1 });
    expect(decodeFixedKey("\u001b[1;3B")).toEqual({ kind: "down", rows: 1 });
    expect(decodeFixedKey("\u001b[A")).toBeNull();
    expect(decodeFixedKey("\u001b[B")).toBeNull();
  });

  it("reads the wheel three rows at a time, and ignores every other mouse event", () => {
    expect(decodeFixedKey("\u001b[<64;10;20M")).toEqual({ kind: "up", rows: 3 });
    expect(decodeFixedKey("\u001b[<65;10;20M")).toEqual({ kind: "down", rows: 3 });
    // A click, a drag, a release: guessing at these is how a TUI scrolls when you select text.
    for (const button of [0, 1, 2, 32, 35]) {
      expect(decodeFixedKey(`\u001b[<${button};5;5M`), String(button)).toBeNull();
    }
  });

  it("hands anything it does not recognise back to the composer", () => {
    for (const sequence of ["", "a", "hello", "\u001b[999~", ""]) {
      expect(decodeFixedKey(sequence), JSON.stringify(sequence)).toBeNull();
    }
  });
});

describe("the status row", () => {
  it("says how to get back to live when you are not, and stays within the width", () => {
    const scrolled = fixedStatusLine({ position: "42%", following: false, columns: 80 });
    expect(scrolled).toContain("42%");
    expect(scrolled).toContain("back to live");
    expect(scrolled.length).toBeLessThanOrEqual(80);
  });

  it("does not explain following, which needs no explanation", () => {
    const live = fixedStatusLine({ position: "live", following: true, columns: 80 });
    expect(live).not.toContain("back to live");
    expect(live).toContain("alt+f find");
  });

  it("survives a terminal too narrow for the help text", () => {
    const narrow = fixedStatusLine({ position: "live", following: true, columns: 12 });
    expect(narrow.length).toBeLessThanOrEqual(12);
  });

  it("keeps the position and help visually separate when both barely fit", () => {
    const narrow = fixedStatusLine({ position: '84% · 10/12 for "TypeError"', following: false, columns: 52 });
    expect(narrow).toContain('"TypeError"   end:');
    expect(narrow.length).toBeLessThanOrEqual(52);
  });

  it("mentions dropped history only when history was dropped", () => {
    expect(fixedStatusLine({ position: "live", following: true, columns: 100, truncated: "500 earlier lines dropped from this view" }))
      .toContain("500 earlier lines");
    expect(fixedStatusLine({ position: "live", following: true, columns: 100 })).not.toContain("dropped");
  });
});

describe("the escape hatch to a real pager", () => {
  it("prefers the pager the user chose", async () => {
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const result = await openInPager("hello", {
      environment: { PAGER: "bat --paging always" },
      spawn: async (command, args) => { calls.push({ command, args }); return 0; },
    });
    expect(result.opened).toBe(true);
    expect(calls[0]).toEqual({ command: "bat", args: ["--paging", "always"] });
  });

  it("falls back to a pager that understands the colours already in the transcript", async () => {
    // Without -R a pager renders every escape sequence as literal noise, which looks like Nova
    // corrupted its own output.
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    await openInPager("hello", { environment: {}, spawn: async (command, args) => { calls.push({ command, args }); return 0; } });
    expect(calls[0]).toEqual({ command: "less", args: ["-R"] });
  });

  it("passes the text through rather than writing a temporary file", async () => {
    let received = "";
    await openInPager("the transcript", { environment: {}, spawn: async (_c, _a, input) => { received = input; return 0; } });
    expect(received).toBe("the transcript");
  });

  it("reports a pager that is missing or fails, instead of appearing to do nothing", async () => {
    const missing = await openInPager("x", {
      environment: {},
      spawn: async () => { throw new Error("spawn less ENOENT"); },
    });
    expect(missing.opened).toBe(false);
    expect(missing.reason).toMatch(/ENOENT/);

    const failed = await openInPager("x", { environment: {}, spawn: async () => 2 });
    expect(failed).toEqual({ opened: false, reason: "less exited 2." });
  });
});
