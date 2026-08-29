import { describe, expect, it } from "vitest";
import { buildCircuitNotionHeaders, CircuitNotionCodingModelProvider, type ChatCompletionChunk } from "@circuit-nova/nova-core/providers/circuitnotion";
import { maxAttemptsForFailure } from "../worker-runtime";

/** A complete response delivered the way the wire delivers it: content split across chunks. */
async function* streamOf(options: { content?: string | null; refusal?: string; finish?: string; usage?: unknown; id?: string }) {
  yield { id: options.id ?? "chatcmpl_1", model: "circuit-3", choices: [{ delta: {} }] } as ChatCompletionChunk;
  for (const piece of (options.content ?? "").match(/[\s\S]{1,8}/g) ?? []) {
    yield { choices: [{ delta: { content: piece } }] } as ChatCompletionChunk;
  }
  if (options.refusal) yield { choices: [{ delta: { refusal: options.refusal } }] } as ChatCompletionChunk;
  yield { choices: [{ delta: {}, finish_reason: options.finish ?? "stop" }] } as ChatCompletionChunk;
  yield { choices: [], usage: options.usage } as ChatCompletionChunk;
}

const request = {
  taskId: "task_1",
  stepId: "step_1",
  objective: "Fix the test",
  repositoryContext: "Bun TypeScript project",
  workspaceRoot: "/workspace/repo",
  maxCommands: 4,
  maxOutputTokens: 2_000,
  timeoutMs: 30_000,
  idleTimeoutMs: 5_000,
  reasoningEffort: "medium" as const,
  safetyIdentifier: "user_hash_1",
};

const usage = {
  prompt_tokens: 400,
  completion_tokens: 200,
  total_tokens: 600,
  prompt_tokens_details: { cached_tokens: 100 },
  completion_tokens_details: { reasoning_tokens: 50 },
};

const plan = { status: "ready" as const, summary: "Update and test", fileChanges: [], commands: [], expectedArtifacts: ["model_plan" as const], blockers: [] };

describe("CircuitNotion coding model provider", () => {
  it("uses Chat Completions with JSON mode and captures usage", async () => {
    let body: unknown;
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async (value) => {
      body = value;
      return streamOf({ content: JSON.stringify(plan), usage });
    });
    const result = await provider.generateCodingPlan(request);
    expect(body).toMatchObject({ model: "circuit-3", response_format: { type: "json_object" }, stream: true, stream_options: { include_usage: true } });
    expect(JSON.stringify(body)).toContain("fileChanges");
    expect(JSON.stringify(body)).toContain("expectedArtifacts");
    expect(result).toMatchObject({ status: "planned", plan, usage: { totalTokens: 600, cachedInputTokens: 100, reasoningTokens: 50 } });
    expect(JSON.stringify(body)).not.toContain("cn_test");
  });

  it("retries once on invalid JSON and sums usage across both attempts", async () => {
    let calls = 0;
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => {
      calls += 1;
      if (calls === 1) return streamOf({ id: "chatcmpl_bad", content: "not json", usage });
      return streamOf({ id: "chatcmpl_good", content: JSON.stringify(plan), usage });
    });
    const result = await provider.generateCodingPlan(request);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "planned", plan, usage: { totalTokens: 1_200, inputTokens: 800 } });
  });

  it("fails closed after a second invalid response", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => streamOf({ content: "still not json", usage }));
    await expect(provider.generateCodingPlan(request)).rejects.toThrow("after one retry");
  });

  it("returns explicit refusals without fabricating a plan", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => streamOf({ content: null, refusal: "Cannot assist.", usage }));
    await expect(provider.generateCodingPlan(request)).resolves.toMatchObject({ status: "refused", refusal: "Cannot assist." });
  });

  it("fails closed on truncated responses and conservatively meters missing accounting", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => streamOf({ content: JSON.stringify(plan), finish: "length", usage }));
    // Still fails closed — half a JSON object is not a smaller plan — but the message now names the
    // limit that was hit, since "length" reads like a network fault rather than an output budget.
    await expect(provider.generateCodingPlan(request)).rejects.toThrow(/ran out of output budget/);

    const missingUsage = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => streamOf({ content: JSON.stringify(plan), usage: null }));
    await expect(missingUsage.generateCodingPlan(request)).resolves.toMatchObject({
      status: "planned",
      usage: {
        outputTokens: request.maxOutputTokens,
        cachedInputTokens: 0,
        reasoningTokens: 0,
      },
    });

    expect(() => new CircuitNotionCodingModelProvider({ apiKey: "", model: "circuit-3" })).toThrow("CIRCUITNOTION_API_KEY");
    expect(() => new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "" })).toThrow("CIRCUITNOTION_MODEL");
  });
});

describe("streaming deadlines", () => {
  it("accepts a plan that takes far longer than the old buffered ceiling, as long as tokens keep arriving", async () => {
    const json = JSON.stringify(plan);
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async function* () {
      for (const character of json) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield { id: "chatcmpl_slow", model: "circuit-3", choices: [{ delta: { content: character } }] } as ChatCompletionChunk;
      }
      yield { choices: [{ delta: {}, finish_reason: "stop" }], usage } as ChatCompletionChunk;
    } as never);
    // No single gap approaches the idle budget, so the total elapsed time is irrelevant.
    await expect(provider.generateCodingPlan({ ...request, idleTimeoutMs: 1_000 })).resolves.toMatchObject({ status: "planned", plan });
  });

  it("abandons a stream that goes quiet, and says so instead of reporting a bare abort", async () => {
    // Mirrors the SDK: the iterator ends by rejecting once the request signal aborts.
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async (_body, signal) => (async function* () {
      yield { id: "chatcmpl_stall", model: "circuit-3", choices: [{ delta: { content: "{" } }] } as ChatCompletionChunk;
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Request was aborted."))));
    })());
    await expect(provider.generateCodingPlan({ ...request, idleTimeoutMs: 1_000 })).rejects.toThrow("produced no output for 1s");
  });

  it("reports a stall distinctly enough that it does not buy three full retries", () => {
    expect(maxAttemptsForFailure(new Error("Model stream produced no output for 45s and was abandoned"), 3)).toBe(2);
  });

  it("rejects an idle budget larger than the call's own ceiling", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => streamOf({ content: JSON.stringify(plan), usage }));
    await expect(provider.generateCodingPlan({ ...request, idleTimeoutMs: 60_000 })).rejects.toThrow("idleTimeoutMs");
  });
});

describe("buildCircuitNotionHeaders", () => {
  it("always sends a browser-like User-Agent", () => {
    expect(buildCircuitNotionHeaders()["User-Agent"]).toContain("Mozilla/5.0");
  });

  it("only includes the relay secret header when a relay secret is configured", () => {
    expect(buildCircuitNotionHeaders()).not.toHaveProperty("x-relay-secret");
    expect(buildCircuitNotionHeaders("relay-secret-value")["x-relay-secret"]).toBe("relay-secret-value");
  });
});
