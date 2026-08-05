import OpenAI from "openai";
import { CIRCUITNOTION_DEFAULT_BASE_URL } from "./circuitnotion";
import type { AgentMessage, AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import type { ModelUsage } from "./model";

type ChatResponse = {
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

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatResponse>;

export type CircuitNotionAgentOptions = { apiKey: string; model: string; baseURL?: string; timeoutMs?: number };

function usageOf(response: ChatResponse): ModelUsage {
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

function toWireMessage(message: AgentMessage): Record<string, unknown> {
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

function parseArguments(value: string): unknown {
  try { return JSON.parse(value); } catch { return value; }
}

/** OpenAI-compatible multi-turn tool adapter for CircuitNotion's Chat Completions API. */
export class CircuitNotionAgentTurnProvider implements AgentTurnProvider {
  private readonly call: ChatCall;

  constructor(private readonly options: CircuitNotionAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("CIRCUITNOTION_API_KEY is required");
    if (!options.model.trim()) throw new Error("CIRCUITNOTION_MODEL is required");
    if (call) this.call = call;
    else {
      const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? CIRCUITNOTION_DEFAULT_BASE_URL });
      this.call = async (body, signal) => await client.chat.completions.create(body as never, { signal }) as unknown as ChatResponse;
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const response = await this.call({
      model: this.options.model,
      messages: request.messages.map(toWireMessage),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_tokens: request.maxOutputTokens,
      temperature: 0,
    }, AbortSignal.timeout(this.options.timeoutMs ?? 120_000));
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
}
