import { describe, expect, it } from "vitest";
import { countBySeverity, sortFindings, summarize, type PlacedSecretFinding } from "./scan";

const at = (severity: PlacedSecretFinding["severity"], path: string, line: number): PlacedSecretFinding =>
  ({ severity, path, line, kind: "test rule", masked: "abcd…wxyz (32 chars)" });

describe("sortFindings", () => {
  it("puts the worst first, whatever order they arrived in", () => {
    const sorted = sortFindings([at("medium", "a.ts", 1), at("critical", "z.ts", 9), at("high", "m.ts", 5)]);
    expect(sorted.map((finding) => finding.severity)).toEqual(["critical", "high", "medium"]);
  });

  it("reads in file order within a severity, so equal findings do not reshuffle", () => {
    const sorted = sortFindings([at("high", "b.ts", 2), at("high", "a.ts", 9), at("high", "a.ts", 3)]);
    expect(sorted.map((finding) => `${finding.path}:${finding.line}`)).toEqual(["a.ts:3", "a.ts:9", "b.ts:2"]);
  });

  it("does not mutate what it was given", () => {
    const input = [at("medium", "a.ts", 1), at("critical", "b.ts", 2)];
    sortFindings(input);
    expect(input[0].severity).toBe("medium");
  });

  it("handles an empty scan", () => {
    expect(sortFindings([])).toEqual([]);
  });
});

describe("countBySeverity", () => {
  it("counts each severity, highest first", () => {
    const counts = countBySeverity([at("medium", "a", 1), at("critical", "b", 1), at("medium", "c", 1)]);
    expect(counts).toEqual([{ severity: "critical", count: 1 }, { severity: "medium", count: 2 }]);
  });

  it("omits severities with nothing in them rather than showing zeroes", () => {
    const counts = countBySeverity([at("high", "a", 1)]);
    expect(counts).toEqual([{ severity: "high", count: 1 }]);
  });
});

describe("summarize", () => {
  it("says plainly when a clean scan found nothing", () => {
    expect(summarize([])).toBe("No likely secrets found by pattern.");
  });

  it("leads with the count and breaks it down by severity", () => {
    const line = summarize([at("critical", "a", 1), at("medium", "b", 2), at("medium", "c", 3)]);
    expect(line).toContain("3 possible secrets");
    expect(line).toContain("1 critical");
    expect(line).toContain("2 medium");
  });

  it("agrees with itself on one finding", () => {
    expect(summarize([at("high", "a", 1)])).toContain("1 possible secret —");
  });

  it("never claims certainty, because every finding is a regex match", () => {
    expect(summarize([at("critical", "a", 1)])).toContain("a lead, not proof");
  });
});
