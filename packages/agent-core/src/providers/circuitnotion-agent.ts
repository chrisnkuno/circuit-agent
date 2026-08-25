import OpenAI from "openai";
import { buildCircuitNotionHeaders, circuitNotionBaseUrl } from "./circuitnotion-http";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";

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
  /** Live catalog limits for the selected route, used to size context and output budgets. */
  readonly capabilities: ModelCapabilities;

  constructor(private readonly options: CircuitNotionAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("CIRCUITNOTION_API_KEY is required");
    if (!options.model.trim()) throw new Error("CIRCUITNOTION_MODEL is required");
    this.capabilities = capabilitiesFor(options.model);
    if (call) this.call = call;
    else {
      // The bounded runtime owns retries and reports every attempt. SDK retries here would multiply
      // three visible attempts into as many as nine real requests while telling the user there were
      // only three.
      const client = new OpenAI({ apiKey: options.apiKey, baseURL: circuitNotionBaseUrl(options.baseURL), defaultHeaders: buildCircuitNotionHeaders(options.relaySecret), maxRetries: 0 });
      this.call = async (body, signal) => await client.chat.completions.create(body as never, { signal }) as unknown as ChatResponse | AsyncIterable<ChatStreamChunk>;
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const response = await this.call({
      model: this.options.model,
      messages: toWireMessages(request.messages),
      ...(request.tools.length > 0 ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
        tool_choice: "auto",
        parallel_tool_calls: true,
      } : {}),
      max_tokens: request.maxOutputTokens,
      temperature: 0,
      prompt_cache_key: PROMPT_CACHE_KEY,
      ...(request.onTextDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
    }, AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 120_000),
      ...(request.signal ? [request.signal] : []),
    ]));
    return turnFromChatResponse(
      Symbol.asyncIterator in Object(response)
        ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, request.onTextDelta)
        : (response as ChatResponse),
    );
  }
}
