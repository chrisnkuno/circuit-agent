import { describe, expect, it } from "vitest";
import { renderCompletionCard } from "./completion-card";
import type { SectionStyle } from "./sections";

const style: SectionStyle = { width: 80, depth: "none" };

describe("completion card", () => {
  it("summarizes changed files, verification, work, elapsed time, and cost", () => {
    const rendered = renderCompletionCard({
      status: "completed",
      files: ["src/a.ts", "src/b.ts"],
      checks: [{ kind: "tests", passed: true }, { kind: "typecheck", passed: true }],
      toolCalls: 4,
      iterations: 2,
      elapsed: "4.2s",
      cost: "RWF 3",
    }, style);
    expect(rendered).toContain("turn complete");
    expect(rendered).toContain("2 files changed");
    expect(rendered).toContain("tests passed · typecheck passed");
    expect(rendered).toContain("2 model turns · 4 tools");
    expect(rendered).toContain("4.2s · RWF 3");
    expect(rendered).toContain("src/a.ts");
  });

  it("is honest when no verification ran", () => {
    const rendered = renderCompletionCard({
      status: "needs_verification",
      files: [],
      checks: [],
      toolCalls: 1,
      iterations: 1,
      elapsed: "1.0s",
      cost: "cost unknown",
    }, style);
    expect(rendered).toContain("needs verification");
    expect(rendered).toContain("no files changed");
    expect(rendered).toContain("verification not run");
  });
});
