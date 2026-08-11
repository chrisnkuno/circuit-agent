import { describe, expect, it } from "vitest";
import { collectExternalTools, toolsFromProvider, type ExternalTool, type ToolProvider } from "./tool-providers";

function provider(id: string, kind: ToolProvider["kind"], tools: ExternalTool[]): ToolProvider {
  return { id, kind, listTools: async () => tools };
}

const echoTool: ExternalTool = {
  name: "echo",
  description: "Echoes its input.",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
  invoke: async (args) => ({ content: String(args.text) }),
};

describe("toolsFromProvider", () => {
  it("tags every tool with the provider's provenance and marks it external, always requiring approval", async () => {
    const tools = await toolsFromProvider(provider("server-a", "mcp", [echoTool]));
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: "echo",
      effect: "external",
      requiresApproval: true,
      parallelSafe: false,
      capabilityId: "workspace.external",
      provenance: { kind: "mcp", providerId: "server-a" },
    });
  });

  it("actually invokes the underlying tool", async () => {
    const [tool] = await toolsFromProvider(provider("local-skills", "skill", [echoTool]));
    const result = await tool.execute({ text: "hello" }, { taskId: "t", runId: "r", stepId: "s" });
    expect(result).toEqual({ content: "hello" });
  });

  it("times out a provider whose invoke never resolves, rather than hanging the turn forever", async () => {
    const hangingTool: ExternalTool = { ...echoTool, name: "hang", invoke: () => new Promise(() => {}) };
    const [tool] = await toolsFromProvider(provider("slow-server", "mcp", [hangingTool]), 50);
    await expect(tool.execute({ text: "x" }, { taskId: "t", runId: "r", stepId: "s" })).rejects.toThrow(/timed out/);
  });

  it("rejects a tool whose schema is outside Nova's supported subset at registration time, not at call time", async () => {
    const unsupported: ExternalTool = { ...echoTool, name: "weird", inputSchema: { type: "object", properties: { nested: { type: "object" } } } };
    await expect(toolsFromProvider(provider("server-a", "mcp", [unsupported]))).rejects.toThrow();
  });
});

describe("collectExternalTools", () => {
  it("merges tools from multiple providers", async () => {
    const other: ExternalTool = { ...echoTool, name: "other" };
    const tools = await collectExternalTools([provider("a", "skill", [echoTool]), provider("b", "mcp", [other])]);
    expect(tools.map((tool) => tool.name).sort()).toEqual(["echo", "other"]);
  });

  it("fails loudly, naming both providers, when two providers offer the same tool name", async () => {
    await expect(
      collectExternalTools([provider("a", "skill", [echoTool]), provider("b", "mcp", [{ ...echoTool }])]),
    ).rejects.toThrow(/echo.*skill:a.*mcp:b/s);
  });
});
