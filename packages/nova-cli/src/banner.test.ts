import { describe, expect, it } from "vitest";
import { detectColorDepth, renderBanner, renderTagline } from "./banner";

const ESCAPE = /\[[0-9;]*m/g;
const plain = (value: string) => value.replace(ESCAPE, "");

describe("colour detection", () => {
  it("prints plain text where colour would be wrong", () => {
    // Piping into a file and getting escape codes back is a small betrayal of every pipeline.
    expect(detectColorDepth({}, false)).toBe("none");
    expect(detectColorDepth({ NO_COLOR: "1" }, true)).toBe("none");
    expect(detectColorDepth({ TERM: "dumb" }, true)).toBe("none");
  });

  it("uses the deepest colour the terminal actually claims", () => {
    expect(detectColorDepth({ COLORTERM: "truecolor" }, true)).toBe("truecolor");
    expect(detectColorDepth({ COLORTERM: "24bit" }, true)).toBe("truecolor");
    expect(detectColorDepth({ TERM: "xterm-256color" }, true)).toBe("ansi256");
  });
});

describe("banner", () => {
  it("keeps the wordmark column-aligned whatever the sky does around it", () => {
    // The stars beside the letters are drawn into a fixed-width margin. When that width varied,
    // each row started at a different column and the letterforms sheared apart.
    for (const seed of [1, 42, 20260808, 999_331]) {
      const rows = plain(renderBanner({ width: 88, depth: "none", seed })).split("\n").filter((line) => line.includes("█"));
      expect(rows.length).toBe(5);
      const starts = new Set(rows.map((row) => row.indexOf("█")));
      expect(starts.size, `seed ${seed}`).toBe(1);
    }
  });

  it("spells NOVA and never exceeds the terminal width", () => {
    const width = 80;
    const lines = plain(renderBanner({ width, depth: "none", subtitle: "build mode · project", seed: 7 })).split("\n");
    expect(lines.some((line) => line.includes("███╗   ██╗"))).toBe(true);
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(width);
  });

  it("falls back to one line when the window is too narrow to draw block letters", () => {
    const narrow = renderBanner({ width: 30, depth: "none", subtitle: "plan mode", seed: 7 });
    expect(narrow.split("\n")).toHaveLength(1);
    expect(narrow).toContain("NOVA");
    expect(narrow).toContain("plan mode");
  });

  it("emits truecolor, 256-colour or nothing, matching what was asked for", () => {
    expect(renderBanner({ width: 88, depth: "truecolor", seed: 3 })).toContain("[38;2;");
    const ansi = renderBanner({ width: 88, depth: "ansi256", seed: 3 });
    expect(ansi).toContain("[38;5;");
    expect(ansi).not.toContain("[38;2;");
    expect(renderBanner({ width: 88, depth: "none", seed: 3 })).not.toMatch(ESCAPE);
  });

  it("draws the same sky for the same seed, so a redraw does not flicker", () => {
    expect(renderBanner({ width: 88, depth: "none", seed: 11 })).toBe(renderBanner({ width: 88, depth: "none", seed: 11 }));
    expect(renderBanner({ width: 88, depth: "none", seed: 11 })).not.toBe(renderBanner({ width: 88, depth: "none", seed: 12 }));
  });

  it("colours the tagline only when colour is wanted", () => {
    expect(renderTagline("/help", "none")).toBe("/help");
    expect(renderTagline("/help", "truecolor")).toContain("[38;2;");
  });
});

describe("the sky settling in", () => {
  it("defaults to fully lit, identical to never passing intensity at all", () => {
    expect(renderBanner({ width: 88, depth: "truecolor", seed: 11 }))
      .toBe(renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 1 }));
  });

  it("never moves a star or reshapes the wordmark — only intensity changes, positions do not", () => {
    // Stripped of colour, an unlit sky and a fully lit one must draw the exact same characters in
    // the exact same places: intensity is a colour blend, not a second source of randomness.
    const dim = plain(renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 0 }));
    const bright = plain(renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 1 }));
    expect(dim).toBe(bright);
  });

  it("draws no colour at all differently by intensity when colour itself is off", () => {
    // paint() is already a no-op at depth "none" — dimming a colour that is never emitted cannot
    // show up in the output, and the whole animation is pointless work on a terminal with no colour.
    expect(renderBanner({ width: 88, depth: "none", seed: 11, intensity: 0 }))
      .toBe(renderBanner({ width: 88, depth: "none", seed: 11, intensity: 1 }));
  });

  it("blends a star's colour toward the dim anchor at low intensity, away from it as intensity rises", () => {
    const colorOf = (rendered: string) => [...rendered.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((match) => match.slice(1).map(Number));
    const low = colorOf(renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 0.1 }));
    const high = colorOf(renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 0.9 }));
    expect(low.length).toBe(high.length); // same stars exist at both intensities
    // The first two lines of sky are pure stars, with no letterform sharing the row.
    const firstColorLow = low[0];
    const firstColorHigh = high[0];
    // A low-intensity star sits closer to the dim anchor (10,14,26) than the same star at high
    // intensity does — the exact blend depends on which star it is, but the direction cannot be wrong.
    const distance = (color: number[], anchor: number[]) => color.reduce((sum, value, index) => sum + Math.abs(value - anchor[index]), 0);
    const anchor = [10, 14, 26];
    expect(distance(firstColorLow, anchor)).toBeLessThan(distance(firstColorHigh, anchor));
  });

  it("never dims the wordmark itself, even at zero intensity", () => {
    // Identity comes first: the letters must read immediately, only the sky around them settles in.
    const dim = renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 0 });
    const bright = renderBanner({ width: 88, depth: "truecolor", seed: 11, intensity: 1 });
    const wordmarkLine = (rendered: string) => rendered.split("\n").find((line) => line.includes("███╗   ██╗"));
    expect(wordmarkLine(dim)).toBe(wordmarkLine(bright));
  });
});

describe("the wordmark's gradient", () => {
  const colorsIn = (rendered: string) => [...rendered.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].map((m) => m.slice(1).map(Number));
  const stripped = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
  /** The wordmark's first row, found by what it *reads* as — the gradient now interleaves escapes between its characters. */
  const wordmarkRow = () => renderBanner({ width: 88, depth: "truecolor", seed: 11 })
    .split("\n").find((line) => stripped(line).includes("███╗   ██╗"))!;

  it("sweeps colour across a row rather than painting the whole row one flat colour", () => {
    const row = wordmarkRow();
    // More than one distinct colour on a single row is the whole point of the change.
    expect(new Set(colorsIn(row).map((c) => c.join(","))).size).toBeGreaterThan(1);
  });

  it("still emits nothing at all when colour is off", () => {
    expect(renderBanner({ width: 88, depth: "none", seed: 11 })).not.toMatch(/\x1b\[/);
  });

  it("uses 256-colour codes rather than truecolor ones on a 256-colour terminal", () => {
    const ansi = renderBanner({ width: 88, depth: "ansi256", seed: 11 });
    expect(ansi).toContain("\x1b[38;5;");
    expect(ansi).not.toContain("\x1b[38;2;");
  });

  it("leaves the letterforms themselves untouched — only their colour changes", () => {
    const plainOf = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plainOf(renderBanner({ width: 88, depth: "truecolor", seed: 11 })))
      .toBe(plainOf(renderBanner({ width: 88, depth: "none", seed: 11 })));
  });

  it("does not open a colour run around a blank cell, which would be bytes for nothing", () => {
    const row = wordmarkRow();
    // Every colour code must be immediately followed by something that is not a space.
    for (const match of row.matchAll(/38;2;\d+;\d+;\d+m(.)/g)) expect(match[1]).not.toBe(" ");
  });
});
