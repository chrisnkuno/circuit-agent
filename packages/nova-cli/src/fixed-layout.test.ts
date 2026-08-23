import { describe, expect, it } from "vitest";
import {
  appendLines,
  bodyHeight,
  newFixedLayout,
  renderFrame,
  resize,
  scroll,
  search,
  stepSearch,
  transcriptText,
  wrapToWidth,
} from "./fixed-layout";

const lines = (count: number, prefix = "line") =>
  Array.from({ length: count }, (_, index) => `${prefix} ${index}`);

describe("the transcript Nova keeps for itself", () => {
  it("shows the newest output, and keeps showing it as more arrives", () => {
    let state = newFixedLayout({ columns: 40, rows: 10 });
    state = appendLines(state, lines(30));
    expect(renderFrame(state).body.at(-1)).toBe("line 29");
    state = appendLines(state, ["line 30"]);
    expect(renderFrame(state).body.at(-1)).toBe("line 30");
    expect(renderFrame(state).following).toBe(true);
  });

  it("never yanks a reader who scrolled up back down to the tail", () => {
    // The single most common way a fixed-layout TUI becomes unbearable: you scroll up to read an
    // error, output arrives, and you are thrown back to the bottom mid-sentence.
    let state = newFixedLayout({ columns: 40, rows: 12 });
    state = appendLines(state, lines(60));
    state = scroll(state, { kind: "pageUp" });
    const before = renderFrame(state).body[0];

    state = appendLines(state, lines(20, "later"));
    expect(renderFrame(state).body[0]).toBe(before);
    expect(renderFrame(state).following).toBe(false);

    // Returning to the bottom starts following again.
    state = scroll(state, { kind: "bottom" });
    state = appendLines(state, ["newest"]);
    expect(renderFrame(state).body.at(-1)).toBe("newest");
    expect(renderFrame(state).following).toBe(true);
  });

  it("fills the body so the frame never collapses on short content", () => {
    const state = appendLines(newFixedLayout({ columns: 40, rows: 20 }), [
      "only line",
    ]);
    const frame = renderFrame(state);
    expect(frame.body).toHaveLength(bodyHeight(20, 3));
    expect(frame.body[0]).toBe("only line");
    expect(frame.body.at(-1)).toBe("");
  });

  it("survives a terminal too small to have a body at all", () => {
    // A frame that computes a negative height crashes or paints nothing, and both look like Nova
    // died rather than like the window is small.
    let state = newFixedLayout({ columns: 20, rows: 2, chrome: 5 });
    state = appendLines(state, lines(10));
    expect(renderFrame(state).body).toHaveLength(1);
    expect(bodyHeight(2, 5)).toBe(1);
  });
});

describe("re-flowing when the terminal changes shape", () => {
  it("re-wraps to the new width instead of truncating", () => {
    let state = newFixedLayout({ columns: 80, rows: 12 });
    state = appendLines(state, ["x".repeat(100)]);
    expect(state.viewport.lines).toHaveLength(2);

    state = resize(state, 20, 12);
    // The same logical line, re-flowed: the buffer keeps logical lines so width can change freely.
    expect(state.viewport.lines).toHaveLength(5);
    expect(state.buffer).toEqual(["x".repeat(100)]);
  });

  it("keeps following the tail across a resize when it was following", () => {
    let state = newFixedLayout({ columns: 80, rows: 12 });
    state = appendLines(state, lines(50));
    state = resize(state, 40, 20);
    expect(renderFrame(state).body.at(-1)).toBe("line 49");
    expect(renderFrame(state).following).toBe(true);
  });

  it("wraps by visible width, so styled text breaks where it looks like it should", () => {
    const styled = `\u001b[31m${"a".repeat(30)}\u001b[0m`;
    const wrapped = wrapToWidth([styled], 10);
    expect(wrapped).toHaveLength(3);
    // The colour escape rides with the first slice rather than being counted as three columns.
    expect(wrapped[0]).toContain("\u001b[31m");
  });

  it("keeps blank lines, because they are the paragraph breaks in a transcript", () => {
    expect(wrapToWidth(["one", "", "two"], 20)).toEqual(["one", "", "two"]);
  });
});

describe("when history outgrows the buffer", () => {
  it("drops the oldest lines without moving what the reader is looking at", () => {
    // Dropping from the front shifts every row under the reader unless it is compensated.
    let state = newFixedLayout({ columns: 40, rows: 12, maxBufferLines: 100 });
    state = appendLines(state, lines(100));
    state = scroll(state, { kind: "top" });
    state = scroll(state, { kind: "down", rows: 20 });
    const before = renderFrame(state).body[0];

    state = appendLines(state, lines(10, "extra"));
    expect(renderFrame(state).body[0]).toBe(before);
    expect(state.buffer).toHaveLength(100);
  }, 15_000); // Windows runners occasionally pause busy workers beyond Vitest's 5s default.

  it("says how much history it dropped, and says nothing when it dropped none", () => {
    let state = newFixedLayout({ columns: 40, rows: 12, maxBufferLines: 50 });
    state = appendLines(state, lines(50));
    expect(renderFrame(state).truncated).toBeUndefined();

    state = appendLines(state, lines(10, "extra"));
    expect(renderFrame(state).truncated).toMatch(/10 earlier lines/);
  });
});

describe("searching the transcript Nova now owns", () => {
  const withContent = () =>
    appendLines(newFixedLayout({ columns: 40, rows: 12 }), [
      ...lines(40),
      "TypeError: cannot read property",
      ...lines(40, "after"),
      "TypeError: again",
      ...lines(40, "tail"),
    ]);

  it("finds every match and puts the first one on screen with its context", () => {
    const state = search(withContent(), "typeerror");
    expect(state.search?.matches).toHaveLength(2);
    expect(renderFrame(state).body.join("\n")).toContain(
      "TypeError: cannot read property",
    );
    expect(renderFrame(state).position).toContain("1/2");
  });

  it("steps forward and back, wrapping around rather than stopping at the end", () => {
    let state = search(withContent(), "TypeError");
    state = stepSearch(state, 1);
    expect(renderFrame(state).body.join("\n")).toContain("TypeError: again");

    state = stepSearch(state, 1);
    // Wrapped back to the first: a search that stops at the end is one you repeat by hand.
    expect(state.search?.index).toBe(0);
    state = stepSearch(state, -1);
    expect(state.search?.index).toBe(1);
  });

  it("treats the query as text, not as a pattern", () => {
    // Someone searching a transcript for "call(" is not writing a regular expression.
    const state = appendLines(newFixedLayout({ columns: 60, rows: 12 }), [
      "call(arg)",
      "no parens here",
    ]);
    expect(search(state, "call(").search?.matches).toHaveLength(1);
  });

  it("says plainly when there is no match, and clears on an empty query", () => {
    const missing = search(withContent(), "nothing-like-this");
    expect(missing.search?.matches).toHaveLength(0);
    expect(renderFrame(missing).position).toContain("no match");
    expect(search(missing, "  ").search).toBeNull();
  });

  it("ignores styling when matching, so a coloured error is still findable", () => {
    const state = appendLines(newFixedLayout({ columns: 60, rows: 12 }), [
      `\u001b[31mTypeError\u001b[0m: boom`,
    ]);
    expect(search(state, "TypeError: boom").search?.matches).toHaveLength(1);
  });
});

describe("handing the transcript to something better at text", () => {
  it("exports logical lines, not the ones wrapped for this window", () => {
    // A pager wraps to its own width; re-wrapping already-wrapped text gives a ragged margin.
    const state = appendLines(newFixedLayout({ columns: 20, rows: 10 }), [
      "x".repeat(100),
      "second",
    ]);
    expect(transcriptText(state)).toBe(`${"x".repeat(100)}\nsecond`);
  });

  it("says up front when history is missing, rather than quietly handing over a partial file", () => {
    let state = newFixedLayout({ columns: 40, rows: 10, maxBufferLines: 5 });
    state = appendLines(state, lines(20));
    const text = transcriptText(state);
    expect(text.split("\n")[0]).toMatch(
      /15 earlier lines are not in this view/,
    );
    expect(text).toContain("line 19");
  });

  it("says nothing about truncation when nothing was truncated", () => {
    const state = appendLines(newFixedLayout({ columns: 40, rows: 10 }), [
      "one",
      "two",
    ]);
    expect(transcriptText(state)).toBe("one\ntwo");
  });
});
