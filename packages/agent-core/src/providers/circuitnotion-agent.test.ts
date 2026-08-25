import { describe, expect, it } from "vitest";
import { CircuitNotionAgentTurnProvider } from "./circuitnotion-agent";

const usage = { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } };

describe("CircuitNotion agent turn provider", () => {
  it("exposes the live route limits to the session budget", () => {
    const provider = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "circuit-2-turbo" }, async () => ({ id: "unused", model: "unused", usage, choices: [] }));
    expect(provider.capabilities).toEqual({ contextWindow: 1_000_000, maxOutputTokens: 384_000, supportsEffort: false });
  });

  it("combines caller cancellation with the provider timeout", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "circuit-2-turbo" }, async (_body, signal) => {
      received = signal;
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = provider.complete({ messages: [], tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org", signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(received?.aborted).toBe(true);
  });

  it("sends capability-scoped tools and parses tool calls", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async (request) => {
      body = request;
      return {
        id: "chat-1", model: "gpt-5.6-luna", usage,
        choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] } }],
      };
    });
    const result = await provider.complete({
      messages: [{ role: "system", content: "Stable prompt" }, { role: "user", content: "Inspect" }],
      tools: [{ name: "read_file", description: "Read", inputSchema: { type: "object" } }],
      maxOutputTokens: 2_000,
      safetyIdentifier: "org-1",
    });
    expect(body).toMatchObject({ model: "gpt-5.6-luna", tool_choice: "auto", parallel_tool_calls: true });
    expect(JSON.stringify(body)).not.toContain("cn_test");
    expect(result).toMatchObject({ finishReason: "tool_calls", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "README.md" } }], usage: { totalTokens: 30, cachedInputTokens: 5 } });
  });

  it("replays assistant tool calls and their results without changing identity", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async (request) => {
      body = request;
      return { id: "chat-2", model: "gpt-5.6-luna", usage, choices: [{ finish_reason: "stop", message: { content: "Done" } }] };
    });
    await provider.complete({
      messages: [
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: { path: "a" } }] },
        { role: "tool", content: "content", toolCallId: "call-1", name: "read_file" },
      ],
      tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org-1",
    });
    expect(body?.messages).toEqual([
      { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: "{\"path\":\"a\"}" } }] },
      { role: "tool", content: "content", tool_call_id: "call-1", name: "read_file" },
    ]);
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
    expect(body).not.toHaveProperty("parallel_tool_calls");
  });

  it("reports a truncated ending as unfinished, and fails closed on an unknown one or missing usage", async () => {
    const truncated = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async () => ({ id: "chat-3", model: "gpt-5.6-luna", usage, choices: [{ finish_reason: "length", message: { content: "partial" } }] }));
    expect(await truncated.complete({ messages: [], tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org" })).toMatchObject({ finishReason: "length", content: "partial" });
    const unknown = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async () => ({ id: "chat-5", model: "gpt-5.6-luna", usage, choices: [{ finish_reason: "banana", message: { content: "?" } }] }));
    await expect(unknown.complete({ messages: [], tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org" })).rejects.toThrow("finish reason");
    const noUsage = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async () => ({ id: "chat-4", model: "gpt-5.6-luna", usage: null, choices: [{ finish_reason: "stop", message: { content: "done" } }] }));
    await expect(noUsage.complete({ messages: [], tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org" })).rejects.toThrow("usage accounting");
  });

  it("builds a real client when no call is injected, relaying through CircuitNotion's own base URL and headers", () => {
    expect(() => new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" })).not.toThrow();
    expect(() => new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna", relaySecret: "s3cr3t" })).not.toThrow();
  });

  it("collects a streamed response through the same path a buffered one takes", async () => {
    async function* stream() {
      yield { id: "chat-5", model: "gpt-5.6-luna", choices: [{ delta: { content: "Look" } }] };
      yield { choices: [{ delta: { content: "ing." }, finish_reason: "stop" }] };
      yield { choices: [], usage };
    }
    const provider = new CircuitNotionAgentTurnProvider({ apiKey: "cn_test", model: "gpt-5.6-luna" }, async () => stream());
    const seen: string[] = [];
    const turn = await provider.complete({
      messages: [], tools: [], maxOutputTokens: 1_000, safetyIdentifier: "org-1",
      onTextDelta: (text) => seen.push(text),
    });
    expect(seen).toEqual(["Look", "ing."]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Looking." });
  });
});
