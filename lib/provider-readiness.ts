export type ProviderConfiguration = {
  convexDeployment?: string;
  convexUrl?: string;
  e2bApiKey?: string;
  e2bCodingTemplate?: string;
  openaiApiKey?: string;
  openaiModel?: string;
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
  const requirements = [
    ["CONVEX_DEPLOYMENT", config.convexDeployment],
    ["NEXT_PUBLIC_CONVEX_URL", config.convexUrl],
    ["E2B_API_KEY", config.e2bApiKey],
    ["E2B_CODING_TEMPLATE", config.e2bCodingTemplate],
    ["OPENAI_API_KEY", config.openaiApiKey],
    ["OPENAI_MODEL", config.openaiModel],
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
      && has("OPENAI_API_KEY")
      && has("OPENAI_MODEL")
      && has("MODEL_INPUT_RWF_PER_MILLION")
      && has("MODEL_OUTPUT_RWF_PER_MILLION"),
    payments: has("CONVEX_DEPLOYMENT") && has("NEXT_PUBLIC_CONVEX_URL") && has("CIRCUIT_PAY_API_KEY") && has("CIRCUIT_PAY_WEBHOOK_SECRET"),
    missing,
  };
}
