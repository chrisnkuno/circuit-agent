import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "./e2b";
import { OpenAICodingModelProvider } from "./openai";
import { CircuitNotionCodingModelProvider } from "./circuitnotion";
import { createCircuitNotionAgentProvider, createCircuitNotionProvider, createCodingModelProvider, createE2BProvider, createModelPriceCatalog, createOpenAIProvider } from "./factory";

describe("provider factory", () => {
  it("keeps E2B disabled until both credential and approved template exist", () => {
    expect(createE2BProvider({ E2B_API_KEY: "e2b_test" })).toBeUndefined();
    expect(createE2BProvider({ E2B_CODING_TEMPLATE: "circuit-coding" })).toBeUndefined();
  });

  it("creates the concrete provider from explicit configuration", () => {
    expect(createE2BProvider({ E2B_API_KEY: "e2b_test", E2B_CODING_TEMPLATE: "circuit-coding" })).toBeInstanceOf(E2BSandboxProvider);
  });

  it("creates the OpenAI provider only with an explicit model", () => {
    expect(createOpenAIProvider({ OPENAI_API_KEY: "openai_test" })).toBeUndefined();
    expect(createOpenAIProvider({ OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra" })).toBeInstanceOf(OpenAICodingModelProvider);
  });

  it("creates the CircuitNotion provider only with an explicit model", () => {
    expect(createCircuitNotionProvider({ CIRCUITNOTION_API_KEY: "cn_test" })).toBeUndefined();
    expect(createCircuitNotionProvider({ CIRCUITNOTION_API_KEY: "cn_test", CIRCUITNOTION_MODEL: "circuit-3" })).toBeInstanceOf(CircuitNotionCodingModelProvider);
  });

  it("creates the CircuitNotion multi-turn agent provider from the same explicit identity", () => {
    expect(createCircuitNotionAgentProvider({ CIRCUITNOTION_API_KEY: "cn_test", CIRCUITNOTION_MODEL: "gpt-5.6-luna" })).toBeDefined();
    expect(createCircuitNotionAgentProvider({ CIRCUITNOTION_API_KEY: "cn_test" })).toBeUndefined();
  });

  it("selects the coding model provider explicitly, never by whichever credential is present", () => {
    expect(createCodingModelProvider({ OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra" })).toBeUndefined();
    expect(createCodingModelProvider({
      CODING_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra",
    })).toBeInstanceOf(OpenAICodingModelProvider);
    expect(createCodingModelProvider({
      CODING_MODEL_PROVIDER: "circuitnotion", CIRCUITNOTION_API_KEY: "cn_test", CIRCUITNOTION_MODEL: "circuit-3",
    })).toBeInstanceOf(CircuitNotionCodingModelProvider);
    expect(createCodingModelProvider({ CODING_MODEL_PROVIDER: "unknown-provider", OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra" })).toBeUndefined();
  });

  it("parses a versioned RWF model price catalog", () => {
    expect(createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "2000", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toEqual({
      inputRwfPerMillionTokens: 2_000,
      outputRwfPerMillionTokens: 8_000,
    });
    expect(() => createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "-1", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toThrow("positive integer");
  });
});
