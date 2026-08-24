import { estimateTextTokens } from "@circuit-nova/nova-core/model-cost";

export type TaskKind = "coding" | "research" | "writing" | "operations";
export type QualityTier = "fast" | "balanced" | "expert";

export type QuoteInput = {
  kind: TaskKind;
  quality: QualityTier;
  attachmentCount: number;
  requiresBrowser: boolean;
  requiresSandbox: boolean;
  /** Real objective text when known; optional for preset/scheduled quotes. */
  taskText?: string;
};

export type TaskQuote = {
  estimateLowRwf: number;
  estimateHighRwf: number;
  maxRwf: number;
  confidence: "high" | "medium" | "low";
  assumptions: string[];
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  tokenRangeLow: number;
  tokenRangeHigh: number;
};

const TOKEN_PROFILE: Record<TaskKind, { input: number; output: number; turns: number }> = {
  coding: { input: 220_000, output: 32_000, turns: 8 },
  research: { input: 140_000, output: 22_000, turns: 5 },
  writing: { input: 80_000, output: 20_000, turns: 4 },
  operations: { input: 110_000, output: 18_000, turns: 5 },
};

const QUALITY_MULTIPLIER: Record<QualityTier, number> = {
  fast: 0.72,
  balanced: 1,
  expert: 1.65,
};

/**
 * Token-based quote. The profile models cumulative multi-turn input (history and tool results are
 * resent on later calls), while the user's title and attachments adjust that workload. Provider
 * usage still settles the final amount; this is the pre-execution forecast and cap.
 */
export function estimateTaskCost(input: QuoteInput): TaskQuote {
  if (!Number.isSafeInteger(input.attachmentCount) || input.attachmentCount < 0) throw new Error("attachmentCount must be a non-negative integer");
  const profile = TOKEN_PROFILE[input.kind];
  const quality = QUALITY_MULTIPLIER[input.quality];
  const objectiveTokens = estimateTextTokens(input.taskText?.trim() || input.kind) * profile.turns;
  const attachmentTokens = Math.min(input.attachmentCount, 10) * 12_000;
  const browserInputTokens = input.requiresBrowser ? 55_000 : 0;
  const browserOutputTokens = input.requiresBrowser ? 5_000 : 0;
  const estimatedInputTokens = Math.round((profile.input + objectiveTokens + attachmentTokens + browserInputTokens) * quality);
  const estimatedOutputTokens = Math.round((profile.output + browserOutputTokens) * quality);
  // Versioned planning rate in integer RWF per million tokens. Runtime settlement uses the actual
  // selected provider catalog; changing this forecast rate is one visible calibration point.
  const inputRwfPerMillion = 2_500;
  const outputRwfPerMillion = 10_000;
  const tokenCost = (inTokens: number, outTokens: number) => Math.ceil((inTokens * inputRwfPerMillion + outTokens * outputRwfPerMillion) / 1_000_000);
  const infrastructureRwf = (input.requiresSandbox ? 500 : 0) + (input.requiresBrowser ? 200 : 0);
  const expected = tokenCost(estimatedInputTokens, estimatedOutputTokens) + infrastructureRwf;
  const uncertainty = input.kind === "coding" ? 0.3 : input.requiresBrowser ? 0.25 : 0.16;
  const tokenRangeLow = Math.round((estimatedInputTokens + estimatedOutputTokens) * (1 - uncertainty / 2));
  const tokenRangeHigh = Math.round((estimatedInputTokens + estimatedOutputTokens) * (1 + uncertainty));
  const estimateLowRwf = tokenCost(Math.round(estimatedInputTokens * (1 - uncertainty / 2)), Math.round(estimatedOutputTokens * (1 - uncertainty / 2))) + infrastructureRwf;
  const estimateHighRwf = tokenCost(Math.round(estimatedInputTokens * (1 + uncertainty)), Math.round(estimatedOutputTokens * (1 + uncertainty))) + infrastructureRwf;
  const maxRwf = Math.ceil((tokenCost(Math.round(estimatedInputTokens * 1.55), Math.round(estimatedOutputTokens * 1.7)) + infrastructureRwf * 1.1) / 50) * 50;

  const assumptions = [
    `${input.quality[0].toUpperCase()}${input.quality.slice(1)} quality routing`,
    input.requiresSandbox ? "Includes isolated E2B execution time" : "No sandbox execution assumed",
    input.requiresBrowser ? "Includes one browser workflow" : "No browser workflow assumed",
    `Estimates ${estimatedInputTokens.toLocaleString()} input + ${estimatedOutputTokens.toLocaleString()} output tokens across about ${profile.turns} model turns`,
    `Planning rate: RWF ${inputRwfPerMillion.toLocaleString()}/M input and RWF ${outputRwfPerMillion.toLocaleString()}/M output; actual usage is reconciled`,
    "Pauses for approval before exceeding the task cap",
  ];

  return {
    estimateLowRwf,
    estimateHighRwf,
    maxRwf,
    confidence: input.kind === "writing" && !input.requiresBrowser ? "high" : input.kind === "coding" ? "medium" : "low",
    assumptions,
    estimatedInputTokens,
    estimatedOutputTokens,
    tokenRangeLow,
    tokenRangeHigh,
  };
}

export function formatRwf(value: number) {
  return new Intl.NumberFormat("en-RW", {
    style: "currency",
    currency: "RWF",
    // "narrowSymbol"/"symbol" render as "RF" for this currency in Node/browser ICU data;
    // "code" is the only currencyDisplay value that reliably prints "RWF".
    currencyDisplay: "code",
    maximumFractionDigits: 0,
  }).format(value);
}
