import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "./e2b";
import { OpenAICodingModelProvider } from "./openai";
import { createE2BProvider, createModelPriceCatalog, createOpenAIProvider } from "./factory";

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

  it("parses a versioned RWF model price catalog", () => {
    expect(createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "2000", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toEqual({
      inputRwfPerMillionTokens: 2_000,
      outputRwfPerMillionTokens: 8_000,
    });
    expect(() => createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "-1", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toThrow("positive integer");
  });
});
