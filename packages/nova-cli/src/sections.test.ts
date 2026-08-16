import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import { clip, heading, keyValues, note, outcomeMark, panel, rule, type SectionStyle } from "./sections";
import { buildPalette, findBuiltinTheme } from "./theme";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 60): SectionStyle => ({ width, depth: "none" });

describe("rules", () => {
  it("never draws wider than the terminal it was given, at any width", () => {
    for (const width of [8, 20, 40, 80, 200]) {
      for (const label of [undefined, "tests", "a rather long section label"]) {
        const line = plain(rule({ width, depth: "none" }, label ? { label } : {}));
        expect(visibleWidth(line), `width ${width} label ${label}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("stays within the width even when both the label and the trailing summary are long", () => {
    for (const width of [10, 24, 60]) {
      const line = plain(rule({ width, depth: "none" }, {
        label: "an extremely long section label that nobody would type",
        trailing: "412 tests · 3 failed · 12 skipped · 41.2s",
      }));
      expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("puts the label at the left, where an eye scanning a transcript is already looking", () => {
    const line = plain(rule(style(), { label: "failures" }));
    expect(line.indexOf("failures")).toBeLessThan(6);
  });

  it("carries a trailing summary on the same rule, so totals need no line of their own", () => {
    const line = plain(rule(style(), { label: "passed", trailing: "12 tests · 1.2s" }));
    expect(line).toContain("passed");
    expect(line).toContain("12 tests");
    expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("draws with the caller's glyph set, so an ASCII terminal gets no box-drawing characters", () => {
    const line = rule({ width: 40, depth: "none", glyphs: ASCII_GLYPHS }, { label: "tests" });
    expect(line).toContain("-");
    expect(line).not.toContain(UNICODE_GLYPHS.boxHorizontal);
  });

  it("emits no escape codes when the destination cannot show colour", () => {
    expect(rule(style(), { label: "x", tone: "bad" })).not.toContain("\x1b[");
  });
});

describe("hierarchy", () => {
  it("gives level 1 its own underline rule and the quieter levels none", () => {
    expect(heading("Big", 1, style()).split("\n")).toHaveLength(2);
    expect(heading("Medium", 2, style()).split("\n")).toHaveLength(1);
    expect(heading("Small", 3, style()).split("\n")).toHaveLength(1);
  });

  it("indents a note past the heading it belongs to, which is what makes it read as subordinate", () => {
    const parent = heading("Section", 2, style());
    const child = note("detail", style());
    const indent = (line: string) => line.length - line.trimStart().length;
    expect(indent(child)).toBeGreaterThan(indent(parent));
  });

  it("aligns a key/value block on one column so the values form a readable second column", () => {
    const rendered = plain(keyValues([["short", "1"], ["much longer key", "2"]], style())).split("\n");
    expect(rendered[0].indexOf("1")).toBe(rendered[1].indexOf("2"));
  });
});

describe("panels", () => {
  it("draws every row to the same width, so the right border is actually a line", () => {
    const rendered = plain(panel(["a", "much longer line here", ""], style(60))).split("\n");
    const widths = new Set(rendered.map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });

  it("stays inside the terminal even when the content is far wider than it", () => {
    const rendered = plain(panel(["x".repeat(500)], style(40))).split("\n");
    for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("keeps the gutter form to a single edge, for content that should read as quoted, not framed", () => {
    const rendered = plain(panel(["one", "two"], style(), { gutterOnly: true })).split("\n");
    expect(rendered).toHaveLength(2);
    expect(rendered.every((line) => line.includes("one") || line.includes("two"))).toBe(true);
  });

  it("shows the title and the badge on the top border rather than stealing a content row", () => {
    const rendered = plain(panel(["body"], style(), { title: "src/app.ts", badge: "+3 -1" })).split("\n");
    expect(rendered[0]).toContain("src/app.ts");
    expect(rendered[0]).toContain("+3 -1");
    expect(rendered).toHaveLength(3);
  });

  it("draws round corners with no theme, matching every panel before themes carried a border style", () => {
    const rendered = plain(panel(["x"], style()));
    expect(rendered).toContain("╭");
    expect(rendered).toContain("╯");
  });

  it("draws the corners the active theme actually asks for, not a fixed shape", () => {
    // nebula asks for a single-line border; starry-night (the default) asks for round.
    const nebula = buildPalette(findBuiltinTheme("nebula")!, "none");
    const starryNight = buildPalette(findBuiltinTheme("starry-night")!, "none");
    const single = plain(panel(["x"], { ...style(), palette: nebula }));
    const round = plain(panel(["x"], { ...style(), palette: starryNight }));
    expect(single).toContain("┌");
    expect(single).not.toContain("╭");
    expect(round).toContain("╭");
    expect(round).not.toContain("┌");
  });

  it("never draws a themed border character outside the ASCII set on an ASCII terminal", () => {
    const nebula = buildPalette(findBuiltinTheme("nebula")!, "none");
    const rendered = plain(panel(["x"], { ...style(), palette: nebula, glyphs: ASCII_GLYPHS }));
    for (const character of rendered) expect(character.codePointAt(0)).toBeLessThan(128);
  });
});

describe("clipping", () => {
  it("never returns more columns than asked for, and marks the cut", () => {
    const clipped = clip("abcdefghij", 5);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(5);
    expect(clipped.endsWith("…")).toBe(true);
  });

  it("leaves text that already fits completely untouched", () => {
    expect(clip("abc", 10)).toBe("abc");
  });

  it("closes the colour it clipped inside, so the rest of the line is not painted by accident", () => {
    const clipped = clip(`\x1b[32m${"a".repeat(40)}\x1b[0m`, 10);
    expect(clipped.endsWith("\x1b[0m")).toBe(true);
    expect(visibleWidth(clipped)).toBeLessThanOrEqual(10);
  });

  it("counts a wide character as the two columns it occupies", () => {
    expect(visibleWidth(clip("日本語のテキスト", 6))).toBeLessThanOrEqual(6);
  });
});

describe("outcome marks", () => {
  it("uses one mark per outcome, and different marks for pass and fail", () => {
    const pass = plain(outcomeMark("pass", style()));
    const fail = plain(outcomeMark("fail", style()));
    expect(pass).not.toBe(fail);
  });

  it("falls back with the glyph set rather than emitting a character the terminal cannot draw", () => {
    const mark = outcomeMark("fail", { width: 40, depth: "none", glyphs: ASCII_GLYPHS });
    expect(mark).toBe(ASCII_GLYPHS.cross);
  });
});
