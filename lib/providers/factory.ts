import { E2BSandboxProvider } from "./e2b";
import { OpenAICodingModelProvider } from "./openai";
import type { ModelPriceCatalog } from "../model-cost";

export type ProviderEnvironment = {
  E2B_API_KEY?: string;
  E2B_CODING_TEMPLATE?: string;
  E2B_BROWSER_TEMPLATE?: string;
  E2B_DATA_TEMPLATE?: string;
  E2B_ALLOW_INTERNET?: string;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  MODEL_INPUT_RWF_PER_MILLION?: string;
  MODEL_OUTPUT_RWF_PER_MILLION?: string;
};

export function createE2BProvider(environment: ProviderEnvironment): E2BSandboxProvider | undefined {
  const apiKey = environment.E2B_API_KEY?.trim();
  const codingTemplate = environment.E2B_CODING_TEMPLATE?.trim();
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

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function createOpenAIProvider(environment: ProviderEnvironment): OpenAICodingModelProvider | undefined {
  const apiKey = environment.OPENAI_API_KEY?.trim();
  const model = environment.OPENAI_MODEL?.trim();
  if (!apiKey || !model) return undefined;
  return new OpenAICodingModelProvider({ apiKey, model });
}

export function createModelPriceCatalog(environment: ProviderEnvironment): ModelPriceCatalog | undefined {
  const inputRwfPerMillionTokens = parsePositiveInteger(environment.MODEL_INPUT_RWF_PER_MILLION, "MODEL_INPUT_RWF_PER_MILLION");
  const outputRwfPerMillionTokens = parsePositiveInteger(environment.MODEL_OUTPUT_RWF_PER_MILLION, "MODEL_OUTPUT_RWF_PER_MILLION");
  if (inputRwfPerMillionTokens === undefined || outputRwfPerMillionTokens === undefined) return undefined;
  return { inputRwfPerMillionTokens, outputRwfPerMillionTokens };
}
