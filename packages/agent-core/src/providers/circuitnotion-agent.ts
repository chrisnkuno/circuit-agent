import OpenAI from "openai";
import { buildCircuitNotionHeaders, CIRCUITNOTION_DEFAULT_BASE_URL } from "./circuitnotion-http";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";

export type { ChatResponse };

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatResponse | AsyncIterable<ChatStreamChunk>>;

export type CircuitNotionAgentOptions = { apiKey: string; model: string; baseURL?: string; timeoutMs?: number; relaySecret?: string };

/**
 * Routing hint for the provider's prompt cache.
 *
 * Caching here is prefix-based and automatic — a repeated system prompt measured ~99% cached
 * without any parameter at all — so this is not what turns caching on. It asks the provider to keep
 * requests from this agent on a consistent cache, which matters once several sessions run at once.
 */
const PROMPT_CACHE_KEY = "nova-agent-tools-v1";

/** OpenAI-compatible multi-turn tool adapter for CircuitNotion's Chat Completions API. */
export class CircuitNotionAgentTurnProvider implements AgentTurnProvider {
  private readonly call: ChatCall;

  constructor(private readonly options: CircuitNotionAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("CIRCUITNOTION_API_KEY is required");
    if (!options.model.trim()) throw new Error("CIRCUITNOTION_MODEL is required");
    if (call) this.call = call;
    else {
      const client = new OpenAI({ apiKey: options.apiKey, baseURL: options.baseURL ?? CIRCUITNOTION_DEFAULT_BASE_URL, defaultHeaders: buildCircuitNotionHeaders(options.relaySecret) });
      this.call = async (body, signal) => await client.chat.completions.create(body as never, { signal }) as unknown as ChatResponse | AsyncIterable<ChatStreamChunk>;
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
      max_tokens: request.maxOutputTokens,
      temperature: 0,
      prompt_cache_key: PROMPT_CACHE_KEY,
      ...(request.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    }, AbortSignal.timeout(this.options.timeoutMs ?? 120_000));
    return turnFromChatResponse(
      Symbol.asyncIterator in Object(response)
        ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, request.onTextDelta)
        : (response as ChatResponse),
    );
  }
}
