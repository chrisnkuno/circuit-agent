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
