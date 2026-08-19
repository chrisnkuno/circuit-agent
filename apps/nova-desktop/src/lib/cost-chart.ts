/**
 * The arithmetic behind the cost charts, with no drawing in it.
 *
 * Kept separate from the component for the reason the rest of `lib/` is: bar heights, the running
 * total and the "which turn was the expensive one" question are the parts worth testing, and none
 * of them need a DOM to be checked.
 *
 * Money arrives as integer micros in the provider's currency — never as a formatted string —
 * because a chart has to compare values, and "RWF 1,610" cannot be compared with anything.
 */

export type TurnCostPoint = {
  turnNumber: number;
  cost?: { micros: number; currency: string };
  /** Pre-formatted for labels, since only the engine knows how this currency should read. */
  display?: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  toolCalls: number;
  iterations: number;
  elapsedMs: number;
};

export type Bar = {
  turnNumber: number;
  /** 0…1 of the tallest bar in the series. Zero-cost turns keep a visible stub — see below. */
  height: number;
  micros: number;
  label: string;
  /** True for the most expensive turn, which is the one worth pointing at. */
  peak: boolean;
};

/** A visible stub for a turn that cost nothing measurable, so a gap means "no turn", not "free". */
const MIN_BAR = 0.04;

/**
 * Bars for a series of turns, scaled to the most expensive one.
 *
 * Scaled to the series maximum rather than to the budget: most sessions never approach a budget, so
 * scaling to one would draw every session as a flat line along the bottom and answer nothing. The
 * question this chart exists for is "which turn cost more than the others", which is a comparison
 * within the series.
 */
export function costBars(turns: readonly TurnCostPoint[]): Bar[] {
  const priced = turns.filter((turn) => turn.cost);
  const peak = priced.reduce((max, turn) => Math.max(max, turn.cost!.micros), 0);
  return turns.map((turn) => {
    const micros = turn.cost?.micros ?? 0;
    const ratio = peak > 0 ? micros / peak : 0;
    return {
      turnNumber: turn.turnNumber,
      height: turn.cost ? Math.max(MIN_BAR, ratio) : 0,
      micros,
      label: turn.display ?? "cost unknown",
      peak: peak > 0 && micros === peak,
    };
  });
}

/** Cumulative spend after each turn, for the line that answers "where is this heading". */
export function runningTotal(turns: readonly TurnCostPoint[]): number[] {
  let total = 0;
  return turns.map((turn) => (total += turn.cost?.micros ?? 0));
}

/**
 * Tokens per turn, split the way the bill is: what was sent, what came back, and what was cached.
 *
 * Cached input is drawn apart from fresh input because it is the one number a person can act on —
 * a session whose input is mostly cache reads is one where the context is being reused rather than
 * resent.
 */
export function tokenBars(turns: readonly TurnCostPoint[]): Array<{ turnNumber: number; input: number; output: number; cached: number; total: number }> {
  return turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    input: turn.inputTokens,
    output: turn.outputTokens,
    cached: turn.cachedInputTokens ?? 0,
    total: turn.inputTokens + turn.outputTokens,
  }));
}

/** The tallest token bar, so several series can share one vertical scale. */
export function tokenPeak(turns: readonly TurnCostPoint[]): number {
  return turns.reduce((max, turn) => Math.max(max, turn.inputTokens + turn.outputTokens), 0);
}

/**
 * A one-line summary of where the money went.
 *
 * Deliberately says nothing when nothing is priced: an average of unpriced turns is a made-up
 * number, and the panel already says "cost unknown" in that case.
 */
export function costSummary(turns: readonly TurnCostPoint[]): { averageMicros: number; peakTurn: number; currency: string } | null {
  const priced = turns.filter((turn) => turn.cost);
  if (priced.length === 0) return null;
  const total = priced.reduce((sum, turn) => sum + turn.cost!.micros, 0);
  const peak = priced.reduce((worst, turn) => (turn.cost!.micros > worst.cost!.micros ? turn : worst), priced[0]);
  return {
    averageMicros: Math.round(total / priced.length),
    peakTurn: peak.turnNumber,
    currency: priced[0].cost!.currency,
  };
}
