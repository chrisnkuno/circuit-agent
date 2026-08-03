export type ProviderConfiguration = {
  convexDeployment?: string;
  convexUrl?: string;
  e2bApiKey?: string;
  e2bCodingTemplate?: string;
  codingModelProvider?: string;
  openaiApiKey?: string;
  openaiModel?: string;
  circuitNotionApiKey?: string;
  circuitNotionModel?: string;
  modelInputRwfPerMillion?: string;
  modelOutputRwfPerMillion?: string;
  circuitPayApiKey?: string;
  circuitPayWebhookSecret?: string;
};

export type ReadinessReport = {
  controlPlane: boolean;
  codingExecution: boolean;
  payments: boolean;
  missing: string[];
};

export function assessProviderReadiness(config: ProviderConfiguration): ReadinessReport {
  const positiveInteger = (value: string | undefined) => {
    const parsed = Number(value);
    return value?.trim() && Number.isSafeInteger(parsed) && parsed > 0 ? value : undefined;
  };
  // Model provider selection is explicit (never inferred from whichever key happens to be
  // set); readiness still names the OpenAI keys as the default suggestion when unset.
  const modelProvider = config.codingModelProvider?.trim();
  const modelRequirements = modelProvider === "circuitnotion"
    ? ([["CIRCUITNOTION_API_KEY", config.circuitNotionApiKey], ["CIRCUITNOTION_MODEL", config.circuitNotionModel]] as const)
    : ([["OPENAI_API_KEY", config.openaiApiKey], ["OPENAI_MODEL", config.openaiModel]] as const);

  const requirements = [
    ["CONVEX_DEPLOYMENT", config.convexDeployment],
    ["NEXT_PUBLIC_CONVEX_URL", config.convexUrl],
    ["E2B_API_KEY", config.e2bApiKey],
    ["E2B_CODING_TEMPLATE", config.e2bCodingTemplate],
    ["CODING_MODEL_PROVIDER", modelProvider],
    ...modelRequirements,
    ["MODEL_INPUT_RWF_PER_MILLION", positiveInteger(config.modelInputRwfPerMillion)],
    ["MODEL_OUTPUT_RWF_PER_MILLION", positiveInteger(config.modelOutputRwfPerMillion)],
    ["CIRCUIT_PAY_API_KEY", config.circuitPayApiKey],
    ["CIRCUIT_PAY_WEBHOOK_SECRET", config.circuitPayWebhookSecret],
  ] as const;
  const missing = requirements.filter(([, value]) => !value?.trim()).map(([name]) => name);
  const has = (name: (typeof requirements)[number][0]) => !missing.includes(name);
  return {
    controlPlane: has("CONVEX_DEPLOYMENT") && has("NEXT_PUBLIC_CONVEX_URL"),
    codingExecution: has("CONVEX_DEPLOYMENT")
      && has("NEXT_PUBLIC_CONVEX_URL")
      && has("E2B_API_KEY")
      && has("E2B_CODING_TEMPLATE")
      && has("CODING_MODEL_PROVIDER")
      && modelRequirements.every(([name]) => has(name))
      && has("MODEL_INPUT_RWF_PER_MILLION")
      && has("MODEL_OUTPUT_RWF_PER_MILLION"),
    payments: has("CONVEX_DEPLOYMENT") && has("NEXT_PUBLIC_CONVEX_URL") && has("CIRCUIT_PAY_API_KEY") && has("CIRCUIT_PAY_WEBHOOK_SECRET"),
    missing,
  };
}
