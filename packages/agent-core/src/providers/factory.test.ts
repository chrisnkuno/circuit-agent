import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "./e2b";
import { DockerSandboxProvider } from "./docker";
import { OpenAICodingModelProvider } from "./openai";
import { OpenAIAgentTurnProvider } from "./openai-agent";
import { CircuitNotionCodingModelProvider } from "./circuitnotion";
import { CircuitNotionAgentTurnProvider } from "./circuitnotion-agent";
import { CircuitNotionPresetsProvider } from "./circuitnotion-presets";
import { createAgentTurnProvider, createCircuitNotionAgentProvider, createCircuitNotionProvider, createCodingModelProvider, createCodingSandboxProvider, createDockerProvider, createDynamicPresetsProvider, createE2BProvider, createModelPriceCatalog, createOpenAIProvider } from "./factory";

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

  it("selects Nova messaging's turn provider explicitly", () => {
    expect(createAgentTurnProvider({ OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra" })).toBeUndefined();
    expect(createAgentTurnProvider({
      CODING_MODEL_PROVIDER: "openai", OPENAI_API_KEY: "openai_test", OPENAI_MODEL: "gpt-5.6-terra",
    })).toBeInstanceOf(OpenAIAgentTurnProvider);
    expect(createAgentTurnProvider({
      CODING_MODEL_PROVIDER: "circuitnotion", CIRCUITNOTION_API_KEY: "cn_test", CIRCUITNOTION_MODEL: "circuit-3",
    })).toBeInstanceOf(CircuitNotionAgentTurnProvider);
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

  it("keeps Docker disabled until a coding image is configured", () => {
    expect(createDockerProvider({})).toBeUndefined();
    expect(createDockerProvider({ DOCKER_CODING_IMAGE: "circuit-nova-coding:latest" })).toBeInstanceOf(DockerSandboxProvider);
  });

  it("selects E2B by default so pre-existing deployments keep their exact behavior", () => {
    expect(createCodingSandboxProvider({ E2B_API_KEY: "e2b_test", E2B_CODING_TEMPLATE: "circuit-coding" })).toBeInstanceOf(E2BSandboxProvider);
    expect(createCodingSandboxProvider({ CODING_SANDBOX_PROVIDER: "e2b", E2B_API_KEY: "e2b_test", E2B_CODING_TEMPLATE: "circuit-coding" })).toBeInstanceOf(E2BSandboxProvider);
  });

  it("switches to the Docker backend only on explicit selection", () => {
    expect(createCodingSandboxProvider({ CODING_SANDBOX_PROVIDER: "docker", DOCKER_CODING_IMAGE: "circuit-nova-coding:latest" })).toBeInstanceOf(DockerSandboxProvider);
    expect(createCodingSandboxProvider({ CODING_SANDBOX_PROVIDER: "docker" })).toBeUndefined();
  });

  it("rejects an unrecognized sandbox backend rather than guessing", () => {
    expect(createCodingSandboxProvider({ CODING_SANDBOX_PROVIDER: "unknown-backend", E2B_API_KEY: "e2b_test", E2B_CODING_TEMPLATE: "circuit-coding" })).toBeUndefined();
  });

  it("creates the dynamic-presets provider from its own, cheaper model slot", () => {
    // Deliberately a separate env var from the coding model — presets must not silently start
    // spending at the (possibly much more expensive) coding model's rate.
    expect(createDynamicPresetsProvider({ CIRCUITNOTION_API_KEY: "cn_test" })).toBeUndefined();
    expect(createDynamicPresetsProvider({ CIRCUITNOTION_API_KEY: "cn_test", CIRCUITNOTION_PRESETS_MODEL: "gpt-5.6-nano" })).toBeInstanceOf(CircuitNotionPresetsProvider);
  });

  it("parses a versioned RWF model price catalog", () => {
    expect(createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "2000", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toEqual({
      inputRwfPerMillionTokens: 2_000,
      outputRwfPerMillionTokens: 8_000,
    });
    expect(() => createModelPriceCatalog({ MODEL_INPUT_RWF_PER_MILLION: "-1", MODEL_OUTPUT_RWF_PER_MILLION: "8000" })).toThrow("positive integer");
  });
});
