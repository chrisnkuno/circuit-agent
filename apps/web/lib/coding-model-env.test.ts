import { describe, expect, it } from "vitest";
import { applyCodingModelEnv } from "./coding-model-env";

const base = { CODING_MODEL_PROVIDER: "circuitnotion", CIRCUITNOTION_MODEL: "gpt-4.1-nano", OPENAI_MODEL: "gpt-4.1" };

describe("applyCodingModelEnv", () => {
  it("sends the sandbox planner to the coding model while chat keeps the deployment one", () => {
    // The whole point: a plan is a long output, and paying chat-shaped rates for it is the waste.
    const env = applyCodingModelEnv({ ...base, CODING_MODEL_ID: "deepseek-v4-flash" });
    expect(env.CIRCUITNOTION_MODEL).toBe("deepseek-v4-flash");
    // The caller's own environment is never mutated, so chat still reads the original.
    expect(base.CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
  });

  it("leaves everything alone when no coding override is set", () => {
    expect(applyCodingModelEnv(base).CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
  });

  it("lets a workspace's explicit choice beat the deployment override", () => {
    const env = applyCodingModelEnv({ ...base, CODING_MODEL_ID: "deepseek-v4-flash" }, { provider: "circuitnotion", modelId: "deepseek-v4-pro" });
    expect(env.CIRCUITNOTION_MODEL).toBe("deepseek-v4-pro");
  });

  it("writes the model into the variable the chosen provider actually reads", () => {
    const env = applyCodingModelEnv({ ...base, CODING_MODEL_ID: "gpt-4.1-mini" }, { provider: "openai" });
    expect(env.CODING_MODEL_PROVIDER).toBe("openai");
    expect(env.OPENAI_MODEL).toBe("gpt-4.1-mini");
    // ...and not into another provider's.
    expect(env.CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
  });

  it("does not apply a model id chosen for one provider to a different one", () => {
    // Selecting an OpenAI model must not rename the CircuitNotion model; that would send a model
    // id to a provider that has never heard of it.
    const env = applyCodingModelEnv(base, { provider: "circuitnotion", modelId: undefined });
    expect(env.CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
  });

  it("ignores blank values rather than clearing the model", () => {
    expect(applyCodingModelEnv({ ...base, CODING_MODEL_ID: "   " }).CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
    expect(applyCodingModelEnv(base, { provider: "circuitnotion", modelId: "  " }).CIRCUITNOTION_MODEL).toBe("gpt-4.1-nano");
  });

  it("does nothing for a provider that has no model variable", () => {
    const env = applyCodingModelEnv({ CODING_MODEL_PROVIDER: "anthropic", CODING_MODEL_ID: "x" });
    expect(env.CODING_MODEL_PROVIDER).toBe("anthropic");
    expect(Object.keys(env)).not.toContain("CIRCUITNOTION_MODEL");
  });
});
