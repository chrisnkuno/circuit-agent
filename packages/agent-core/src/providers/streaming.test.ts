import { describe, expect, it } from "vitest";
import { collectAnthropicStream, type AnthropicStreamEvent } from "./anthropic-agent";
import { collectChatStream, turnFromChatResponse, type ChatStreamChunk } from "./openai-compatible";

async function* streamOf<T>(events: T[]): AsyncIterable<T> {
  for (const event of events) yield event;
}

const chatUsage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };

describe("OpenAI-compatible streaming", () => {
  it("reassembles text and reports every delta in order", async () => {
    const seen: string[] = [];
    const response = await collectChatStream(
      streamOf<ChatStreamChunk>([
        { id: "chatcmpl_1", model: "m", choices: [{ delta: { content: "Hello" } }] },
        { choices: [{ delta: { content: ", " } }] },
        { choices: [{ delta: { content: "world" } }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
        { choices: [], usage: chatUsage },
      ]),
      (text) => seen.push(text),
    );

    expect(seen).toEqual(["Hello", ", ", "world"]);
    expect(response.choices[0].message.content).toBe("Hello, world");
    expect(turnFromChatResponse(response)).toMatchObject({ finishReason: "stop", content: "Hello, world" });
  });

  it("keeps a tool name that later fragments send as an empty string", async () => {
    // Observed live: continuation fragments carry `"name": ""` and `"id": null`. Nullish
    // coalescing accepts the empty string as a value, which erased the name and made every
    // streamed tool call fail as "outside the capability scope".
    const response = await collectChatStream(streamOf<ChatStreamChunk>([
      { id: "chatcmpl_2", model: "m", choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_files", arguments: "" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: undefined, function: { name: "", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "", arguments: '"src"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: chatUsage },
    ]));

    const turn = turnFromChatResponse(response);
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "list_files", arguments: { path: "src" } }]);
  });

  it("keeps parallel tool calls apart by their index", async () => {
    const response = await collectChatStream(streamOf<ChatStreamChunk>([
      { id: "c", model: "m", choices: [{ delta: { tool_calls: [
        { index: 0, id: "a", function: { name: "read_file", arguments: "" } },
        { index: 1, id: "b", function: { name: "grep_files", arguments: "" } },
      ] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"query":"x"}' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: chatUsage },
    ]));

    expect(turnFromChatResponse(response).toolCalls).toEqual([
      { id: "a", name: "read_file", arguments: { path: "a.ts" } },
      { id: "b", name: "grep_files", arguments: { query: "x" } },
    ]);
  });

  it("carries usage from the final chunk, so a streamed turn is still priced", async () => {
    const response = await collectChatStream(streamOf<ChatStreamChunk>([
      { id: "c", model: "m", choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] },
      { choices: [], usage: chatUsage },
    ]));
    expect(turnFromChatResponse(response).usage).toMatchObject({ inputTokens: 100, outputTokens: 20 });
  });
});

describe("Anthropic streaming", () => {
  const start: AnthropicStreamEvent = {
    type: "message_start",
    message: { id: "msg_1", model: "claude-opus-5", usage: { input_tokens: 500, output_tokens: 0, cache_read_input_tokens: 100 } },
  };

  it("reassembles text blocks and reports deltas", async () => {
    const seen: string[] = [];
    const response = await collectAnthropicStream(streamOf<AnthropicStreamEvent>([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Look" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ing." } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } },
    ]), (text) => seen.push(text));

    expect(seen).toEqual(["Look", "ing."]);
    expect(response.content).toEqual([{ type: "text", text: "Looking." }]);
    expect(response.stop_reason).toBe("end_turn");
    // Input tokens come from message_start, output tokens from message_delta — both halves needed.
    expect(response.usage).toMatchObject({ input_tokens: 500, output_tokens: 42, cache_read_input_tokens: 100 });
  });

  it("parses a tool input only once its JSON fragments are whole", async () => {
    const response = await collectAnthropicStream(streamOf<AnthropicStreamEvent>([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "read_file" } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path"' } },
      { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: ':"a.ts"}' } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ]));

    // A half-received JSON object is not a smaller tool call; it is an invalid one.
    expect(response.content).toEqual([{ type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }]);
  });

  it("keeps text and tool blocks in the order the model emitted them", async () => {
    const response = await collectAnthropicStream(streamOf<AnthropicStreamEvent>([
      start,
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "read_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
    ]));

    expect(response.content.map((block) => block.type)).toEqual(["text", "tool_use"]);
  });

  it("does not invent usage when the stream never reported any", async () => {
    const response = await collectAnthropicStream(streamOf<AnthropicStreamEvent>([
      { type: "content_block_start", index: 0, content_block: { type: "text" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
    ]));
    // The adapter fails closed on missing accounting rather than pricing a turn at zero.
    expect(response.usage).toBeNull();
  });
});
