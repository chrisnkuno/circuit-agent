import OpenAI from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";

/**
 * OpenAI adapter for the agent loop.
 *
 * Shares its wire handling with the CircuitNotion adapter through `openai-compatible`, because they
 * speak the same Chat Completions protocol — the difference is the endpoint and the headers, not
 * the message shape. Two copies of that translation is two places for a tool-call bug to hide.
 */

export type OpenAIAgentOptions = { apiKey: string; model: string; baseURL?: string; timeoutMs?: number };

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatResponse | AsyncIterable<ChatStreamChunk>>;

export class OpenAIAgentTurnProvider implements AgentTurnProvider {
  private readonly call: ChatCall;

  constructor(private readonly options: OpenAIAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!options.model.trim()) throw new Error("OPENAI_MODEL is required");
    if (call) this.call = call;
    else {
      const client = new OpenAI({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}) });
      this.call = async (body, signal) => (await client.chat.completions.create(body as never, { signal })) as unknown as ChatResponse | AsyncIterable<ChatStreamChunk>;
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const response = await this.call({
      model: this.options.model,
      messages: toWireMessages(request.messages),
      tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      tool_choice: "auto",
      parallel_tool_calls: true,
      max_completion_tokens: request.maxOutputTokens,
      safety_identifier: request.safetyIdentifier,
      ...(request.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    }, AbortSignal.timeout(this.options.timeoutMs ?? 180_000));
    return turnFromChatResponse(
      Symbol.asyncIterator in Object(response)
        ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, request.onTextDelta)
        : (response as ChatResponse),
    );
  }
}
