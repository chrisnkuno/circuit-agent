import { describe, expect, it } from "vitest";
import { crashReportText, describeCrash } from "./crash";

describe("describeCrash", () => {
  it("uses an Error's message and keeps its stack as the detail", () => {
    const error = new Error("sidecar went away");
    const report = describeCrash(error);
    expect(report.summary).toBe("sidecar went away");
    expect(report.detail).toContain("sidecar went away");
    expect(report.detail).toContain("crash.test");
  });

  it("survives an Error with no message, rather than heading the screen with nothing", () => {
    expect(describeCrash(new TypeError("")).summary).toBe("TypeError");
  });

  it("survives an Error with no stack", () => {
    const error = new Error("no stack here");
    error.stack = undefined;
    expect(describeCrash(error).detail).toBe("no stack here");
  });

  it("handles a thrown string, which is legal and does happen", () => {
    expect(describeCrash("just a string")).toEqual({ summary: "just a string", detail: "just a string" });
  });

  it("shows the shape of a thrown object instead of [object Object]", () => {
    const report = describeCrash({ code: 42, why: "nope" });
    expect(report.detail).toContain("42");
    expect(report.detail).toContain("nope");
    expect(report.detail).not.toContain("[object Object]");
  });

  it("never crashes while reporting a crash — circular, null, undefined, a number", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const thrown of [circular, null, undefined, 7, Symbol("x")]) {
      expect(() => describeCrash(thrown)).not.toThrow();
      expect(describeCrash(thrown).summary.length).toBeGreaterThan(0);
    }
  });

  it("takes only the first line for the heading, and caps a runaway one", () => {
    expect(describeCrash(new Error("line one\nline two")).summary).toBe("line one");
    expect(describeCrash(new Error("x".repeat(500))).summary.length).toBeLessThanOrEqual(200);
  });
});

describe("crashReportText", () => {
  it("leads with the build and platform, which is the first thing asked about any crash", () => {
    const text = crashReportText(describeCrash(new Error("boom")), { version: "0.1.3", platform: "Windows" });
    expect(text.split("\n")[0]).toBe("Nova 0.1.3 (Windows)");
    expect(text).toContain("boom");
  });
});
