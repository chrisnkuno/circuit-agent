import { describe, expect, it } from "vitest";
import { computeDiffLines } from "./diff";

describe("computeDiffLines", () => {
  it("says nothing when the two blobs are identical", () => {
    expect(computeDiffLines("a\nb\nc", "a\nb\nc")).toEqual([]);
  });

  it("marks every line of a brand-new file as added", () => {
    const lines = computeDiffLines("", "one\ntwo");
    expect(lines).toEqual(["+ one", "+ two"]);
  });

  it("marks every line of a deleted file as removed", () => {
    expect(computeDiffLines("one\ntwo", "")).toEqual(["- one", "- two"]);
  });

  it("shows a single changed line with its immediate context, not the whole file", () => {
    const before = Array.from({ length: 20 }, (_unused, index) => `line ${index}`).join("\n");
    const after = before.replace("line 10", "line ten");
    const lines = computeDiffLines(before, after);
    expect(lines).toContain("- line 10");
    expect(lines).toContain("+ line ten");
    // Collapsed context on both sides, not the other ~16 untouched lines.
    expect(lines).toContain("⋯");
    expect(lines.length).toBeLessThan(20);
  });

  it("caps the preview and says how much more there is", () => {
    const before = Array.from({ length: 100 }, (_unused, index) => `x${index}`).join("\n");
    const after = Array.from({ length: 100 }, (_unused, index) => `y${index}`).join("\n");
    const lines = computeDiffLines(before, after, { maxPreviewLines: 10 });
    expect(lines).toHaveLength(11); // 10 shown + one summary line
    expect(lines.at(-1)).toMatch(/more lines/);
  });

  it("refuses to diff pathologically large input rather than pay for the full table", () => {
    const huge = Array.from({ length: 2_001 }, (_unused, index) => `${index}`).join("\n");
    const lines = computeDiffLines(huge, `${huge}\nmore`);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("too large to preview");
  });
});
