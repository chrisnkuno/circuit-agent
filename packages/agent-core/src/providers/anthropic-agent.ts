import type { AgentMessage, AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import type { ModelUsage } from "./model";
import { capabilitiesFor, type ModelCapabilities } from "./model-capabilities";

/**
 * Anthropic Messages API adapter.
 *
 * The Messages API differs from the OpenAI-compatible providers in three ways that matter to the
 * runtime, and all three are handled here rather than leaking into the agent loop:
 *
 * - The system prompt is a top-level `system` parameter, not a message with `role: "system"`.
 * - Tool calls and their results are *content blocks* inside user/assistant turns, not a separate
 *   `tool` role — so a tool result becomes a `tool_result` block in a user message.
 * - `max_tokens` is required, and it bounds thinking plus visible output together.
 */

export type AnthropicAgentOptions = {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs?: number;
};

type AnthropicMessage = { role: "user" | "assistant"; content: unknown };

type MessagesCall = (body: Record<string, unknown>, signal: AbortSignal) => Promise<AnthropicResponse | AsyncIterable<AnthropicStreamEvent>>;

/** The subset of Anthropic's SSE events this adapter needs to rebuild a finished message. */
export type AnthropicStreamEvent =
  | { type: "message_start"; message: { id: string; model: string; usage: AnthropicResponse["usage"] } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string } }
  | { type: "content_block_delta"; index: number; delta: { type: string; text?: string; partial_json?: string } }
  | { type: "message_delta"; delta: { stop_reason?: string | null }; usage?: { output_tokens?: number } }
  | { type: string; [key: string]: unknown };

/**
 * Rebuilds a complete message from Anthropic's event stream.
 *
 * Tool inputs arrive as `input_json_delta` fragments that only parse once concatenated, so they are
 * accumulated per block index and parsed at the end — a half-received JSON object is not a smaller
 * tool call, it is an invalid one. Usage is assembled from both ends of the stream: input tokens
 * land on `message_start`, output tokens on `message_delta`.
 */
export async function collectAnthropicStream(
  stream: AsyncIterable<AnthropicStreamEvent>,
  onTextDelta?: (text: string) => void,
): Promise<AnthropicResponse> {
  let id = "";
  let model = "";
  let stopReason: string | null = null;
  // Usage arrives from both ends of the stream: input tokens on message_start, output tokens on
  // message_delta. Tracked apart and composed at the end so neither half narrows away the other.
  let baseUsage: NonNullable<AnthropicResponse["usage"]> | null = null;
  let outputTokens: number | undefined;
  const blocks = new Map<number, { type: string; id?: string; name?: string; text: string; json: string }>();

  for await (const event of stream) {
    if (event.type === "message_start") {
      const start = event as Extract<AnthropicStreamEvent, { type: "message_start" }>;
      id = start.message.id;
      model = start.message.model;
      baseUsage = start.message.usage ?? null;
    } else if (event.type === "content_block_start") {
      const start = event as Extract<AnthropicStreamEvent, { type: "content_block_start" }>;
      blocks.set(start.index, { type: start.content_block.type, id: start.content_block.id, name: start.content_block.name, text: "", json: "" });
    } else if (event.type === "content_block_delta") {
      const delta = event as Extract<AnthropicStreamEvent, { type: "content_block_delta" }>;
      const block = blocks.get(delta.index);
      if (!block) continue;
      if (delta.delta.type === "text_delta" && delta.delta.text) {
        block.text += delta.delta.text;
        onTextDelta?.(delta.delta.text);
      }
      if (delta.delta.type === "input_json_delta" && delta.delta.partial_json) block.json += delta.delta.partial_json;
    } else if (event.type === "message_delta") {
      const message = event as Extract<AnthropicStreamEvent, { type: "message_delta" }>;
      if (message.delta.stop_reason) stopReason = message.delta.stop_reason;
      if (message.usage?.output_tokens !== undefined) outputTokens = message.usage.output_tokens;
    }
  }

  const content = [...blocks.entries()].sort(([left], [right]) => left - right).map(([, block]) => {
    if (block.type === "tool_use") {
      let input: unknown = {};
      try { input = block.json ? JSON.parse(block.json) : {}; } catch { input = block.json; }
      return { type: "tool_use" as const, id: block.id ?? "", name: block.name ?? "", input };
    }
    return { type: "text" as const, text: block.text };
  });

  const usage = baseUsage ? { ...baseUsage, output_tokens: outputTokens ?? baseUsage.output_tokens } : null;
  return { id, model, stop_reason: stopReason, content, usage };
}

type AnthropicResponse = {
  id: string;
  model: string;
  stop_reason: string | null;
  content: Array<
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "tool_use"; id: string; name: string; input: unknown }
    | { type: string; [key: string]: unknown }
  >;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  } | null;
};

function usageOf(response: AnthropicResponse): ModelUsage {
  if (!response.usage) throw new Error("Model response did not include usage accounting");
  const cachedInputTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
  const usage = {
    // Anthropic reports cache reads and writes *alongside* `input_tokens` rather than inside it,
    // which is the opposite of the OpenAI-compatible providers. Folding them in here is what keeps
    // one definition of "input tokens" across every adapter, and stops a cached Anthropic session
    // from looking an order of magnitude cheaper than it was.
    inputTokens: response.usage.input_tokens + cachedInputTokens + cacheWriteTokens,
    outputTokens: response.usage.output_tokens,
    totalTokens: response.usage.input_tokens + cachedInputTokens + cacheWriteTokens + response.usage.output_tokens,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens: 0,
  };
  if (Object.values(usage).some((value) => !Number.isSafeInteger(value) || value < 0)) throw new Error("Model response contained invalid usage accounting");
  return usage;
}

/**
 * Rewrites the runtime's flat message list into Anthropic's block-structured turns.
 *
 * Consecutive tool results must be collected into a single user turn: the runtime emits one
 * `tool` message per call, and sending them as separate turns would break the alternation the
 * Messages API expects after a parallel tool-call turn.
 */
export function toAnthropicMessages(messages: readonly AgentMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const converted: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "tool") {
      const block = { type: "tool_result", tool_use_id: message.toolCallId, content: message.content || "(empty tool result)" };
      const last = converted[converted.length - 1];
      if (last?.role === "user" && Array.isArray(last.content) && (last.content as Array<{ type: string }>)[0]?.type === "tool_result") {
        (last.content as unknown[]).push(block);
      } else {
        converted.push({ role: "user", content: [block] });
      }
      continue;
    }

    if (message.role === "assistant" && "toolCalls" in message) {
      const blocks: unknown[] = [];
      if (message.content.trim()) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments ?? {} });
      }
      converted.push({ role: "assistant", content: blocks });
      continue;
    }

    // A turn with no text at all is rejected; the runtime can produce one when a model answers
    // with tool calls only, and dropping it would orphan the tool results that follow.
    converted.push({ role: message.role, content: message.content.trim() || "(no content)" });
  }
  return { system, messages: converted };
}

const EPHEMERAL = { type: "ephemeral" } as const;

/**
 * Marks the two long, stable prefixes of a request as cacheable.
 *
 * Without this every iteration of an agent loop re-processes the entire prompt from scratch, and an
 * agent loop is the worst possible shape for that: the conversation only ever grows, each turn
 * resends everything before it, and by the tenth tool call the resent prefix dwarfs the new content
 * many times over. `usageOf` already reads `cache_read_input_tokens`, so the accounting for this has
 * been in place the whole time — nothing was ever writing the breakpoints that would populate it.
 *
 * Two breakpoints, at the two boundaries that actually hold still:
 *
 * - **After the tool definitions.** Tools and the system prompt are byte-identical for every
 *   iteration of a run, and they sit at the very front of the request, so this one breakpoint covers
 *   the whole fixed header. (Anthropic caches the prefix *up to* a breakpoint, and the documented
 *   ordering is tools, then system, then messages — so a marker on the last tool covers the tools
 *   and a marker on the system block covers tools plus system.)
 * - **After the last complete exchange.** This is the rolling one: on the next iteration the marker
 *   moves forward past the turn that just happened, and everything before it is a cache hit. It is
 *   placed on the second-to-last message rather than the last so the newest content stays outside
 *   the cached prefix — a breakpoint on genuinely new text caches something that will never be read
 *   back, paying the write premium for nothing.
 *
 * Both are `ephemeral`, the only cache type the Messages API offers, and four is the documented
 * maximum number of breakpoints; two leaves room for callers that add their own.
 */
function withCacheBreakpoints(
  system: string,
  messages: AnthropicMessage[],
  tools: Array<Record<string, unknown>>,
): { system: unknown; messages: AnthropicMessage[]; tools: Array<Record<string, unknown>> } {
  const cachedTools = tools.length > 0
    ? tools.map((tool, index) => (index === tools.length - 1 ? { ...tool, cache_control: EPHEMERAL } : tool))
    : tools;
  // The system prompt becomes a block array purely so it can carry a breakpoint; a bare string
  // cannot. Empty stays empty — an empty cached block is rejected, not merely useless.
  const cachedSystem = system ? [{ type: "text", text: system, cache_control: EPHEMERAL }] : undefined;

  // Needs at least three messages for a rolling breakpoint to sit on stable ground: with fewer,
  // everything present is new, and the fixed header above is already carrying the cache.
  const cachedMessages = messages.length >= 3
    ? messages.map((message, index) => (index === messages.length - 2 ? withBlockBreakpoint(message) : message))
    : messages;

  return { system: cachedSystem, messages: cachedMessages, tools: cachedTools };
}

/**
 * Puts a breakpoint on a message's final content block.
 *
 * A string body has to become a one-element block array to carry one. A message whose blocks cannot
 * take the marker is returned untouched rather than forced — a missing breakpoint costs a cache
 * miss, while a malformed one costs the whole request.
 */
function withBlockBreakpoint(message: AnthropicMessage): AnthropicMessage {
  if (typeof message.content === "string") {
    return { role: message.role, content: [{ type: "text", text: message.content, cache_control: EPHEMERAL }] };
  }
  if (!Array.isArray(message.content) || message.content.length === 0) return message;
  const blocks = message.content as Array<Record<string, unknown>>;
  return {
    role: message.role,
    content: blocks.map((block, index) => (index === blocks.length - 1 ? { ...block, cache_control: EPHEMERAL } : block)),
  };
}

export class AnthropicAgentTurnProvider implements AgentTurnProvider {
  private readonly call: MessagesCall;
  /** Read from the published table for this model id, so the session can size its own budgets. */
  readonly capabilities: ModelCapabilities;

  constructor(private readonly options: AnthropicAgentOptions, call?: MessagesCall) {
    if (!options.apiKey.trim()) throw new Error("ANTHROPIC_API_KEY is required");
    if (!options.model.trim()) throw new Error("ANTHROPIC_MODEL is required");
    this.capabilities = capabilitiesFor(options.model);
    if (call) this.call = call;
    else {
      // The SDK is loaded on first use, not at module load. It is an optional peer dependency, and
      // importing it eagerly made `import { formatMoney } from "@circuit-nova/nova-core"` crash outright
      // for anyone who had not installed it — a package that cannot be imported without a
      // dependency it calls optional is lying about the dependency.
      let client: { messages: { create(body: unknown, options: unknown): Promise<unknown> } } | undefined;
      this.call = async (body, signal) => {
        if (!client) {
          const { default: Anthropic } = await import("@anthropic-ai/sdk").catch(() => {
            // The raw ERR_MODULE_NOT_FOUND names an internal file path and leaves the reader to
            // work out that a peer dependency is missing. Say what to install instead.
            throw new Error("The Anthropic provider needs the @anthropic-ai/sdk package. Install it with: npm install @anthropic-ai/sdk");
          });
          // Retry policy is centralized in BoundedAgentRuntime; hidden SDK retries would make its
          // bounded attempt count and live progress messages inaccurate.
          client = new Anthropic({ apiKey: options.apiKey, ...(options.baseURL ? { baseURL: options.baseURL } : {}), maxRetries: 0 }) as never;
        }
        return (await client!.messages.create(body as never, { signal })) as AnthropicResponse | AsyncIterable<AnthropicStreamEvent>;
      };
    }
  }

  async complete(request: AgentModelRequest): Promise<AgentModelTurn> {
    if (!request.safetyIdentifier.trim()) throw new Error("safetyIdentifier is required");
    const converted = toAnthropicMessages(request.messages);
    const { system, messages, tools } = withCacheBreakpoints(
      converted.system,
      converted.messages,
      request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    );

    const raw = await this.call({
      model: this.options.model,
      max_tokens: request.maxOutputTokens,
      ...(system ? { system } : {}),
      messages,
      tools,
      // Deliberately no `temperature`: the current Opus and Sonnet models reject sampling
      // parameters outright, and prompting is the supported way to steer them.
      // Sent only when the caller asked for a specific effort *and* this model accepts the field.
      // `output_config` is not a header or an extra body property — it is a first-class request
      // parameter, and effort lives inside it rather than at the top level.
      ...(request.effort && this.capabilities.supportsEffort ? { output_config: { effort: request.effort } } : {}),
      metadata: { user_id: request.safetyIdentifier },
      // Streaming is unconditional, not a rendering choice. `max_tokens` is now sized from what the
      // model can actually write (64K on a current Opus or Sonnet), and an unstreamed reply that
      // large hits the SDK's HTTP timeout before it finishes — the request is billed and the answer
      // is lost. A caller that passes no `onTextDelta` simply gets the collected turn, exactly as
      // before; nothing above this line can tell the difference.
      stream: true,
    }, AbortSignal.any([
      AbortSignal.timeout(this.options.timeoutMs ?? 180_000),
      ...(request.signal ? [request.signal] : []),
    ]));

    const response = Symbol.asyncIterator in Object(raw)
      ? await collectAnthropicStream(raw as AsyncIterable<AnthropicStreamEvent>, request.onTextDelta)
      : (raw as AnthropicResponse);

    const toolCalls = response.content
      .filter((block): block is { type: "tool_use"; id: string; name: string; input: unknown } => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input }));
    const text = response.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("");

    // A refusal is a normal 200 response with an empty or partial body, so it has to be checked
    // before the content is read — code that indexes content[0] breaks here.
    if (response.stop_reason === "refusal") {
      const category = response.stop_details?.category;
      return {
        responseId: response.id,
        model: response.model,
        finishReason: "refusal",
        content: text,
        refusal: response.stop_details?.explanation?.trim() || `The model declined this request${category ? ` (${category})` : ""}.`,
        toolCalls: [],
        usage: usageOf(response),
      };
    }

    // `max_tokens` is Anthropic's name for the Chat Completions `length`: a successful response
    // that stopped early because the output budget ran out. It is checked before the tool calls
    // because a `tool_use` block that was still being written has a half-received `input`, and the
    // runtime must ask for that call again rather than execute a guess at what it would have been.
    const finishReason = response.stop_reason === "max_tokens" ? "length" : toolCalls.length > 0 ? "tool_calls" : "stop";

    return {
      responseId: response.id,
      model: response.model,
      finishReason,
      content: text,
      toolCalls: finishReason === "length" ? [] : toolCalls,
      usage: usageOf(response),
    };
  }
}
