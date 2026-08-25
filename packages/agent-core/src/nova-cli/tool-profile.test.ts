import { describe, expect, it } from "vitest";
import { toolProfileForObjective, toolsForProfile } from "./tool-profile";
import type { AgentTool } from "../agent-runtime";

describe("intent-aware tool profiles", () => {
  it("uses no tools for direct conversational replies", () => {
    expect(toolProfileForObjective("Hello!", "build")).toBe("chat");
    expect(toolProfileForObjective("Reply with exactly: READY", "auto")).toBe("chat");
  });

  it("keeps read-only tools for repository questions", () => {
    expect(toolProfileForObjective("Review the authentication code and explain the bug", "build")).toBe("read");
  });

  it("keeps the full profile for changes and defender work", () => {
    expect(toolProfileForObjective("Fix the authentication bug", "build")).toBe("full");
    expect(toolProfileForObjective("review auth", "defender")).toBe("full");
    expect(toolProfileForObjective("something ambiguous", "build")).toBe("full");
  });

  it("filters by effect without trusting tool names", () => {
    const tools = [
      { name: "read", effect: "none" },
      { name: "edit", effect: "workspace" },
      { name: "send", effect: "external" },
    ] as AgentTool[];
    expect(toolsForProfile(tools, "chat")).toEqual([]);
    expect(toolsForProfile(tools, "read").map((tool) => tool.name)).toEqual(["read"]);
    expect(toolsForProfile(tools, "full")).toHaveLength(3);
  });
});
