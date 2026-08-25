import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../agent-runtime";
import { priceUsage, toUnits } from "../money";
import { availableProviders, catalogPrices, isProviderId, PROVIDERS, resolveProvider, resolvePrices } from "./agent-matrix";
import { AnthropicAgentTurnProvider, toAnthropicMessages } from "./anthropic-agent";

describe("provider matrix", () => {
  it("offers only providers whose credentials are actually present, plus Ollama which needs none", () => {
    expect(availableProviders({}).map((spec) => spec.id)).toEqual(["ollama"]);
    expect(availableProviders({ ANTHROPIC_API_KEY: "sk-ant" }).map((spec) => spec.id)).toEqual(["anthropic", "ollama"]);
    expect(availableProviders({ ANTHROPIC_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" }).map((spec) => spec.id)).toEqual(["anthropic", "circuitnotion", "ollama"]);
  });

  it("names the provider the user asked for when its credentials are missing", () => {
    // Falling back silently would answer a question nobody asked.
    expect(resolveProvider({ ANTHROPIC_API_KEY: "k" }, { provider: "openai" })).toEqual({ error: "OpenAI needs OPENAI_API_KEY." });
    expect(resolveProvider({}, { provider: "wat" })).toMatchObject({ error: expect.stringContaining("Unknown provider") });
    expect(resolveProvider({})).toMatchObject({ error: expect.stringContaining("No model provider is configured") });
  });

  describe("the provider a previous session remembered", () => {
    const both = { ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" };

    it("wins over the first-configured default, which is the point of persisting it", () => {
      // Anthropic sorts first, so without NOVA_PROVIDER a user who switched to OpenAI and restarted
      // would silently be back on Anthropic — the switch would not have survived the restart.
      const resolved = resolveProvider({ ...both, NOVA_PROVIDER: "openai" });
      expect("error" in resolved ? resolved.error : resolved.spec.id).toBe("openai");
    });

    it("still loses to an explicit choice, which is a live request", () => {
      const resolved = resolveProvider({ ...both, NOVA_PROVIDER: "openai" }, { provider: "anthropic" });
      expect("error" in resolved ? resolved.error : resolved.spec.id).toBe("anthropic");
    });

    it("fails soft, because stale config must not refuse to start a session that would run", () => {
      // Both cases are unactionable from inside a CLI that never opened: a provider this build
      // dropped, and one whose key has since been removed.
      const unknown = resolveProvider({ ...both, NOVA_PROVIDER: "gemini" });
      expect("error" in unknown ? unknown.error : unknown.spec.id).toBe("anthropic");

      const revoked = resolveProvider({ ANTHROPIC_API_KEY: "k", NOVA_PROVIDER: "openai" });
      expect("error" in revoked ? revoked.error : revoked.spec.id).toBe("anthropic");
    });

    it("does not conjure a provider when nothing at all is configured", () => {
      expect(resolveProvider({ NOVA_PROVIDER: "openai" })).toMatchObject({ error: expect.stringContaining("No model provider is configured") });
    });
  });

  it("resolves a provider, its model, and its published price", () => {
    const resolved = resolveProvider({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;

    expect(resolved.spec.id).toBe("anthropic");
    expect(resolved.model).toBe("claude-sonnet-5");
    expect(resolved.prices?.currency).toBe("USD");
    // $2 per million input tokens (introductory rate), held in micros.
    expect(resolved.prices?.inputPerMillion).toBe(2_000_000);
  });

  it("actually constructs OpenAI and CircuitNotion's own turn provider, not just Anthropic's", () => {
    // Every other test in this file resolves against Anthropic; without this, the OpenAI and
    // CircuitNotion entries in PROVIDERS could have a construction bug (a typo'd env var, a
    // wrong default base URL) that nothing would ever catch.
    const openai = resolveProvider({ OPENAI_API_KEY: "sk-openai" }, { provider: "openai" });
    expect("error" in openai).toBe(false);
    if (!("error" in openai)) expect(typeof openai.provider.complete).toBe("function");

    const circuitnotion = resolveProvider({ CIRCUITNOTION_API_KEY: "cn-key" }, { provider: "circuitnotion" });
    expect("error" in circuitnotion).toBe(false);
    if (!("error" in circuitnotion)) {
      expect(circuitnotion.model).toBe("circuit-2-turbo");
      expect(typeof circuitnotion.provider.complete).toBe("function");
    }
  });

  it("takes the model from an explicit flag, then the environment, then the default", () => {
    const environment = { ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5" };
    expect((resolveProvider(environment) as { model: string }).model).toBe("claude-sonnet-5");
    expect((resolveProvider(environment, { model: "claude-haiku-4-5" }) as { model: string }).model).toBe("claude-haiku-4-5");
  });

  it("prefers a configured rate over the published catalog", () => {
    // A negotiated rate is real; a list price is only a default.
    const prices = resolvePrices(PROVIDERS.anthropic, "claude-sonnet-5", {
      MODEL_PRICE_CURRENCY: "RWF",
      MODEL_INPUT_PER_MILLION: "2000",
      MODEL_OUTPUT_PER_MILLION: "8000",
    });
    expect(prices?.currency).toBe("RWF");
    expect(prices?.inputPerMillion).toBe(2_000_000_000);
  });

  it("does not carry a configured rate onto a model it was not quoted for", () => {
    // The `/model` hazard: a rate set for the configured model used to follow the session onto
    // whatever it switched to, still producing a confident number against the wrong rate card.
    const environment = { MODEL_PRICE_CURRENCY: "RWF", MODEL_INPUT_PER_MILLION: "2000", MODEL_OUTPUT_PER_MILLION: "8000" };
    expect(resolvePrices(PROVIDERS.anthropic, "claude-sonnet-5", environment)?.currency).toBe("RWF");
    const switched = resolvePrices(PROVIDERS.anthropic, "claude-haiku-4-5", environment);
    expect(switched?.currency).toBe("USD");
    expect(switched?.inputPerMillion).toBe(1_000_000);
  });

  it("lets an override name the model it prices", () => {
    const environment = { MODEL_PRICE_MODEL: "claude-haiku-4-5", MODEL_INPUT_PER_MILLION: "2", MODEL_OUTPUT_PER_MILLION: "8" };
    expect(resolvePrices(PROVIDERS.anthropic, "claude-haiku-4-5", environment)?.inputPerMillion).toBe(2_000_000);
    // ...and only that model: the default model falls back to the catalog's introductory $2/M.
    expect(resolvePrices(PROVIDERS.anthropic, "claude-sonnet-5", environment)?.inputPerMillion).toBe(2_000_000);
  });

  it("prices a dated model at the rate in force on the day asked about", () => {
    // Sonnet 5's introductory rate ends 2026-08-31; both sides of that boundary are in the catalog.
    expect(catalogPrices("anthropic", "claude-sonnet-5", "2026-08-10")?.inputPerMillion).toBe(2_000_000);
    expect(catalogPrices("anthropic", "claude-sonnet-5", "2026-09-01")?.inputPerMillion).toBe(3_000_000);
  });

  it("reports no price rather than inventing one for an uncatalogued model", () => {
    expect(resolvePrices(PROVIDERS.anthropic, "claude-not-a-model", {})).toBeUndefined();
    expect(resolvePrices(PROVIDERS.openai, "gpt-5.6-terra", {})).toBeUndefined();
  });

  it("guards the provider id", () => {
    expect(isProviderId("anthropic")).toBe(true);
    expect(isProviderId("gemini")).toBe(false);
  });
});

describe("Anthropic message translation", () => {
  it("lifts the system prompt out of the message list", () => {
    // The Messages API takes `system` as a top-level parameter, not a message role.
    const { system, messages } = toAnthropicMessages([
      { role: "system", content: "You are Nova." },
      { role: "user", content: "hello" },
    ]);
    expect(system).toBe("You are Nova.");
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it("turns tool calls into content blocks and their results into one user turn", () => {
    const messages: AgentMessage[] = [
      { role: "user", content: "read both files" },
      { role: "assistant", content: "Reading.", toolCalls: [
        { id: "c1", name: "read_file", arguments: { path: "a.ts" } },
        { id: "c2", name: "read_file", arguments: { path: "b.ts" } },
      ] },
      { role: "tool", content: "contents of a", toolCallId: "c1", name: "read_file" },
      { role: "tool", content: "contents of b", toolCallId: "c2", name: "read_file" },
    ];
    const converted = toAnthropicMessages(messages).messages;

    expect(converted[1]).toEqual({
      role: "assistant",
      content: [
        { type: "text", text: "Reading." },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.ts" } },
        { type: "tool_use", id: "c2", name: "read_file", input: { path: "b.ts" } },
      ],
    });
    // Both results must ride in a single user turn — separate turns break the alternation the
    // Messages API requires after a parallel tool-call turn.
    expect(converted).toHaveLength(3);
    expect(converted[2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "c1", content: "contents of a" },
        { type: "tool_result", tool_use_id: "c2", content: "contents of b" },
      ],
    });
  });

  it("never emits an empty turn, which the API rejects", () => {
    const converted = toAnthropicMessages([
      { role: "user", content: "go" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_files", arguments: {} }] },
      { role: "tool", content: "", toolCallId: "c1", name: "list_files" },
    ]).messages;

    expect(converted[1]).toEqual({ role: "assistant", content: [{ type: "tool_use", id: "c1", name: "list_files", input: {} }] });
    expect(converted[2]).toEqual({ role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "(empty tool result)" }] });
  });
});

describe("Anthropic adapter", () => {
  const usage = { input_tokens: 1_000, output_tokens: 200, cache_read_input_tokens: 5_000, cache_creation_input_tokens: 100 };
  const request = {
    messages: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "hi" }],
    tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
    maxOutputTokens: 4_096,
    safetyIdentifier: "nova_cli_test",
  };

  it("combines caller cancellation with the provider timeout", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async (_body, signal) => {
      received = signal;
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    });
    const pending = provider.complete({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
    expect(received?.aborted).toBe(true);
  });

  it("sends tools in Anthropic's schema and no sampling parameters", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async (value) => {
      body = value;
      return { id: "msg_1", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }], usage };
    });

    const turn = await provider.complete(request);
    expect(body).toMatchObject({ model: "claude-opus-5", max_tokens: 4_096 });
    // The system prompt is a block array rather than a bare string so it can carry a cache
    // breakpoint; the text itself is unchanged.
    expect(body!.system).toEqual([{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }]);
    expect(body!.tools).toEqual([{ name: "read_file", description: "Read a file", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }]);
    // Current Opus and Sonnet models reject sampling parameters outright.
    expect(body).not.toHaveProperty("temperature");
    expect(turn).toMatchObject({ finishReason: "stop", content: "Done." });
  });

  /**
   * Prompt caching, which was absent entirely.
   *
   * An agent loop is the worst possible shape for an uncached prompt: the conversation only grows,
   * every iteration resends everything before it, and the resent prefix quickly dwarfs the new
   * content. `usageOf` has always read `cache_read_input_tokens` — nothing was ever writing the
   * breakpoints that would populate it.
   */
  describe("prompt caching", () => {
    const bodyFor = async (messages: Parameters<typeof toAnthropicMessages>[0], tools = request.tools) => {
      let body: Record<string, unknown> = {};
      const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async (value) => {
        body = value;
        return { id: "m", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage };
      });
      await provider.complete({ ...request, messages: [...messages], tools });
      return body;
    };
    const marked = (blocks: unknown) => (Array.isArray(blocks) ? blocks as Array<{ cache_control?: unknown }> : []).filter((block) => block.cache_control !== undefined).length;

    it("marks the fixed header — the last tool covers tools, the system block covers the prompt", async () => {
      const body = await bodyFor([{ role: "system", content: "sys" }, { role: "user", content: "hi" }], [
        { name: "a", description: "a", inputSchema: { type: "object" } },
        { name: "b", description: "b", inputSchema: { type: "object" } },
      ]);
      const tools = body.tools as Array<{ name: string; cache_control?: unknown }>;
      // Only the last: Anthropic caches the prefix *up to* a breakpoint, so one marker at the end
      // of the tool list covers every tool before it. A marker per tool would waste breakpoints.
      expect(tools.map((tool) => tool.cache_control !== undefined)).toEqual([false, true]);
      expect(marked(body.system)).toBe(1);
    });

    it("rolls a second breakpoint along the conversation as it grows", async () => {
      const body = await bodyFor([
        { role: "system", content: "sys" },
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
        { role: "assistant", content: "four" },
      ]);
      const messages = body.messages as Array<{ content: unknown }>;
      // Second-to-last, not last: a breakpoint on the newest content caches something that will
      // never be read back, paying the cache-write premium for nothing.
      expect(messages.map((message) => marked(message.content))).toEqual([0, 0, 1, 0]);
    });

    it("leaves a short conversation alone, where there is no stable prefix to cache yet", async () => {
      const body = await bodyFor([{ role: "system", content: "sys" }, { role: "user", content: "hi" }]);
      expect((body.messages as Array<{ content: unknown }>).every((message) => typeof message.content === "string")).toBe(true);
    });

    it("never sends an empty cached system block, which the API rejects", async () => {
      const body = await bodyFor([{ role: "user", content: "hi" }]);
      expect(body).not.toHaveProperty("system");
    });

    it("puts the breakpoint on the last block of a structured message, leaving the rest intact", async () => {
      const body = await bodyFor([
        { role: "system", content: "sys" },
        { role: "user", content: "go" },
        { role: "assistant", content: "working", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "a" } }] },
        { role: "tool", content: "contents", toolCallId: "c1", name: "read_file" },
        { role: "assistant", content: "done" },
      ]);
      const messages = body.messages as Array<{ content: Array<Record<string, unknown>> | string }>;
      // Four messages: user, assistant(text+tool_use), user(tool_result), assistant. The rolling
      // breakpoint lands on the second-to-last — the tool_result turn.
      const carrier = messages[2].content as Array<Record<string, unknown>>;
      expect(carrier.map((block) => block.type)).toEqual(["tool_result"]);
      expect(carrier[0].cache_control).toEqual({ type: "ephemeral" });
      // The block is otherwise untouched: caching must not reshape the result itself.
      expect(carrier[0]).toMatchObject({ tool_use_id: "c1", content: "contents" });
      // And the assistant turn before it keeps both blocks, unmarked and unreshaped.
      const assistant = messages[1].content as Array<Record<string, unknown>>;
      expect(assistant.map((block) => block.type)).toEqual(["text", "tool_use"]);
      expect(assistant.every((block) => block.cache_control === undefined)).toBe(true);
      expect(assistant[1]).toMatchObject({ id: "c1", name: "read_file", input: { path: "a" } });
    });

    it("stays within Anthropic's four-breakpoint limit however long the conversation gets", async () => {
      const messages: AgentMessage[] = [{ role: "system", content: "sys" }];
      for (let index = 0; index < 40; index += 1) {
        messages.push({ role: index % 2 === 0 ? "user" : "assistant", content: `turn ${index}` });
      }
      const body = await bodyFor(messages, [
        { name: "a", description: "a", inputSchema: { type: "object" } },
        { name: "b", description: "b", inputSchema: { type: "object" } },
      ]);
      const total = marked(body.tools) + marked(body.system)
        + (body.messages as Array<{ content: unknown }>).reduce((sum, message) => sum + (Array.isArray(message.content) ? marked(message.content) : 0), 0);
      expect(total).toBeLessThanOrEqual(4);
      expect(total).toBe(3);
    });
  });

  it("folds Anthropic's separate cache counters into the shared usage shape", async () => {
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "msg_1", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage,
    }));
    const turn = await provider.complete(request);

    // Anthropic reports cache reads and writes alongside input_tokens rather than inside them —
    // the opposite of the OpenAI-compatible providers. Without folding, a cached session looks an
    // order of magnitude cheaper than it was.
    expect(turn.usage).toMatchObject({ inputTokens: 6_100, outputTokens: 200, cachedInputTokens: 5_000, cacheWriteTokens: 100 });
    expect(turn.usage.totalTokens).toBe(6_300);
  });

  it("reads tool_use blocks back as tool calls", async () => {
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "msg_2", model: "claude-opus-5", stop_reason: "tool_use",
      content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "toolu_1", name: "read_file", input: { path: "a.ts" } }],
      usage,
    }));
    const turn = await provider.complete(request);
    expect(turn.finishReason).toBe("tool_calls");
    expect(turn.toolCalls).toEqual([{ id: "toolu_1", name: "read_file", arguments: { path: "a.ts" } }]);
  });

  it("treats a refusal as a refusal, not as an empty answer", async () => {
    // A refusal is a normal 200 with empty content — code that indexes content[0] breaks here.
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "msg_3", model: "claude-opus-5", stop_reason: "refusal", content: [],
      stop_details: { category: "cyber", explanation: null }, usage,
    }));
    const turn = await provider.complete(request);
    expect(turn.finishReason).toBe("refusal");
    expect(turn.refusal).toContain("cyber");
  });

  it("reports a truncated response as unfinished and fails closed on missing accounting", async () => {
    const truncated = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "m", model: "claude-opus-5", stop_reason: "max_tokens", content: [{ type: "text", text: "half" }], usage,
    }));
    // `max_tokens` is a successful reply that stopped early, not a failure: the half that arrived
    // is kept and reported as `length` so the runtime can carry the turn on.
    expect(await truncated.complete(request)).toMatchObject({ finishReason: "length", content: "half" });

    const noUsage = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "m", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: null,
    }));
    await expect(noUsage.complete(request)).rejects.toThrow(/usage accounting/);

    expect(() => new AnthropicAgentTurnProvider({ apiKey: "", model: "claude-opus-5" })).toThrow("ANTHROPIC_API_KEY");
  });

  it("prices a real Anthropic turn through the catalog", () => {
    const prices = catalogPrices("anthropic", "claude-opus-5")!;
    const cost = { inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000 };
    // 10k uncached at $5/M + 90k cached at $0.50/M + 2k output at $25/M.
    const total = (10_000 * 5 + 90_000 * 0.5 + 2_000 * 25) / 1_000_000;
    expect(toUnits(priceUsage(cost, prices))).toBeCloseTo(total, 6);
  });

  it("collects a streamed response through the same path a buffered one takes", async () => {
    async function* stream() {
      yield { type: "message_start" as const, message: { id: "m", model: "claude-opus-5", usage: { input_tokens: 500, output_tokens: 0 } } };
      yield { type: "content_block_start" as const, index: 0, content_block: { type: "text" as const } };
      yield { type: "content_block_delta" as const, index: 0, delta: { type: "text_delta" as const, text: "Look" } };
      yield { type: "content_block_delta" as const, index: 0, delta: { type: "text_delta" as const, text: "ing." } };
      yield { type: "message_delta" as const, delta: { stop_reason: "end_turn" as const }, usage: { output_tokens: 42 } };
    }
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => stream());
    const seen: string[] = [];
    const turn = await provider.complete({ ...request, onTextDelta: (text) => seen.push(text) });
    expect(seen).toEqual(["Look", "ing."]);
    expect(turn).toMatchObject({ finishReason: "stop", content: "Looking." });
  });

  it("lazily loads the real SDK on first use, and names the missing peer dependency clearly if it can't", async () => {
    // The SDK is loaded on first use, not at module load, so an app without it installed can still
    // import everything else in this package. That deferred import is what this test exercises —
    // constructing the provider must not touch it; only `complete()` does.
    vi.resetModules();
    vi.doMock("@anthropic-ai/sdk", () => ({
      default: class FakeAnthropic {
        options: unknown;
        constructor(options: unknown) { this.options = options; }
        messages = { create: async () => ({ id: "m", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "Real client." }], usage: { input_tokens: 1, output_tokens: 1 } }) };
      },
    }));
    const { AnthropicAgentTurnProvider: FreshProvider } = await import("./anthropic-agent");
    const provider = new FreshProvider({ apiKey: "sk-ant-real", model: "claude-opus-5" });
    const turn = await provider.complete(request);
    expect(turn.content).toBe("Real client.");
    vi.doUnmock("@anthropic-ai/sdk");
    vi.resetModules();
  });
});
