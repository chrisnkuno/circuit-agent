import { describe, expect, it } from "vitest";
import { OpenAICodingModelProvider } from "./openai";

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
  input_tokens: 400,
  output_tokens: 200,
  total_tokens: 600,
  input_tokens_details: { cached_tokens: 100, cache_write_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 50 },
};

describe("OpenAI coding model provider", () => {
  it("uses structured, non-stored Responses API requests and captures usage", async () => {
    let body: unknown;
    const provider = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async (value) => {
      body = value;
      return {
        id: "resp_1",
        model: "gpt-5.6-terra",
        status: "completed",
        output_parsed: { status: "ready", summary: "Update and test", fileChanges: [], commands: [], expectedArtifacts: ["model_plan"], blockers: [] },
        output: [],
        usage,
      };
    });
    const result = await provider.generateCodingPlan(request);
    expect(body).toMatchObject({
      model: "gpt-5.6-terra",
      store: false,
      safety_identifier: "user_hash_1",
      reasoning: { effort: "medium" },
      metadata: { task_id: "task_1", step_id: "step_1", prompt_version: "coding-planner-v1" },
    });
    expect(result).toMatchObject({ status: "planned", usage: { totalTokens: 600, cachedInputTokens: 100, reasoningTokens: 50 } });
    expect(JSON.stringify(body)).not.toContain("openai_test");
  });

  it("returns explicit refusals without fabricating a plan", async () => {
    const provider = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async () => ({
      id: "resp_refused",
      model: "gpt-5.6-terra",
      status: "completed",
      output_parsed: null,
      output: [{ type: "message", content: [{ type: "refusal", refusal: "Cannot assist." }] }],
      usage,
    }));
    await expect(provider.generateCodingPlan(request)).resolves.toMatchObject({ status: "refused", refusal: "Cannot assist." });
  });

  it("fails closed on incomplete responses or missing accounting", async () => {
    const provider = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async () => ({
      id: "resp_incomplete", model: "gpt-5.6-terra", status: "incomplete", output_parsed: null, output: [], usage,
    }));
    await expect(provider.generateCodingPlan(request)).rejects.toThrow("incomplete");
    const missingUsage = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async () => ({
      id: "resp_no_usage", model: "gpt-5.6-terra", status: "completed", output_parsed: null, output: [], usage: null,
    }));
    await expect(missingUsage.generateCodingPlan(request)).rejects.toThrow("usage accounting");
    await expect(provider.generateCodingPlan({ ...request, maxOutputTokens: 1 })).rejects.toThrow("maxOutputTokens");
    expect(() => new OpenAICodingModelProvider({ apiKey: "", model: "gpt-5.6-terra" })).toThrow("OPENAI_API_KEY");
  });

  it("refuses a request missing identity, or with an out-of-range timeout or safety identifier", async () => {
    const provider = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async () => ({
      id: "r", model: "gpt-5.6-terra", status: "completed", output_parsed: null, output: [], usage,
    }));
    await expect(provider.generateCodingPlan({ ...request, taskId: " " })).rejects.toThrow("taskId and stepId");
    await expect(provider.generateCodingPlan({ ...request, timeoutMs: 500 })).rejects.toThrow("timeoutMs");
    await expect(provider.generateCodingPlan({ ...request, safetyIdentifier: "" })).rejects.toThrow("safetyIdentifier");
    await expect(provider.generateCodingPlan({ ...request, safetyIdentifier: "x".repeat(65) })).rejects.toThrow("safetyIdentifier");
  });

  it("refuses to claim a plan exists when the response has neither a plan nor a refusal", async () => {
    // A response that is neither is not a smaller answer — it's the model doing something the
    // schema doesn't allow for, and pretending otherwise would hand the caller a null plan.
    const provider = new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" }, async () => ({
      id: "r", model: "gpt-5.6-terra", status: "completed", output_parsed: null, output: [{ type: "message", content: [{ type: "text" }] }], usage,
    }));
    await expect(provider.generateCodingPlan(request)).rejects.toThrow("neither a coding plan nor a refusal");
  });

  it("builds a real client when no call is injected", () => {
    expect(() => new OpenAICodingModelProvider({ apiKey: "openai_test", model: "gpt-5.6-terra" })).not.toThrow();
  });
});
