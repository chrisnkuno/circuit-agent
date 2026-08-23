export type TokenEstimate = {
  expectedInputTokens: number;
  maximumInputTokens: number;
};

/**
 * Provider-neutral estimate for text that has not been sent yet.
 *
 * Exact tokenization depends on the selected model. This is deliberately more language-aware than
 * a flat characters-per-token ratio: source identifiers, punctuation and multibyte writing split
 * very differently. Actual provider usage remains the accounting source of truth.
 */
/**
 * UTF-8 length of one code point, by arithmetic rather than by encoding it.
 *
 * The encoding form allocated a fresh `TextEncoder` and a fresh byte array for every character of
 * every punctuation run, which on a transcript-sized string is the dominant cost of estimating it.
 * The ranges below are UTF-8's own definition, so this returns exactly what encoding returned.
 */
function utf8Length(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  if (codePoint < 0x10000) return 3;
  return 4;
}

export function estimateTextTokens(text: string): number {
  if (!text) return 0;
  let tokens = 0;
  for (const segment of text.match(/[A-Za-z0-9_]+|\s+|[^A-Za-z0-9_\s]+/gu) ?? []) {
    if (/^\s+$/u.test(segment)) {
      tokens += Math.ceil((segment.match(/\n/g)?.length ?? 0) / 2) + Math.floor(segment.length / 16);
    } else if (/^[A-Za-z0-9_]+$/u.test(segment)) {
      tokens += Math.max(1, Math.ceil(segment.length / (/[_\d]/.test(segment) ? 3.2 : 4)));
    } else {
      let asciiPunctuation = 0;
      let multibyteBytes = 0;
      for (const character of segment) {
        const bytes = utf8Length(character.codePointAt(0)!);
        if (bytes === 1) asciiPunctuation += 1;
        else multibyteBytes += bytes;
      }
      tokens += asciiPunctuation + Math.ceil(multibyteBytes / 2.5);
    }
  }
  return Math.max(1, tokens);
}

/** UTF-8 byte length without materializing the encoded copy. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) bytes += utf8Length(character.codePointAt(0)!);
  return bytes;
}

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
  /** Whole-request surcharge used by models whose long-context tier starts at a fixed input size. */
  largeContext?: {
    aboveInputTokens: number;
    inputMultiplier: number;
    outputMultiplier: number;
  };
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
  const tier = prices.largeContext && inputTokens > prices.largeContext.aboveInputTokens ? prices.largeContext : undefined;
  return Math.ceil((
    inputTokens * prices.inputRwfPerMillionTokens * (tier?.inputMultiplier ?? 1)
    + outputTokens * prices.outputRwfPerMillionTokens * (tier?.outputMultiplier ?? 1)
  ) / 1_000_000);
}

function effectiveOutputRate(inputTokens: number, prices: ModelPriceCatalog): number {
  return prices.outputRwfPerMillionTokens * (
    prices.largeContext && inputTokens > prices.largeContext.aboveInputTokens ? prices.largeContext.outputMultiplier : 1
  );
}

/**
 * Returns an expected estimate and a deliberately conservative byte-based cap.
 * Actual provider usage is always reconciled after execution.
 */
export function approximateInputTokens(parts: string[]): TokenEstimate {
  const totals = newPartTotals();
  for (const part of parts) addPart(totals, part);
  return tokenEstimateFrom(totals);
}

/**
 * Running measurement of a list of prompt parts.
 *
 * Exists so a caller re-estimating a *growing* list measures each part once instead of once per
 * estimate. The agent loop re-priced its whole transcript before every model call, which is
 * quadratic in the number of iterations and was measurably the most expensive synchronous work in
 * a long turn — while every message but the newest had an answer that could not have changed.
 */
export type PartTotals = { count: number; tokens: number; bytes: number };

export function newPartTotals(): PartTotals {
  return { count: 0, tokens: 0, bytes: 0 };
}

export function addPart(totals: PartTotals, text: string): PartTotals {
  totals.count += 1;
  totals.tokens += estimateTextTokens(text) + 4;
  totals.bytes += utf8ByteLength(text);
  return totals;
}

/**
 * The same estimate `approximateInputTokens` returns, folded from running totals.
 *
 * The byte figure accounts for the `"\n"` the parts were previously joined with, so a measurement
 * accumulated part by part matches one taken over the whole list exactly.
 */
export function tokenEstimateFrom(totals: PartTotals): TokenEstimate {
  const expectedInputTokens = totals.tokens + 64;
  const utf8Bytes = totals.bytes + Math.max(0, totals.count - 1);
  return {
    expectedInputTokens,
    maximumInputTokens: Math.max(expectedInputTokens + 256, utf8Bytes + 1_024),
  };
}

/** Largest affordable output allowance from an estimate that has already been measured. */
export function affordableOutputTokensFor(estimate: TokenEstimate, requestedOutputTokens: number, approvedRwf: number, prices: ModelPriceCatalog): number {
  assertRate(prices.inputRwfPerMillionTokens, "inputRwfPerMillionTokens");
  assertRate(prices.outputRwfPerMillionTokens, "outputRwfPerMillionTokens");
  assertTokens(requestedOutputTokens, "requestedOutputTokens");
  assertTokens(approvedRwf, "approvedRwf");
  const availableForOutput = approvedRwf - costRwf(estimate.maximumInputTokens, 0, prices);
  if (availableForOutput <= 0) return 0;
  const affordable = Math.floor((availableForOutput * 1_000_000) / effectiveOutputRate(estimate.maximumInputTokens, prices));
  return Math.max(0, Math.min(requestedOutputTokens, affordable));
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
 * Largest output allowance whose conservative input + output cost fits the money still approved.
 * Returning zero means the caller must not contact the provider: discovering an overrun after the
 * response arrives is accounting, not enforcement.
 */
export function affordableOutputTokens(parts: string[], requestedOutputTokens: number, approvedRwf: number, prices: ModelPriceCatalog): number {
  assertTokens(requestedOutputTokens, "requestedOutputTokens");
  assertTokens(approvedRwf, "approvedRwf");
  const inputCost = estimateModelCost(parts, 0, prices).maximumRwf;
  const availableForOutput = approvedRwf - inputCost;
  if (availableForOutput <= 0) return 0;
  const estimate = approximateInputTokens(parts);
  const affordable = Math.floor((availableForOutput * 1_000_000) / effectiveOutputRate(estimate.maximumInputTokens, prices));
  return Math.max(0, Math.min(requestedOutputTokens, affordable));
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
  const tier = prices.largeContext && usage.inputTokens > prices.largeContext.aboveInputTokens ? prices.largeContext : undefined;
  const inputMultiplier = tier?.inputMultiplier ?? 1;
  const outputMultiplier = tier?.outputMultiplier ?? 1;
  const full = Math.ceil((
    uncached * prices.inputRwfPerMillionTokens * inputMultiplier
    + usage.outputTokens * prices.outputRwfPerMillionTokens * outputMultiplier
  ) / 1_000_000);
  return full + Math.round((usage.cachedInputTokens * prices.cachedInputRwfPerMillionTokens * inputMultiplier) / 1_000_000);
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
