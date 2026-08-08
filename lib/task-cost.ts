export type TaskKind = "coding" | "research" | "writing" | "operations";
export type QualityTier = "fast" | "balanced" | "expert";

export type QuoteInput = {
  kind: TaskKind;
  quality: QualityTier;
  attachmentCount: number;
  requiresBrowser: boolean;
  requiresSandbox: boolean;
};

export type TaskQuote = {
  estimateLowRwf: number;
  estimateHighRwf: number;
  maxRwf: number;
  confidence: "high" | "medium" | "low";
  assumptions: string[];
};

const BASE_COST_RWF: Record<TaskKind, number> = {
  coding: 1550,
  research: 900,
  writing: 450,
  operations: 700,
};

const QUALITY_MULTIPLIER: Record<QualityTier, number> = {
  fast: 0.72,
  balanced: 1,
  expert: 1.65,
};

/**
 * A deliberately transparent v1 estimator. It prices bounded execution inputs
 * and leaves a visible uncertainty reserve for agent loops and tool retries.
 * Historical calibration will replace these constants, not this public contract.
 */
export function estimateTaskCost(input: QuoteInput): TaskQuote {
  if (!Number.isSafeInteger(input.attachmentCount) || input.attachmentCount < 0) throw new Error("attachmentCount must be a non-negative integer");
  const base = BASE_COST_RWF[input.kind] * QUALITY_MULTIPLIER[input.quality];
  const attachmentCost = Math.min(input.attachmentCount, 10) * 80;
  const browserCost = input.requiresBrowser ? 350 : 0;
  const sandboxCost = input.requiresSandbox ? 500 : 0;
  const expected = Math.round(base + attachmentCost + browserCost + sandboxCost);
  const uncertainty = input.kind === "coding" ? 0.3 : input.requiresBrowser ? 0.25 : 0.16;
  const estimateLowRwf = Math.round(expected * (1 - uncertainty / 2));
  const estimateHighRwf = Math.round(expected * (1 + uncertainty));
  const maxRwf = Math.ceil(estimateHighRwf * 1.12 / 50) * 50;

  const assumptions = [
    `${input.quality[0].toUpperCase()}${input.quality.slice(1)} quality routing`,
    input.requiresSandbox ? "Includes isolated E2B execution time" : "No sandbox execution assumed",
    input.requiresBrowser ? "Includes one browser workflow" : "No browser workflow assumed",
    "Pauses for approval before exceeding the task cap",
  ];

  return {
    estimateLowRwf,
    estimateHighRwf,
    maxRwf,
    confidence: input.kind === "writing" && !input.requiresBrowser ? "high" : input.kind === "coding" ? "medium" : "low",
    assumptions,
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
