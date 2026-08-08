import type { AgentMessage, AgentModelTurn } from "../agent-runtime";
import type { ModelUsage } from "./model";

/**
 * The Chat Completions wire format, shared by every OpenAI-compatible provider.
 *
 * CircuitNotion and OpenAI speak the same protocol; only the endpoint and headers differ. Keeping
 * one translation means a tool-call parsing fix lands for both, instead of being fixed in the
 * adapter someone happened to be debugging.
 */

export type ChatResponse = {
  id: string;
  model: string;
  choices: Array<{
    finish_reason: string | null;
    message: {
      content: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  } | null;
};

export function usageOf(response: ChatResponse): ModelUsage {
  if (!response.usage) throw new Error("Model response did not include usage accounting");
  const usage = {
    inputTokens: response.usage.prompt_tokens,
    outputTokens: response.usage.completion_tokens,
    totalTokens: response.usage.total_tokens,
    cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: response.usage.prompt_tokens_details?.cache_write_tokens ?? 0,
    reasoningTokens: response.usage.completion_tokens_details?.reasoning_tokens ?? 0,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model response contained invalid usage accounting");
  return usage;
}

export function toWireMessage(message: AgentMessage): Record<string, unknown> {
  if (message.role === "tool") return { role: "tool", content: message.content, tool_call_id: message.toolCallId, name: message.name };
  if (message.role === "assistant" && "toolCalls" in message) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
    };
  }
  return { role: message.role, content: message.content };
}

export function toWireMessages(messages: readonly AgentMessage[]): Array<Record<string, unknown>> {
  return messages.map(toWireMessage);
}

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/** Reads one Chat Completions response into the runtime's turn shape. */
export function turnFromChatResponse(response: ChatResponse): AgentModelTurn {
  const choice = response.choices[0];
  if (!choice) throw new Error("Model response contained no choices");
  const toolCalls = (choice.message.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: parseArguments(call.function.arguments) }));
  const finishReason = choice.message.refusal
    ? "refusal"
    : choice.finish_reason === "stop"
      ? "stop"
      : choice.finish_reason === "tool_calls"
        ? "tool_calls"
        : undefined;
  if (!finishReason) throw new Error(`Unsupported model finish reason: ${choice.finish_reason}`);
  return {
    responseId: response.id,
    model: response.model,
    finishReason,
    content: choice.message.content ?? "",
    refusal: choice.message.refusal ?? undefined,
    toolCalls,
    usage: usageOf(response),
  };
}

/** One server-sent chunk of a streamed chat completion. Every field is absent on some chunk. */
export type ChatStreamChunk = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string | null;
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
  }>;
  usage?: ChatResponse["usage"];
};

/**
 * Folds a streamed completion back into the single response shape the adapters already read.
 *
 * Tool calls are the subtle part: they arrive as fragments keyed by `index`, with the name on the
 * first fragment and the JSON arguments dribbling across many. Accumulating by index — rather than
 * by the id, which is absent on later fragments — is what makes a streamed tool call identical to
 * a buffered one by the time the runtime sees it.
 */
export async function collectChatStream(
  stream: AsyncIterable<ChatStreamChunk>,
  onTextDelta?: (text: string) => void,
): Promise<ChatResponse> {
  let id = "";
  let model = "";
  let content = "";
  let refusal = "";
  let finishReason: string | null = null;
  let usage: ChatResponse["usage"] = null;
  const calls = new Map<number, { id: string; name: string; args: string }>();

  for await (const chunk of stream) {
    if (chunk.id) id = chunk.id;
    if (chunk.model) model = chunk.model;
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (choice.delta?.refusal) refusal += choice.delta.refusal;
    if (choice.delta?.content) {
      content += choice.delta.content;
      onTextDelta?.(choice.delta.content);
    }
    for (const fragment of choice.delta?.tool_calls ?? []) {
      const existing = calls.get(fragment.index) ?? { id: "", name: "", args: "" };
      // Truthiness, not nullish coalescing: providers send `"name": ""` and `"id": null` on the
      // continuation fragments, and `??` treats the empty string as a real value — which silently
      // erased the tool's name and made every streamed call fail as "outside the capability scope".
      calls.set(fragment.index, {
        id: fragment.id || existing.id,
        name: fragment.function?.name || existing.name,
        args: existing.args + (fragment.function?.arguments ?? ""),
      });
    }
  }

  const tool_calls = [...calls.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, call]) => ({ id: call.id, type: "function" as const, function: { name: call.name, arguments: call.args } }));

  return {
    id,
    model,
    choices: [{
      finish_reason: finishReason,
      message: { content: content || null, refusal: refusal || null, ...(tool_calls.length > 0 ? { tool_calls } : {}) },
    }],
    usage,
  };
}
