import OpenAI from "openai";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { collectChatStream, toWireMessages, turnFromChatResponse, type ChatResponse, type ChatStreamChunk } from "./openai-compatible";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";

/**
 * OpenAI adapter for the agent loop.
 *
 * Shares its wire handling with the CircuitNotion adapter through `openai-compatible`, because they
 * speak the same Chat Completions protocol — the difference is the endpoint and the headers, not
 * the message shape. Two copies of that translation is two places for a tool-call bug to hide.
 */

export type OpenAIAgentOptions = { apiKey: string; model: string; baseURL?: string; timeoutMs?: number };

type ChatCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<ChatResponse | AsyncIterable<ChatStreamChunk>>;

function usesInklingToolContract(model: string): boolean {
  return model === "thinkingmachines/inkling:free" || model === "thinkingmachines/inkling-small:free";
}

export class OpenAIAgentTurnProvider implements AgentTurnProvider {
  private readonly call: ChatCall;
  /** What this model can hold and produce, so the session sizes its budgets from the model. */
  readonly capabilities: ModelCapabilities;

  constructor(private readonly options: OpenAIAgentOptions, call?: ChatCall) {
    if (!options.apiKey.trim()) throw new Error("OPENAI_API_KEY is required");
    if (!options.model.trim()) throw new Error("OPENAI_MODEL is required");
    this.capabilities = capabilitiesFor(options.model);
    if (call) this.call = call;
    else {
      // Retry policy is centralized in BoundedAgentRuntime so attempt counts, cancellation and
      // messages stay truthful instead of being multiplied invisibly by the SDK.
      const client = new OpenAI({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), maxRetries: 0 });
      this.call = async (body, signal) => (await client.chat.completions.create(body as never, { signal })) as unknown as ChatResponse | AsyncIterable<ChatStreamChunk>;
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const inkling = usesInklingToolContract(this.options.model);
    const response = await this.call({
      model: this.options.model,
      messages: toWireMessages(request.messages),
      ...(request.tools.length > 0 ? {
        tools: request.tools.map((tool) => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })),
      } : {}),
      // Inkling's OpenRouter endpoint advertises tools, but not tool_choice or parallel tool
      // calls, and it accepts max_tokens rather than max_completion_tokens. Sending the broader
      // OpenAI contract makes the request fail before Inkling can call a single tool.
      ...(inkling || request.tools.length === 0 ? {} : { tool_choice: "auto", parallel_tool_calls: true }),
      ...(inkling
        ? { max_tokens: request.maxOutputTokens }
        : { max_completion_tokens: request.maxOutputTokens }),
      safety_identifier: request.safetyIdentifier,
      // The documented routing hint for prompt caching, and the replacement for the deprecated
      // `user` field. Stable for the whole session, which is what makes it useful: cached prefixes
      // are routed by this key, and a per-request value would scatter them across shards and hit
      // nothing. The sibling CircuitNotion adapter has always sent one; this path had not.
      prompt_cache_key: request.safetyIdentifier,
      // Effort is only sent when the caller asked for one and the model accepts the field.
      // Reasoning tokens bill as output and share the output budget, so this is a direct spend
      // control, not a quality preference.
      ...(request.effort && this.capabilities.supportsEffort ? { reasoning_effort: request.effort } : {}),
      // Streaming is unconditional. `max_completion_tokens` is now sized from what the model can
      // really write, and an unstreamed reply that large risks the SDK's HTTP timeout — the call is
      // billed and the answer lost. `include_usage` travels with it because on Chat Completions a
      // streamed response reports no usage without it, and the accounting is not optional.
      stream: true,
      stream_options: { include_usage: true },
    }, AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      ...(request.signal ? [request.signal] : []),
    ]));
    return turnFromChatResponse(
      Symbol.asyncIterator in Object(response)
        ? await collectChatStream(response as AsyncIterable<ChatStreamChunk>, request.onTextDelta)
        : (response as ChatResponse),
    );
  }
}
