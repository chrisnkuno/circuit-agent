/**
 * How fast money is going, how long it lasts, and what to say about it.
 *
 * The panel next door already answers "how much has this cost" — a total, a bar per turn, a
 * paragraph. That is a record of the past, and the thing people are actually anxious about is the
 * future: *is this about to run away from me, and will I be cut off in the middle of something*.
 * A total cannot answer either question. A pace and a runway can.
 *
 * Three rules hold this together, and each is a constraint on the code rather than advice:
 *
 * **Working time, not wall-clock time.** Pace is spend divided by the time turns actually ran. An
 * agent idle on the desk overnight costs nothing, and dividing by the hours it sat there would
 * report a reassuring near-zero rate that collapses the moment someone types. The honest figure is
 * the rate while it is working, because that is the rate that applies to the next thing they ask.
 *
 * **A runway is refused rather than guessed.** No ambient exchange rate exists here, exactly as in
 * `money.ts`: if the balance and the session's costs are in different currencies, this returns
 * `null` instead of a number. A wrong runway is worse than no runway — it is the number someone
 * plans their afternoon around.
 *
 * **Nothing here derives a balance.** The balance is whatever the gateway last said. Local spend is
 * only ever used to *label* it — to turn "1,800 RWF" into "about nine more turns". Another device
 * may be spending the same account, and a locally-computed balance would disagree with the ledger
 * precisely when it mattered most.
 */

import {
  CRITICAL_BALANCE_RWF,
  LOW_BALANCE_RWF,
  MAXIMUM_TOP_UP_RWF,
  MINIMUM_TOP_UP_RWF,
} from "@circuit-nova/nova-core/nova-cli/billing";
import type { TurnCostPoint } from "./cost-chart";

export type Money = { micros: number; currency: string };

/** What the gateway last reported, passed through untouched. `asOf` lets a stale figure say so. */
export type BalanceReading = { balanceRwf: number; asOf: number };

export type SpendTrend = "steady" | "rising" | "easing";

export type SpendPace = {
  /** Mean cost of a turn across the recent window. */
  perTurnMicros: number;
  /** Cost per minute of time the agent was actually running. */
  perMinuteMicros: number;
  currency: string;
  /** How many priced turns the figures rest on — the UI says so rather than implying certainty. */
  sampleTurns: number;
  trend: SpendTrend;
};

/** Turns considered "recent". Small enough to notice a change, large enough not to chase noise. */
const WINDOW = 5;

/** A turn must cost this much more than the earlier ones before the pace is called "rising". */
const RISING_RATIO = 1.35;
const EASING_RATIO = 0.7;

/** Below this, two windows are too small a sample to call a direction at all. */
const MIN_TREND_SAMPLE = 2;

/**
 * The recent rate of spend, or `null` when nothing has a known price.
 *
 * Deliberately `null` rather than a zero: an unpriced session (a model with no catalog entry) would
 * otherwise report "RWF 0 per turn", which reads as *free* when it means *unknown*. Those two must
 * never render the same way.
 */
export function spendPace(turns: readonly TurnCostPoint[], window: number = WINDOW): SpendPace | null {
  const priced = turns.filter((turn) => turn.cost);
  if (priced.length === 0) return null;

  const recent = priced.slice(-window);
  const totalMicros = recent.reduce((sum, turn) => sum + turn.cost!.micros, 0);
  const perTurnMicros = Math.round(totalMicros / recent.length);

  // Elapsed time is per turn and already excludes the gaps between them, which is what makes this
  // a working rate. A turn that somehow reports no elapsed time contributes cost but no time; the
  // guard below keeps that from dividing by zero rather than pretending the turn was instant.
  const activeMs = recent.reduce((sum, turn) => sum + Math.max(0, turn.elapsedMs), 0);
  const perMinuteMicros = activeMs > 0 ? Math.round((totalMicros / activeMs) * 60_000) : 0;

  return {
    perTurnMicros,
    perMinuteMicros,
    currency: recent[0].cost!.currency,
    sampleTurns: recent.length,
    trend: trendOf(priced, window),
  };
}

/**
 * Whether recent turns cost more than the ones before them.
 *
 * Compared against an equal-sized earlier window rather than against the session average, because
 * the average includes the recent turns themselves and so drags toward whatever is happening now —
 * a genuinely rising pace would keep reporting "steady" as the average chased it.
 */
function trendOf(priced: readonly TurnCostPoint[], window: number): SpendTrend {
  const recent = priced.slice(-window);
  const earlier = priced.slice(-window * 2, -window);
  if (recent.length < MIN_TREND_SAMPLE || earlier.length < MIN_TREND_SAMPLE) return "steady";
  const mean = (list: readonly TurnCostPoint[]) => list.reduce((sum, turn) => sum + turn.cost!.micros, 0) / list.length;
  const before = mean(earlier);
  if (before <= 0) return "steady";
  const ratio = mean(recent) / before;
  if (ratio >= RISING_RATIO) return "rising";
  if (ratio <= EASING_RATIO) return "easing";
  return "steady";
}

/**
 * Cost per minute for each turn, for the line that shows speed changing.
 *
 * Rate rather than amount, which is the point: a long turn and a short one can cost the same and
 * mean completely different things about how fast money is going. Turns with no elapsed time or no
 * price are `null` rather than `0` so the chart can break the line instead of drawing a plunge to
 * the floor that never happened.
 */
export function paceSeries(turns: readonly TurnCostPoint[]): Array<{ turnNumber: number; perMinuteMicros: number | null }> {
  return turns.map((turn) => ({
    turnNumber: turn.turnNumber,
    perMinuteMicros: turn.cost && turn.elapsedMs > 0
      ? Math.round((turn.cost.micros / turn.elapsedMs) * 60_000)
      : null,
  }));
}

export type Runway = {
  /** Whole turns the balance covers at the current pace. Floored: a partial turn is not a turn. */
  turns: number;
  /** Minutes of working time, for a pace that is felt as duration rather than as turn count. */
  minutes: number;
  /** False when the sample is too thin to plan around; the UI hedges its wording accordingly. */
  confident: boolean;
};

/** A runway is only meaningful once the pace rests on at least this many priced turns. */
const CONFIDENT_SAMPLE = 3;

/**
 * How far the balance goes at the current pace — or `null` when that cannot be said honestly.
 *
 * Refuses on a currency mismatch. The session's costs are quoted in whatever `NOVA_CURRENCY` says,
 * the gateway's balance is in RWF, and converting between them without a dated rate is the exact
 * guess `money.ts` exists to prevent.
 */
export function runway(balance: BalanceReading, pace: SpendPace): Runway | null {
  if (pace.currency !== "RWF") return null;
  if (pace.perTurnMicros <= 0) return null;
  const balanceMicros = balance.balanceRwf * 1_000_000;
  if (balanceMicros < 0) return null;
  return {
    turns: Math.floor(balanceMicros / pace.perTurnMicros),
    minutes: pace.perMinuteMicros > 0 ? Math.floor(balanceMicros / pace.perMinuteMicros) : 0,
    confident: pace.sampleTurns >= CONFIDENT_SAMPLE,
  };
}

export type SpendLevel = "healthy" | "watch" | "low" | "critical" | "empty";

export type SpendAdvice = {
  level: SpendLevel;
  /** One line, in the second person, saying where things stand. */
  headline: string;
  /** Why the headline is true — the number it came from, so the verdict can be checked. */
  detail: string;
  /**
   * What topping up now would buy, in whole RWF. Absent when there is nothing to suggest, which is
   * the healthy case: an app that asks for money while the balance is fine is an app that gets
   * ignored when the balance is not.
   */
  topUpRwf?: number;
};

/** Runway at which the tone changes from "fine" to "worth knowing". */
const WATCH_TURNS = 6;
/** Runway at which it becomes a warning, matching the CLI's `turnsLeft <= 2`. */
const LOW_TURNS = 2;

/** A top-up should buy back a comfortable stretch of work, not just clear the warning. */
const TOP_UP_TURNS = 20;
/** Suggestions are rounded to something a person would actually type. */
const TOP_UP_ROUNDING = 500;
/** With no measured pace there is nothing to size a suggestion from, so offer the CLI's example. */
const DEFAULT_TOP_UP_RWF = 5_000;

/**
 * The sentence to put in front of someone about their balance.
 *
 * Written to be read when nothing is wrong, too. Most of the time this returns "healthy", and the
 * healthy wording still names the runway — that is the entire point of the feature. Someone who
 * has seen "about 40 more turns at this pace" all week is someone for whom "about 3 more turns"
 * lands as information rather than as a scare, and who has learned what their work costs by
 * watching a number they already trusted.
 */
export function spendAdvice(input: { balance: BalanceReading; pace: SpendPace | null }): SpendAdvice {
  const { balance, pace } = input;
  const left = pace ? runway(balance, pace) : null;
  const balanceText = `${formatWholeRwf(balance.balanceRwf)} left`;
  const suggestion = suggestTopUpRwf(pace);

  if (balance.balanceRwf <= 0) {
    return {
      level: "empty",
      headline: "Out of credit — work is paused until you top up.",
      // Says what has *not* happened as plainly as what has. The fear at zero is a silent charge.
      detail: "Nothing was charged for a turn that could not run, and nothing tops up on its own.",
      topUpRwf: suggestion,
    };
  }

  if (balance.balanceRwf < CRITICAL_BALANCE_RWF) {
    return {
      level: "critical",
      headline: `Very low: ${balanceText}.`,
      detail: left
        ? `That is roughly ${describeTurns(left)} at your current pace. A longer task may stop partway.`
        : `That is below the ${formatWholeRwf(CRITICAL_BALANCE_RWF)} mark where a demanding task may not start.`,
      topUpRwf: suggestion,
    };
  }

  const lowByRunway = left !== null && left.turns <= LOW_TURNS;
  if (balance.balanceRwf <= LOW_BALANCE_RWF || lowByRunway) {
    return {
      level: "low",
      headline: `Running low: ${balanceText}.`,
      detail: left
        ? `About ${describeTurns(left)} at your current pace — worth topping up before the next big task.`
        : "Worth topping up before starting anything long.",
      topUpRwf: suggestion,
    };
  }

  if (left !== null && left.turns <= WATCH_TURNS) {
    return {
      level: "watch",
      headline: `${capitalise(balanceText)} — enough for now.`,
      detail: `About ${describeTurns(left)} at your current pace. Nothing to do yet.`,
      topUpRwf: suggestion,
    };
  }

  // Healthy. The pace is still named, because a number only reassures if it has been there all along.
  return {
    level: "healthy",
    headline: `${capitalise(balanceText)}.`,
    detail: left
      ? `About ${describeTurns(left)} at your current pace.`
      : pace
        ? "Your balance comfortably covers the work in this session."
        : "No turn has a known price yet, so there is no pace to project from.",
  };
}

/**
 * A top-up amount sized to the way this person actually works.
 *
 * A fixed suggestion is wrong in both directions — it is pocket change to someone running long
 * agentic tasks and an alarming sum to someone asking short questions. Sizing it from the measured
 * per-turn cost makes the offer proportionate to what they have been doing.
 */
export function suggestTopUpRwf(pace: SpendPace | null): number {
  if (!pace || pace.currency !== "RWF" || pace.perTurnMicros <= 0) return DEFAULT_TOP_UP_RWF;
  const wanted = (pace.perTurnMicros * TOP_UP_TURNS) / 1_000_000;
  const rounded = Math.ceil(wanted / TOP_UP_ROUNDING) * TOP_UP_ROUNDING;
  return Math.min(MAXIMUM_TOP_UP_RWF, Math.max(MINIMUM_TOP_UP_RWF, rounded));
}

/**
 * "about 9 more turns", hedged when the sample is thin.
 *
 * The hedge is not politeness. Two priced turns can differ by an order of magnitude, and a runway
 * built on them is a number that will visibly change; saying so before it changes is what keeps it
 * from looking like the app got it wrong.
 */
export function describeTurns(left: Runway): string {
  const turns = left.turns === 1 ? "1 more turn" : `${left.turns.toLocaleString("en-US")} more turns`;
  return left.confident ? turns : `${turns}, on an early estimate`;
}

/** Whole RWF, which has no minor unit — a decimal here would be a unit error, not a rounding one. */
export function formatWholeRwf(amount: number): string {
  return `RWF ${Math.round(amount).toLocaleString("en-US")}`;
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A balance that has not been re-read in a while, so the window can mark it as stale.
 *
 * Any figure attached to money goes out of date, and the failure people cannot forgive is a stale
 * number presented as current. The gateway stamps `asOf`; this only decides when to say so.
 */
export const STALE_BALANCE_MS = 5 * 60_000;

export function isStale(balance: BalanceReading, now: number = Date.now()): boolean {
  return now - balance.asOf > STALE_BALANCE_MS;
}
