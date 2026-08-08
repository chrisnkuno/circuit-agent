import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../agent-runtime";
import { priceUsage, toUnits } from "../money";
import { availableProviders, isProviderId, PROVIDERS, resolveProvider, resolvePrices } from "./agent-matrix";
import { AnthropicAgentTurnProvider, toAnthropicMessages } from "./anthropic-agent";

describe("provider matrix", () => {
  it("offers only providers whose credentials are actually present", () => {
    expect(availableProviders({}).map((spec) => spec.id)).toEqual([]);
    expect(availableProviders({ ANTHROPIC_API_KEY: "sk-ant" }).map((spec) => spec.id)).toEqual(["anthropic"]);
    expect(availableProviders({ ANTHROPIC_API_KEY: "k", CIRCUITNOTION_API_KEY: "k" }).map((spec) => spec.id)).toEqual(["anthropic", "circuitnotion"]);
  });

  it("names the provider the user asked for when its credentials are missing", () => {
    // Falling back silently would answer a question nobody asked.
    expect(resolveProvider({ ANTHROPIC_API_KEY: "k" }, { provider: "openai" })).toEqual({ error: "OpenAI needs OPENAI_API_KEY." });
    expect(resolveProvider({}, { provider: "wat" })).toMatchObject({ error: expect.stringContaining("Unknown provider") });
    expect(resolveProvider({})).toMatchObject({ error: expect.stringContaining("No model provider is configured") });
  });

  it("resolves a provider, its model, and its published price", () => {
    const resolved = resolveProvider({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect("error" in resolved).toBe(false);
    if ("error" in resolved) return;

    expect(resolved.spec.id).toBe("anthropic");
    expect(resolved.model).toBe("claude-opus-5");
    expect(resolved.prices?.currency).toBe("USD");
    // $5 per million input tokens, held in micros.
    expect(resolved.prices?.inputPerMillion).toBe(5_000_000);
  });

  it("takes the model from an explicit flag, then the environment, then the default", () => {
    const environment = { ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5" };
    expect((resolveProvider(environment) as { model: string }).model).toBe("claude-sonnet-5");
    expect((resolveProvider(environment, { model: "claude-haiku-4-5" }) as { model: string }).model).toBe("claude-haiku-4-5");
  });

  it("prefers a configured rate over the published catalog", () => {
    // A negotiated rate is real; a list price is only a default.
    const prices = resolvePrices(PROVIDERS.anthropic, "claude-opus-5", {
      MODEL_PRICE_CURRENCY: "RWF",
      MODEL_INPUT_PER_MILLION: "2000",
      MODEL_OUTPUT_PER_MILLION: "8000",
    });
    expect(prices?.currency).toBe("RWF");
    expect(prices?.inputPerMillion).toBe(2_000_000_000);
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

  it("sends tools in Anthropic's schema and no sampling parameters", async () => {
    let body: Record<string, unknown> | undefined;
    const provider = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async (value) => {
      body = value;
      return { id: "msg_1", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }], usage };
    });

    const turn = await provider.complete(request);
    expect(body).toMatchObject({ model: "claude-opus-5", max_tokens: 4_096, system: "sys" });
    expect(body!.tools).toEqual([{ name: "read_file", description: "Read a file", input_schema: { type: "object" } }]);
    // Current Opus and Sonnet models reject sampling parameters outright.
    expect(body).not.toHaveProperty("temperature");
    expect(turn).toMatchObject({ finishReason: "stop", content: "Done." });
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

  it("fails closed on a truncated response and on missing accounting", async () => {
    const truncated = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "m", model: "claude-opus-5", stop_reason: "max_tokens", content: [{ type: "text", text: "half" }], usage,
    }));
    await expect(truncated.complete(request)).rejects.toThrow(/max_tokens/);

    const noUsage = new AnthropicAgentTurnProvider({ apiKey: "sk-ant", model: "claude-opus-5" }, async () => ({
      id: "m", model: "claude-opus-5", stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: null,
    }));
    await expect(noUsage.complete(request)).rejects.toThrow(/usage accounting/);

    expect(() => new AnthropicAgentTurnProvider({ apiKey: "", model: "claude-opus-5" })).toThrow("ANTHROPIC_API_KEY");
  });

  it("prices a real Anthropic turn through the catalog", () => {
    const prices = PROVIDERS.anthropic.prices["claude-opus-5"];
    const cost = { inputTokens: 100_000, outputTokens: 2_000, cachedInputTokens: 90_000 };
    // 10k uncached at $5/M + 90k cached at $0.50/M + 2k output at $25/M.
    const total = (10_000 * 5 + 90_000 * 0.5 + 2_000 * 25) / 1_000_000;
    expect(toUnits(priceUsage(cost, prices))).toBeCloseTo(total, 6);
  });
});
