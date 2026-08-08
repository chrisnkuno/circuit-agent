export type TokenEstimate = {
  expectedInputTokens: number;
  maximumInputTokens: number;
};

export type ModelPriceCatalog = {
  inputRwfPerMillionTokens: number;
  outputRwfPerMillionTokens: number;
  /**
   * Rate for input tokens the provider served from its prompt cache, when it charges less for
   * them. Optional because it must be configured deliberately: assuming a discount that a provider
   * does not actually give would under-reserve every run and silently overspend the task cap.
   *
   * Measured against CircuitNotion, a repeated prefix reports ~99% cached (2410 of 2424 tokens),
   * so where a discount exists this is the difference between a roughly accurate cost and one that
   * overstates by an order of magnitude on a long session.
   */
  cachedInputRwfPerMillionTokens?: number;
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

/**
 * Actual cost with cache-aware input pricing.
 *
 * `priceActualModelUsage` charges every input token at the full rate, which is the safe assumption
 * and remains the default everywhere. This variant is for callers that know the provider's cached
 * rate and want the real number; with no cached rate configured the two agree exactly.
 */
export function priceUsageWithCache(
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number },
  prices: ModelPriceCatalog,
): number {
  if (prices.cachedInputRwfPerMillionTokens === undefined) {
    return priceActualModelUsage(usage.inputTokens, usage.outputTokens, prices);
  }
  assertRate(prices.cachedInputRwfPerMillionTokens, "cachedInputRwfPerMillionTokens");
  assertTokens(usage.cachedInputTokens, "cachedInputTokens");
  // Providers report cached tokens as a subset of input tokens, not in addition to them.
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const full = priceActualModelUsage(uncached, usage.outputTokens, prices);
  return full + Math.round((usage.cachedInputTokens * prices.cachedInputRwfPerMillionTokens) / 1_000_000);
}

export function priceActualModelUsage(inputTokens: number, outputTokens: number, prices: ModelPriceCatalog): number {
  assertRate(prices.inputRwfPerMillionTokens, "inputRwfPerMillionTokens");
  assertRate(prices.outputRwfPerMillionTokens, "outputRwfPerMillionTokens");
  assertTokens(inputTokens, "inputTokens");
  assertTokens(outputTokens, "outputTokens");
  return costRwf(inputTokens, outputTokens, prices);
}

/**
 * Builds the price catalog from environment configuration.
 *
 * Lives here rather than in the provider factory so a caller that only needs pricing — the CLI's
 * cost ledger, for one — does not import every provider adapter in the project to get it.
 */
export function modelPricesFromEnvironment(environment: {
  MODEL_INPUT_RWF_PER_MILLION?: string;
  MODEL_OUTPUT_RWF_PER_MILLION?: string;
  MODEL_CACHED_INPUT_RWF_PER_MILLION?: string;
}): ModelPriceCatalog | undefined {
  const parse = (value: string | undefined) => {
    if (value === undefined || value.trim() === "") return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("Model price rates must be positive integers");
    return parsed;
  };
  const inputRwfPerMillionTokens = parse(environment.MODEL_INPUT_RWF_PER_MILLION);
  const outputRwfPerMillionTokens = parse(environment.MODEL_OUTPUT_RWF_PER_MILLION);
  if (inputRwfPerMillionTokens === undefined || outputRwfPerMillionTokens === undefined) return undefined;
  const cachedInputRwfPerMillionTokens = parse(environment.MODEL_CACHED_INPUT_RWF_PER_MILLION);
  return { inputRwfPerMillionTokens, outputRwfPerMillionTokens, ...(cachedInputRwfPerMillionTokens !== undefined ? { cachedInputRwfPerMillionTokens } : {}) };
}
