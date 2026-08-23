import { describe, expect, it } from "vitest";
import {
  condenseDiff,
  describeChange,
  diffLines,
  diffStat,
  highlightCode,
  languageOf,
  renderCode,
  renderDiff,
  renderFileChange,
} from "./code-view";
import { ASCII_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 72): SectionStyle => ({ width, depth: "none" });

describe("line diff", () => {
  it("reconstructs both sides exactly — the property that makes a diff trustworthy", () => {
    const before = "one\ntwo\nthree\nfour";
    const after = "one\ntwo point five\nthree\nfour\nfive";
    const diff = diffLines(before, after);
    const left = diff.filter((line) => line.kind !== "add").map((line) => line.text).join("\n");
    const right = diff.filter((line) => line.kind !== "remove").map((line) => line.text).join("\n");
    expect(left).toBe(before);
    expect(right).toBe(after);
  });

  it("keeps unchanged lines as context rather than reporting them as churn", () => {
    const diff = diffLines("a\nb\nc", "a\nB\nc");
    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
    expect(diff.filter((line) => line.kind === "context")).toHaveLength(2);
  });

  it("reads a pure insertion as additions only", () => {
    expect(diffStat(diffLines("a\nb", "a\nnew\nb"))).toEqual({ added: 1, removed: 0 });
  });

  it("handles an empty side without inventing a blank line", () => {
    expect(diffStat(diffLines("", "hello"))).toEqual({ added: 1, removed: 0 });
    expect(diffStat(diffLines("hello", ""))).toEqual({ added: 0, removed: 1 });
    expect(diffLines("", "")).toEqual([]);
  });

  it("still reports both sides when the inputs are too large to diff line by line", () => {
    const before = Array.from({ length: 600 }, (_unused, index) => `left ${index}`).join("\n");
    const after = Array.from({ length: 600 }, (_unused, index) => `right ${index}`).join("\n");
    const stat = diffStat(diffLines(before, after));
    expect(stat).toEqual({ added: 600, removed: 600 });
  });
});

describe("condensing", () => {
  it("keeps every change and a little context, and collapses the rest into a gap marker", () => {
    const before = Array.from({ length: 30 }, (_unused, index) => `line ${index}`).join("\n");
    const after = before.replace("line 15", "line fifteen");
    const condensed = condenseDiff(diffLines(before, after));
    expect(condensed.filter((line) => line.kind === "add")).toHaveLength(1);
    expect(condensed.filter((line) => line.kind === "remove")).toHaveLength(1);
    expect(condensed.some((line) => line.kind === "gap")).toBe(true);
    expect(condensed.length).toBeLessThan(30);
  });

  it("leaves a small diff alone, since there is nothing worth hiding", () => {
    const diff = diffLines("a\nb", "a\nc");
    expect(condenseDiff(diff).some((line) => line.kind === "gap")).toBe(false);
  });
});

describe("rendering written code", () => {
  it("numbers the lines, because the next thing anyone says about code is a line number", () => {
    const rendered = plain(renderCode("first\nsecond\nthird", style()).text).split("\n");
    expect(rendered[0]).toMatch(/^1 first/);
    expect(rendered[2]).toMatch(/^3 third/);
  });

  it("folds past the height it was given and reports exactly how much it withheld", () => {
    const content = Array.from({ length: 40 }, (_unused, index) => `line ${index}`).join("\n");
    const rendered = renderCode(content, style(), { maxLines: 10 });
    expect(plain(rendered.text).split("\n")).toHaveLength(10);
    expect(rendered.hidden).toBe(30);
    expect(plain(rendered.full).split("\n")).toHaveLength(40);
  });

  it("keeps every row inside the terminal, however long the source line is", () => {
    const rendered = plain(renderCode(`const x = "${"y".repeat(400)}";`, style(60)).text);
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });

  it("hides nothing when the file is shorter than the fold", () => {
    expect(renderCode("one\ntwo", style(), { maxLines: 10 }).hidden).toBe(0);
  });
});

describe("rendering a diff", () => {
  it("marks additions and removals distinctly in the gutter", () => {
    const rendered = plain(renderDiff(diffLines("a", "b"), style()).text).split("\n");
    expect(rendered.some((line) => line.startsWith("+ b"))).toBe(true);
    expect(rendered.some((line) => line.startsWith("- a"))).toBe(true);
  });

  it("folds a long diff and keeps the whole thing for expansion", () => {
    const before = Array.from({ length: 60 }, (_unused, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 60 }, (_unused, index) => `new ${index}`).join("\n");
    const rendered = renderDiff(diffLines(before, after), style(), { maxLines: 8 });
    expect(plain(rendered.text).split("\n")).toHaveLength(8);
    expect(rendered.hidden).toBeGreaterThan(0);
    expect(plain(rendered.full).split("\n").length).toBeGreaterThan(8);
  });
});

describe("the inline file-change view", () => {
  it("titles the panel with the path and badges a write with its size and language", () => {
    const rendered = plain(renderFileChange({ path: "src/app.ts", kind: "write", content: "const a = 1;" }, style()).text);
    expect(rendered).toContain("new file");
    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain("typescript");
  });

  it("badges an edit with the change it made, not with the file's size", () => {
    const rendered = plain(renderFileChange(
      { path: "src/app.ts", kind: "edit", before: "const a = 1;", after: "const a = 2;\nconst b = 3;" },
      style(),
    ).text);
    expect(rendered).toContain("diff");
    expect(rendered).toContain("+2");
    expect(rendered).toContain("-1");
  });

  it("offers the hint only when something was actually folded", () => {
    const short = renderFileChange({ path: "a.ts", kind: "write", content: "x" }, style(), { expandHint: "/expand" });
    expect(short.hidden).toBe(0);
    expect(plain(short.text)).not.toContain("/expand");

    const long = renderFileChange(
      { path: "a.ts", kind: "write", content: Array.from({ length: 50 }, () => "x").join("\n") },
      style(),
      { maxLines: 5, expandHint: "/expand 1" },
    );
    expect(long.hidden).toBe(45);
    expect(plain(long.text)).toContain("/expand 1");
  });

  it("draws in ASCII when the glyph set says so", () => {
    const rendered = renderFileChange(
      { path: "a.ts", kind: "write", content: "x" },
      { width: 60, depth: "none", glyphs: ASCII_GLYPHS },
    ).text;
    expect(rendered).not.toMatch(/[│╭╮╰╯─]/);
  });
});

describe("highlighting", () => {
  it("changes nothing at all when the destination has no colour", () => {
    const line = 'const greeting = "hello"; // a comment';
    expect(highlightCode(line, "none")).toBe(line);
  });

  it("leaves the visible text identical when it does colour, so widths never drift", () => {
    const line = 'const greeting = "hello"; // a comment';
    expect(plain(highlightCode(line, "truecolor"))).toBe(line);
  });

  it("does not treat a # inside a string as the start of a comment", () => {
    const painted = highlightCode('const url = "https://x/#frag";', "truecolor");
    // The whole string, `#` included, is painted as one run rather than split at the hash.
    expect(plain(painted)).toBe('const url = "https://x/#frag";');
    expect(painted.indexOf("\x1b[2m")).toBe(-1); // no comment styling
  });
});

describe("labels", () => {
  it("names a language from the extension, and falls back to something rather than nothing", () => {
    expect(languageOf("src/app.ts")).toBe("typescript");
    expect(languageOf("main.py")).toBe("python");
    expect(languageOf("Dockerfile")).toBe("dockerfile");
    expect(languageOf("notes")).toBe("text");
  });

  it("summarises a change as the two numbers people actually read", () => {
    expect(plain(describeChange({ added: 3, removed: 1 }, "none"))).toBe("+3 -1");
  });
});
