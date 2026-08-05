import { describe, expect, it } from "vitest";
import { buildCircuitNotionHeaders, CircuitNotionCodingModelProvider } from "./circuitnotion";

const request = {
  taskId: "task_1",
  stepId: "step_1",
  objective: "Fix the test",
  repositoryContext: "Bun TypeScript project",
  workspaceRoot: "/workspace/repo",
  maxCommands: 4,
  maxOutputTokens: 2_000,
  timeoutMs: 30_000,
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
      return {
        id: "chatcmpl_1",
        model: "circuit-3",
        choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }],
        usage,
      };
    });
    const result = await provider.generateCodingPlan(request);
    expect(body).toMatchObject({ model: "circuit-3", response_format: { type: "json_object" } });
    expect(JSON.stringify(body)).toContain("fileChanges");
    expect(JSON.stringify(body)).toContain("expectedArtifacts");
    expect(result).toMatchObject({ status: "planned", plan, usage: { totalTokens: 600, cachedInputTokens: 100, reasoningTokens: 50 } });
    expect(JSON.stringify(body)).not.toContain("cn_test");
  });

  it("retries once on invalid JSON and sums usage across both attempts", async () => {
    let calls = 0;
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => {
      calls += 1;
      if (calls === 1) {
        return { id: "chatcmpl_bad", model: "circuit-3", choices: [{ finish_reason: "stop", message: { content: "not json" } }], usage };
      }
      return { id: "chatcmpl_good", model: "circuit-3", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }], usage };
    });
    const result = await provider.generateCodingPlan(request);
    expect(calls).toBe(2);
    expect(result).toMatchObject({ status: "planned", plan, usage: { totalTokens: 1_200, inputTokens: 800 } });
  });

  it("fails closed after a second invalid response", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => ({
      id: "chatcmpl_bad", model: "circuit-3", choices: [{ finish_reason: "stop", message: { content: "still not json" } }], usage,
    }));
    await expect(provider.generateCodingPlan(request)).rejects.toThrow("after one retry");
  });

  it("returns explicit refusals without fabricating a plan", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => ({
      id: "chatcmpl_refused", model: "circuit-3", choices: [{ finish_reason: "stop", message: { content: null, refusal: "Cannot assist." } }], usage,
    }));
    await expect(provider.generateCodingPlan(request)).resolves.toMatchObject({ status: "refused", refusal: "Cannot assist." });
  });

  it("fails closed on truncated responses or missing accounting", async () => {
    const provider = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => ({
      id: "chatcmpl_len", model: "circuit-3", choices: [{ finish_reason: "length", message: { content: JSON.stringify(plan) } }], usage,
    }));
    await expect(provider.generateCodingPlan(request)).rejects.toThrow("length");

    const missingUsage = new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "circuit-3" }, async () => ({
      id: "chatcmpl_no_usage", model: "circuit-3", choices: [{ finish_reason: "stop", message: { content: JSON.stringify(plan) } }], usage: null,
    }));
    await expect(missingUsage.generateCodingPlan(request)).rejects.toThrow("usage accounting");

    expect(() => new CircuitNotionCodingModelProvider({ apiKey: "", model: "circuit-3" })).toThrow("CIRCUITNOTION_API_KEY");
    expect(() => new CircuitNotionCodingModelProvider({ apiKey: "cn_test", model: "" })).toThrow("CIRCUITNOTION_MODEL");
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
