import { E2BSandboxProvider } from "./e2b";
import { DockerSandboxProvider } from "./docker";
import { OpenAICodingModelProvider } from "./openai";
import { OpenAIAgentTurnProvider } from "./openai-agent";
import { CircuitNotionCodingModelProvider } from "./circuitnotion";
import { CircuitNotionAgentTurnProvider } from "./circuitnotion-agent";
import { CircuitNotionPresetsProvider } from "./circuitnotion-presets";
import type { CodingModelProvider } from "./model";
import type { AgentTurnProvider } from "../agent-runtime";
import type { InteractiveCodingSandboxProvider } from "./contracts";
import { modelPricesFromEnvironment, type ModelPriceCatalog } from "../model-cost";

export type ProviderEnvironment = {
  E2B_API_KEY?: string;
  E2B_CODING_TEMPLATE?: string;
  E2B_BROWSER_TEMPLATE?: string;
  E2B_DATA_TEMPLATE?: string;
  E2B_ALLOW_INTERNET?: string;
  DOCKER_CODING_IMAGE?: string;
  DOCKER_ALLOW_INTERNET?: string;
  CODING_SANDBOX_PROVIDER?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  CIRCUITNOTION_API_KEY?: string;
  CIRCUITNOTION_MODEL?: string;
  CIRCUITNOTION_BASE_URL?: string;
  CIRCUITNOTION_RELAY_SECRET?: string;
  CIRCUITNOTION_PRESETS_MODEL?: string;
  CODING_MODEL_PROVIDER?: string;
  MODEL_INPUT_RWF_PER_MILLION?: string;
  /** Optional: the provider's discounted rate for cache-served input tokens. */
  MODEL_CACHED_INPUT_RWF_PER_MILLION?: string;
  MODEL_OUTPUT_RWF_PER_MILLION?: string;
};

/**
 * `codingTemplateOverride` is how a run's chosen workspace preset reaches the sandbox. The
 * environment still supplies the deployment's default, so a run that expresses no preference keeps
 * whatever the deployment is configured for.
 */
export function createE2BProvider(environment: ProviderEnvironment, codingTemplateOverride?: string): E2BSandboxProvider | undefined {
  const apiKey = environment.E2B_API_KEY?.trim();
  const codingTemplate = codingTemplateOverride?.trim() || environment.E2B_CODING_TEMPLATE?.trim();
  if (!apiKey || !codingTemplate) return undefined;
  return new E2BSandboxProvider({
    apiKey,
    templates: {
      coding: codingTemplate,
      browser: environment.E2B_BROWSER_TEMPLATE?.trim() || codingTemplate,
      data: environment.E2B_DATA_TEMPLATE?.trim() || codingTemplate,
    },
    allowInternetAccess: environment.E2B_ALLOW_INTERNET === "true",
  });
}

export function createDockerProvider(environment: ProviderEnvironment): DockerSandboxProvider | undefined {
  const image = environment.DOCKER_CODING_IMAGE?.trim();
  if (!image) return undefined;
  return new DockerSandboxProvider({ image, allowInternetAccess: environment.DOCKER_ALLOW_INTERNET === "true" });
}

/**
 * Sandbox backend selection is explicit but, unlike the model-provider selector below,
 * defaults to the established E2B backend when unset: every deployment that predates this
 * selector never set CODING_SANDBOX_PROVIDER, and it must keep behaving exactly as before.
 * Set it to "docker" to run the second, interchangeable backend behind the same contract.
 */
export function createCodingSandboxProvider(environment: ProviderEnvironment): InteractiveCodingSandboxProvider | undefined {
  const selection = environment.CODING_SANDBOX_PROVIDER?.trim() || "e2b";
  if (selection === "docker") return createDockerProvider(environment);
  if (selection === "e2b") return createE2BProvider(environment);
  return undefined;
}

export function createOpenAIProvider(environment: ProviderEnvironment): OpenAICodingModelProvider | undefined {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey || !model) return undefined;
  return new OpenAICodingModelProvider({ apiKey, model });
}

export function createCircuitNotionProvider(environment: ProviderEnvironment): CircuitNotionCodingModelProvider | undefined {
  const apiKey = environment.CIRCUITNOTION_API_KEY?.trim();
  const model = environment.CIRCUITNOTION_MODEL?.trim();
  if (!apiKey || !model) return undefined;
  return new CircuitNotionCodingModelProvider({ apiKey, model, baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined, relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined });
}

export function createCircuitNotionAgentProvider(environment: ProviderEnvironment): CircuitNotionAgentTurnProvider | undefined {
  const apiKey = environment.CIRCUITNOTION_API_KEY?.trim();
  const model = environment.CIRCUITNOTION_MODEL?.trim();
  if (!apiKey || !model) return undefined;
  return new CircuitNotionAgentTurnProvider({ apiKey, model, baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined, relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined });
}

/** Uses the same explicit provider selection as coding, but exposes a tool-free conversational turn. */
export function createAgentTurnProvider(environment: ProviderEnvironment, providerOverride?: "openai" | "circuitnotion", modelOverride?: string): AgentTurnProvider | undefined {
  const selection = providerOverride ?? environment.CODING_MODEL_PROVIDER?.trim();
  if (selection === "openai") {
    const apiKey = environment.OPENAI_API_KEY?.trim();
    const model = modelOverride?.trim() || environment.OPENAI_MODEL?.trim();
    return apiKey && model ? new OpenAIAgentTurnProvider({ apiKey, model }) : undefined;
  }
  if (selection === "circuitnotion") {
    const apiKey = environment.CIRCUITNOTION_API_KEY?.trim();
    const model = modelOverride?.trim() || environment.CIRCUITNOTION_MODEL?.trim();
    return apiKey && model ? new CircuitNotionAgentTurnProvider({ apiKey, model, baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined, relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined }) : undefined;
  }
  return undefined;
}

/**
 * Deliberately a separate, unbilled model slot from the coding model above: dynamic terminal
 * presets are a cheap suggestion call, not agent work performed on the user's behalf, so they
 * default to a lighter model via their own explicit env var rather than reusing the (possibly
 * much more expensive) coding model. Reuses the same API key/base URL/relay secret — the
 * Cloudflare relay fix applies to every CircuitNotion call from Convex, not just coding ones.
 */
export function createDynamicPresetsProvider(environment: ProviderEnvironment): CircuitNotionPresetsProvider | undefined {
  const apiKey = environment.CIRCUITNOTION_API_KEY?.trim();
  const model = environment.CIRCUITNOTION_PRESETS_MODEL?.trim();
  if (!apiKey || !model) return undefined;
  return new CircuitNotionPresetsProvider({ apiKey, model, baseURL: environment.CIRCUITNOTION_BASE_URL?.trim() || undefined, relaySecret: environment.CIRCUITNOTION_RELAY_SECRET?.trim() || undefined });
}

/**
 * Model provider selection is explicit, never a silent fallback: CODING_MODEL_PROVIDER
 * must name exactly one configured provider, matching the project's "explicit model
 * identity" invariant instead of picking whichever credential happens to be present.
 */
export function createCodingModelProvider(environment: ProviderEnvironment): CodingModelProvider | undefined {
  const selection = environment.CODING_MODEL_PROVIDER?.trim();
  if (selection === "openai") return createOpenAIProvider(environment);
  if (selection === "circuitnotion") return createCircuitNotionProvider(environment);
  return undefined;
}

export function createModelPriceCatalog(environment: ProviderEnvironment): ModelPriceCatalog | undefined {
  return modelPricesFromEnvironment(environment);
}
