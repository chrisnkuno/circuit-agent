import { describe, expect, it } from "vitest";
import {
  buildAboutLines,
  buildBanner,
  buildHelpLines,
  buildRunSessionLines,
  buildStatusLines,
  buildUnknownCommandLines,
  parseCommand,
} from "./terminal-simulation";

describe("parseCommand", () => {
  it("parses known zero-argument commands case-insensitively", () => {
    expect(parseCommand("help")).toEqual({ kind: "help" });
    expect(parseCommand("  HELP  ")).toEqual({ kind: "help" });
    expect(parseCommand("?")).toEqual({ kind: "help" });
    expect(parseCommand("about")).toEqual({ kind: "about" });
    expect(parseCommand("status")).toEqual({ kind: "status" });
    expect(parseCommand("clear")).toEqual({ kind: "clear" });
  });

  it("treats blank input as empty rather than unknown", () => {
    expect(parseCommand("   ")).toEqual({ kind: "empty" });
  });

  it("defaults run to coding when no kind is given", () => {
    expect(parseCommand("run fix the flaky test")).toEqual({ kind: "run", taskKind: "coding", objective: "fix the flaky test" });
  });

  it("parses an explicit task kind and its aliases", () => {
    expect(parseCommand("run research find pricing comparables")).toEqual({ kind: "run", taskKind: "research", objective: "find pricing comparables" });
    expect(parseCommand("run write a launch email")).toEqual({ kind: "run", taskKind: "writing", objective: "a launch email" });
    expect(parseCommand("run ops rotate the api key")).toEqual({ kind: "run", taskKind: "operations", objective: "rotate the api key" });
  });

  it("rejects a run command with no objective", () => {
    expect(parseCommand("run coding")).toEqual({ kind: "unknown", raw: "run coding" });
    expect(parseCommand("run")).toEqual({ kind: "unknown", raw: "run" });
  });

  it("falls back to unknown for anything else", () => {
    expect(parseCommand("sudo rm -rf /")).toEqual({ kind: "unknown", raw: "sudo rm -rf /" });
  });
});

describe("buildBanner", () => {
  it("produces a border that exactly matches the title line width", () => {
    const [top, mid, bottom] = buildBanner().split("\n");
    expect(top.length).toBe(mid.length);
    expect(bottom.length).toBe(mid.length);
    expect(mid).toContain("CIRCUIT · NOVA");
  });
});

describe("static line builders", () => {
  it("help, about, status, and unknown builders return non-empty, non-blank lines", () => {
    for (const lines of [buildHelpLines(), buildAboutLines(), buildStatusLines(), buildUnknownCommandLines("nope")]) {
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.text.trim().length).toBeGreaterThan(0);
        expect(line.delayMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("status reflects the real capability registry for every task kind", () => {
    const text = buildStatusLines().map((line) => line.text).join("\n");
    expect(text).toContain("coding");
    expect(text).toContain("workspace.files");
  });
});

describe("buildRunSessionLines", () => {
  it("is deterministic for the same task kind and objective", () => {
    const a = buildRunSessionLines("coding", "fix the flaky retry test");
    const b = buildRunSessionLines("coding", "fix the flaky retry test");
    expect(a).toEqual(b);
  });

  it("varies across different objectives", () => {
    const a = buildRunSessionLines("coding", "fix the flaky retry test");
    const b = buildRunSessionLines("coding", "add a missing database index");
    expect(a).not.toEqual(b);
  });

  it("opens with the objective and a quote, and every line is well-formed", () => {
    const lines = buildRunSessionLines("coding", "fix the flaky retry test");
    expect(lines[0].text).toContain("fix the flaky retry test");
    expect(lines[1].text).toMatch(/quote/);
    for (const line of lines) {
      expect(line.text.length).toBeGreaterThan(0);
      expect(Number.isInteger(line.delayMs)).toBe(true);
      expect(line.delayMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("ends a coding run with a settlement line inside the quoted cap", () => {
    const lines = buildRunSessionLines("coding", "add input validation");
    const settlement = lines.find((line) => line.text.includes("settled"));
    expect(settlement).toBeDefined();
    expect(settlement?.tone).toBe("success");
  });

  it("pauses an operations run at the approval gate instead of completing unattended", () => {
    const lines = buildRunSessionLines("operations", "rotate the production api key");
    expect(lines.at(-1)?.tone).toBe("muted");
    expect(lines.some((line) => line.text.includes("requires approval"))).toBe(true);
    expect(lines.some((line) => line.text.includes("settled"))).toBe(false);
  });

  it("includes at least one tool call for every non-operations task kind", () => {
    for (const taskKind of ["coding", "research", "writing"] as const) {
      const lines = buildRunSessionLines(taskKind, "example objective");
      expect(lines.some((line) => line.tone === "tool")).toBe(true);
    }
  });
});
