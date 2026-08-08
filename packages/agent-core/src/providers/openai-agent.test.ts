import { describe, expect, it } from "vitest";
import { OpenAIAgentTurnProvider } from "./openai-agent";
import type { ChatResponse } from "./openai-compatible";

const usage = {
  prompt_tokens: 800,
  completion_tokens: 120,
  total_tokens: 920,
  prompt_tokens_details: { cached_tokens: 600 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

const request = {
  messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 4_096,
  safetyIdentifier: "nova_cli_test",
};

function respond(overrides: Partial<ChatResponse["choices"][number]> = {}): ChatResponse {
  return {
    id: "chatcmpl_1",
    model: "gpt-5.6-terra",
    choices: [{ finish_reason: "stop", message: { content: "Done." }, ...overrides }],
    usage,
  };
}

describe("OpenAI agent adapter", () => {
  it("sends tools in the function-calling schema and identifies the caller", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async (value) => {
      body = value;
      return respond();
    });

    const turn = await provider.complete(request);
    expect(body).toMatchObject({ model: "gpt-5.6-terra", tool_choice: "auto", parallel_tool_calls: true, safety_identifier: "nova_cli_test" });
    expect(body!.tools).toEqual([{ type: "function", function: { name: "read_file", description: "Read a file", parameters: { type: "object" } } }]);
    // The system prompt stays a message here, unlike Anthropic's top-level `system`.
    expect(body!.messages).toEqual([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Done.", model: "gpt-5.6-terra" });
  });

  it("reads usage including cached input, so a cached session is priced correctly", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => respond());
    const turn = await provider.complete(request);
    expect(turn.usage).toMatchObject({ inputTokens: 800, outputTokens: 120, cachedInputTokens: 600, reasoningTokens: 40 });
  });

  it("parses tool calls back out of the response", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
      }));
    const turn = await provider.complete(request);
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]);
  });

  it("keeps malformed tool arguments as a string rather than throwing away the turn", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({
        finish_reason: "tool_calls",
        message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: "{not json" } }] },
      }));
    const turn = await provider.complete(request);
    // The runtime rejects non-object arguments with a clear message; losing the whole turn here
    // would hide which tool call was malformed.
    expect(turn.toolCalls[0].arguments).toBe("{not json");
  });

  it("surfaces a refusal instead of an empty answer", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({ finish_reason: "stop", message: { content: null, refusal: "Cannot assist." } }));
    const turn = await provider.complete(request);
    expect(turn).toMatchObject({ finishReason: "refusal", refusal: "Cannot assist." });
  });

  it("fails closed on an unsupported finish reason and on missing accounting", async () => {
    const truncated = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () =>
      respond({ finish_reason: "length" }));
    await expect(truncated.complete(request)).rejects.toThrow(/finish reason/);

    const noUsage = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => ({ ...respond(), usage: null }));
    await expect(noUsage.complete(request)).rejects.toThrow(/usage accounting/);
  });

  it("refuses to construct without credentials", () => {
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "", model: "gpt-5.6-terra" })).toThrow("OPENAI_API_KEY");
    expect(() => new OpenAIAgentTurnProvider({ apiKey: "sk", model: "" })).toThrow("OPENAI_MODEL");
  });

  it("requires a safety identifier before spending anything", async () => {
    const provider = new OpenAIAgentTurnProvider({ apiKey: "sk-test", model: "gpt-5.6-terra" }, async () => respond());
    await expect(provider.complete({ ...request, safetyIdentifier: "  " })).rejects.toThrow("safetyIdentifier");
  });
});
