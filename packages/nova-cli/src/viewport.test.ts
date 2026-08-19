import { describe, expect, it } from "vitest";
import { applyViewport, atBottom, atTop, maxTop, newViewport, scrollFraction, visibleLines, type ViewportAction, type ViewportState } from "./viewport";

const content = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`);
const actions: ViewportAction[] = [
  { kind: "up" }, { kind: "down" }, { kind: "halfUp" }, { kind: "halfDown" },
  { kind: "pageUp" }, { kind: "pageDown" }, { kind: "top" }, { kind: "bottom" },
  { kind: "up", rows: 40 }, { kind: "down", rows: 40 },
];

describe("viewport", () => {
  it("never scrolls out of range, whatever sequence of keys arrives", () => {
    let state = newViewport(content(50), 10);
    for (let step = 0; step < 300; step += 1) {
      state = applyViewport(state, actions[step % actions.length]);
      expect(state.top).toBeGreaterThanOrEqual(0);
      expect(state.top).toBeLessThanOrEqual(maxTop(state));
      expect(visibleLines(state).length).toBeLessThanOrEqual(state.height);
    }
  });

  it("can always reach the very last line", () => {
    for (const [lines, height] of [[50, 10], [11, 10], [10, 10], [3, 10], [0, 10], [1, 1]]) {
      const state = applyViewport(newViewport(content(lines), height), { kind: "bottom" });
      const shown = visibleLines(state);
      if (lines === 0) expect(shown).toEqual([]);
      else expect(shown.at(-1)).toBe(`line ${lines - 1}`);
    }
  });

  it("shows the whole of a page that fits, and calls that both top and bottom", () => {
    const state = newViewport(content(4), 10);
    expect(visibleLines(state)).toHaveLength(4);
    expect(maxTop(state)).toBe(0);
    expect(atTop(state)).toBe(true);
    expect(atBottom(state)).toBe(true);
    expect(scrollFraction(state)).toBe(1);
    expect(applyViewport(state, { kind: "pageDown" }).top).toBe(0);
  });

  it("keeps one row of overlap across a page, so the seam is readable", () => {
    const state = applyViewport(newViewport(content(100), 10), { kind: "pageDown" });
    expect(state.top).toBe(9);
    expect(visibleLines(state)[0]).toBe("line 9");
    // ...and back again lands where it started.
    expect(applyViewport(state, { kind: "pageUp" }).top).toBe(0);
  });

  it("moves half a screen when asked for half a screen", () => {
    const state = applyViewport(newViewport(content(100), 10), { kind: "halfDown" });
    expect(state.top).toBe(5);
    expect(applyViewport(state, { kind: "halfUp" }).top).toBe(0);
  });

  it("holds the reader's place when the terminal is resized, and never goes out of range doing it", () => {
    let state: ViewportState = newViewport(content(40), 10);
    state = applyViewport(state, { kind: "bottom" });
    expect(state.top).toBe(30);

    state = applyViewport(state, { kind: "resize", height: 30 });
    expect(state.top).toBe(10); // clamped to the new furthest position
    expect(visibleLines(state).at(-1)).toBe("line 39");

    state = applyViewport(state, { kind: "resize", height: 5 });
    expect(state.top).toBe(10); // unchanged: the top of the window is the anchor
    expect(visibleLines(state)[0]).toBe("line 10");
  });

  it("does not yank a reader who scrolled up when new content arrives, unless following", () => {
    const state = newViewport(content(50), 10);
    const parked = applyViewport(state, { kind: "down", rows: 5 });

    const grown = applyViewport(parked, { kind: "content", lines: content(80) });
    expect(grown.top).toBe(5);

    const tailing = applyViewport(parked, { kind: "content", lines: content(80), follow: true });
    expect(tailing.top).toBe(70);
    expect(atBottom(tailing)).toBe(true);
  });

  it("clamps when content shrinks out from under the window", () => {
    const state = applyViewport(newViewport(content(100), 10), { kind: "bottom" });
    const shrunk = applyViewport(state, { kind: "content", lines: content(12) });
    expect(shrunk.top).toBe(2);
    expect(visibleLines(shrunk).at(-1)).toBe("line 11");
  });

  it("reports position as a fraction a scroll indicator can render", () => {
    const state = newViewport(content(110), 10);
    expect(scrollFraction(state)).toBe(0);
    expect(scrollFraction(applyViewport(state, { kind: "bottom" }))).toBe(1);
    expect(scrollFraction(applyViewport(state, { kind: "down", rows: 50 }))).toBeCloseTo(0.5, 2);
  });

  it("survives a height of zero or less rather than dividing the screen by it", () => {
    const state = newViewport(content(10), 0);
    expect(state.height).toBe(1);
    expect(visibleLines(state)).toEqual(["line 0"]);
  });
});
