import { describe, expect, it } from "vitest";
import { intralineDiff, pairHunkLines, similarity, tokenize, type Segment } from "./intraline";
import type { DiffLine } from "./code-view";

const rebuild = (segments: readonly Segment[]) => segments.map((segment) => segment.text).join("");
const changed = (segments: readonly Segment[]) => segments.filter((segment) => segment.changed).map((segment) => segment.text);

describe("intraline diff", () => {
  it("reconstructs both lines exactly — a mark may never alter what is shown", () => {
    const pairs = [
      ["const total = a + b;", "const total = a - b;"],
      ["  indented(value)", "    indented(value)"],
      ["call(one, two)", "call(one, two, three)"],
      ["x", "y z"],
    ];
    for (const [before, after] of pairs) {
      const marked = intralineDiff(before, after);
      if (!marked) continue;
      expect(rebuild(marked.before)).toBe(before);
      expect(rebuild(marked.after)).toBe(after);
    }
  });

  it("marks only the token that changed", () => {
    const marked = intralineDiff("const total = a + b;", "const total = a - b;");
    expect(changed(marked!.before)).toEqual(["+"]);
    expect(changed(marked!.after)).toEqual(["-"]);
  });

  it("keeps identifiers whole instead of marking the letters they happen to share", () => {
    const marked = intralineDiff("const oldName = compute();", "const newName = compute();");
    expect(changed(marked!.before)).toEqual(["oldName"]);
    expect(changed(marked!.after)).toEqual(["newName"]);
  });

  it("shows an indentation change rather than absorbing it into the next token", () => {
    const marked = intralineDiff("  return value;", "    return value;");
    expect(changed(marked!.before).join("")).toBe("  ");
    expect(changed(marked!.after).join("")).toBe("    ");
  });

  it("declines to mark two lines that are not versions of each other", () => {
    expect(intralineDiff("const total = a + b;", "throw new Error('boom');")).toBeNull();
    expect(intralineDiff("same", "same")).toBeNull();
    expect(intralineDiff("", "something")).toBeNull();
    expect(intralineDiff("a".repeat(2_000), `${"a".repeat(1_999)}b`)).toBeNull();
  });

  it("scores similarity between nothing in common and everything", () => {
    expect(similarity("a b c", "a b c")).toBe(1);
    expect(similarity("abc", "xyz")).toBe(0);
    // Shared whitespace is still shared, so lines with no words in common are not scored at zero —
    // only far enough below the marking threshold that they are left alone.
    expect(similarity("a b c", "x y z")).toBeLessThan(0.5);
    expect(similarity("", "")).toBe(1);
    const partial = similarity("const total = a + b;", "const total = a - b;");
    expect(partial).toBeGreaterThan(0.8);
    expect(partial).toBeLessThan(1);
  });

  it("tokenizes into the units a person compares", () => {
    expect(tokenize("const a1 = fn(x);")).toEqual(["const", " ", "a1", " ", "=", " ", "fn", "(", "x", ")", ";"]);
  });
});

describe("pairing a hunk", () => {
  const line = (kind: DiffLine["kind"], text: string): DiffLine => ({ kind, text });

  it("preserves every line, in order, whatever the pairing", () => {
    const lines = [
      line("context", "function f() {"),
      line("remove", "  const a = 1;"),
      line("remove", "  const b = 2;"),
      line("add", "  const a = 10;"),
      line("add", "  const b = 20;"),
      line("add", "  const c = 30;"),
      line("context", "}"),
    ];
    const rows = pairHunkLines(lines);
    expect(rows.map((row) => [row.kind, row.text])).toEqual(lines.map((item) => [item.kind, item.text]));
  });

  it("pairs a removal with the addition that replaced it, by position", () => {
    const rows = pairHunkLines([
      line("remove", "  const a = 1;"),
      line("remove", "  const b = 2;"),
      line("add", "  const a = 10;"),
      line("add", "  const b = 20;"),
    ]);
    const marked = rows.filter((row) => "segments" in row && row.segments);
    expect(marked).toHaveLength(4);
    expect(changed((rows[0] as { segments: Segment[] }).segments)).toEqual(["1"]);
    expect(changed((rows[2] as { segments: Segment[] }).segments)).toEqual(["10"]);
  });

  it("leaves a surplus addition unpaired rather than inventing a comparison for it", () => {
    const rows = pairHunkLines([
      line("remove", "  const a = 1;"),
      line("add", "  const a = 2;"),
      line("add", "  const brandNew = compute(everything);"),
    ]);
    expect("segments" in rows[1] && rows[1].segments).toBeTruthy();
    expect("segments" in rows[2] && rows[2].segments).toBeFalsy();
  });

  it("marks nothing when a block was rewritten rather than edited", () => {
    const rows = pairHunkLines([
      line("remove", "  const a = 1;"),
      line("add", "  throw new Error('unsupported');"),
    ]);
    expect(rows.every((row) => !("segments" in row && row.segments))).toBe(true);
  });

  it("handles additions with no removals, and removals with no additions", () => {
    expect(pairHunkLines([line("add", "one"), line("add", "two")]).every((row) => row.kind === "add")).toBe(true);
    expect(pairHunkLines([line("remove", "one")])).toEqual([{ kind: "remove", text: "one" }]);
    expect(pairHunkLines([])).toEqual([]);
  });
});
