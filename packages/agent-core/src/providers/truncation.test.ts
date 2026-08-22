import { describe, expect, it } from "vitest";
import { AnthropicAgentTurnProvider } from "./anthropic-agent";
import { turnFromChatResponse, type ChatResponse } from "./openai-compatible";

/**
 * Hitting the output cap is a *successful* response that stopped early, and every provider has its
 * own word for it. The invariant across all of them: the turn is reported as `length`, the text
 * that arrived is kept, and no tool call parsed out of the truncated tail is handed on for
 * execution — its arguments are a JSON fragment the model never finished writing.
 */

const chatUsage = { prompt_tokens: 12_000, completion_tokens: 8_000, total_tokens: 20_000 };

function chatResponse(choice: Partial<ChatResponse["choices"][number]>): ChatResponse {
  return {
    id: "chatcmpl_1",
    model: "gpt-5.6-terra",
    choices: [{ finish_reason: "stop", message: { content: "Done." }, ...choice }],
    usage: chatUsage,
  };
}

describe("a turn that ran out of output budget", () => {
  it("reports every gateway's spelling of the output cap as one reason, keeping the partial text", () => {
    for (const reason of ["length", "max_tokens", "model_length"]) {
      const turn = turnFromChatResponse(chatResponse({ finish_reason: reason, message: { content: "Here is the file… (cut off" } }));
      expect(turn.finishReason).toBe("length");
      expect(turn.content).toBe("Here is the file… (cut off");
      // The tokens were spent and are still billed, so the accounting has to survive truncation.
      expect(turn.usage.outputTokens).toBe(8_000);
    }
  });

  it("discards a tool call that was still being written when the budget ran out", () => {
    const turn = turnFromChatResponse(chatResponse({
      finish_reason: "length",
      message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","contents":"expo' } }] },
    }));
    expect(turn.finishReason).toBe("length");
    // Executing a half-chosen argument list is worse than asking for the call again.
    expect(turn.toolCalls).toEqual([]);
  });

  it("still fails loudly on a reason nobody recognises", () => {
    // Truncation is now understood; inventing a reading for an unknown word is not, because the one
    // that matters most ("I was not finished") would be the one silently reported as complete.
    expect(() => turnFromChatResponse(chatResponse({ finish_reason: "wat" }))).toThrow("Unsupported model finish reason");
  });

  it("reads an unstated reason from the payload rather than discarding a complete turn", () => {
    // A gateway that never sends the final reason-bearing chunk used to end the user's request with
    // "Unsupported model finish reason: null" even though the whole answer had already arrived.
    const text = turnFromChatResponse(chatResponse({ finish_reason: null, message: { content: "All done." } }));
    expect(text.finishReason).toBe("stop");
    expect(text.content).toBe("All done.");

    const calls = turnFromChatResponse(chatResponse({
      finish_reason: null,
      message: { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    }));
    expect(calls.finishReason).toBe("tool_calls");
    expect(calls.toolCalls).toHaveLength(1);
  });

  it("still fails on an unstated reason with nothing to infer from", () => {
    // No reason and no output is not a turn at all; reporting it as a finished one would answer the
    // user with silence and call it success.
    expect(() => turnFromChatResponse(chatResponse({ finish_reason: null, message: { content: null } }))).toThrow("Unsupported model finish reason");
  });

  it("runs a tool-call turn a gateway mislabelled as a plain stop", () => {
    const turn = turnFromChatResponse(chatResponse({
      finish_reason: "stop",
      message: { content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } }] },
    }));
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([{ id: "call_1", name: "read_file", arguments: { path: "a.ts" } }]);
  });

  it("reads Anthropic's max_tokens as the same event", async () => {
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-test", model: "claude-sonnet-5" }, async () => ({
      id: "msg_1",
      model: "claude-sonnet-5",
      stop_reason: "max_tokens",
      content: [
        { type: "text" as const, text: "Halfway through the plan" },
        { type: "tool_use" as const, id: "toolu_1", name: "write_file", input: '{"path":"a.ts","contents":"expo' },
      ],
      usage: { input_tokens: 1_000, output_tokens: 8_000 },
    }) as never);

    const turn = await provider.complete({
      messages: [{ role: "user", content: "write the file" }],
      tools: [],
      maxOutputTokens: 8_000,
      safetyIdentifier: "nova_cli_test",
    });

    expect(turn.finishReason).toBe("length");
    expect(turn.content).toBe("Halfway through the plan");
    expect(turn.toolCalls).toEqual([]);
    expect(turn.usage.outputTokens).toBe(8_000);
  });
});
