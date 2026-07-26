export type TokenEstimate = {
  expectedInputTokens: number;
  maximumInputTokens: number;
};

export type ModelPriceCatalog = {
  inputRwfPerMillionTokens: number;
  outputRwfPerMillionTokens: number;
};

export type ModelCostEstimate = {
  expectedRwf: number;
  maximumRwf: number;
  expectedInputTokens: number;
  maximumInputTokens: number;
  maximumOutputTokens: number;
};

function assertRate(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer RWF rate`);
}

function assertTokens(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
}

function costRwf(inputTokens: number, outputTokens: number, prices: ModelPriceCatalog): number {
  return Math.ceil((inputTokens * prices.inputRwfPerMillionTokens + outputTokens * prices.outputRwfPerMillionTokens) / 1_000_000);
}

/**
 * Returns an expected estimate and a deliberately conservative byte-based cap.
 * Actual provider usage is always reconciled after execution.
 */
export function approximateInputTokens(parts: string[]): TokenEstimate {
  const text = parts.join("\n");
  const utf8Bytes = new TextEncoder().encode(text).byteLength;
  return {
    expectedInputTokens: Math.ceil(text.length / 3.2) + 128,
    maximumInputTokens: utf8Bytes + 1_024,
  };
}

export function estimateModelCost(parts: string[], maximumOutputTokens: number, prices: ModelPriceCatalog): ModelCostEstimate {
  assertRate(prices.inputRwfPerMillionTokens, "inputRwfPerMillionTokens");
  assertRate(prices.outputRwfPerMillionTokens, "outputRwfPerMillionTokens");
  assertTokens(maximumOutputTokens, "maximumOutputTokens");
  const tokens = approximateInputTokens(parts);
  const expectedOutputTokens = Math.ceil(maximumOutputTokens * 0.55);
  return {
    expectedRwf: costRwf(tokens.expectedInputTokens, expectedOutputTokens, prices),
    maximumRwf: costRwf(tokens.maximumInputTokens, maximumOutputTokens, prices),
    ...tokens,
    maximumOutputTokens,
  };
}

export function priceActualModelUsage(inputTokens: number, outputTokens: number, prices: ModelPriceCatalog): number {
  assertRate(prices.inputRwfPerMillionTokens, "inputRwfPerMillionTokens");
  assertRate(prices.outputRwfPerMillionTokens, "outputRwfPerMillionTokens");
  assertTokens(inputTokens, "inputTokens");
  assertTokens(outputTokens, "outputTokens");
  return costRwf(inputTokens, outputTokens, prices);
}
