import {
  formatWholeRwf,
  isStale,
  paceSeries,
  runway,
  spendAdvice,
  spendPace,
  type BalanceReading,
} from "../lib/spend";
import type { TurnCostPoint } from "../lib/cost-chart";

/**
 * Where the money is going, how fast, and how long it lasts.
 *
 * The cost panel below this one is a record: a total, a bar per turn, a paragraph. It answers a
 * question nobody is actually anxious about. What people are worried about with an agent is not
 * what it *has* spent but what it is *about* to — whether this is running away from them, and
 * whether it will stop halfway through something that matters. Those are a rate and a runway, and
 * neither can be read off a total.
 *
 * The order on screen is the order of that worry: how long you have, then how fast it is going,
 * then the shape of that speed over time. The balance is largest because it is the number someone
 * glances at without meaning to.
 *
 * Nothing here nags. At a healthy balance there is no colour and no suggestion to top up — just
 * the runway stated plainly. That restraint is what makes the warning legible when it does appear:
 * an app that asks for money every day is an app whose asking means nothing.
 *
 * The one control that is always present is the opposite of nagging: a button that re-reads the
 * balance whenever someone wants to see it, and a second that hides the figure on a shared screen.
 * Both stay put in every state, including the states with nothing to report — a control that
 * vanishes with bad news is one people stop believing.
 */

const SPARK_WIDTH = 240;
const SPARK_HEIGHT = 34;

/** Runway is drawn against this much comfort, so a healthy bar is full rather than eternally short. */
const COMFORTABLE_TURNS = 20;

export function SpendPanel(props: {
  balance?: BalanceReading;
  /** Set when a gateway is configured but could not be reached; shown as a sentence, not a zero. */
  unavailable?: string;
  /** False when no billing service is configured at all — the common case, and not a fault. */
  configured: boolean;
  turns: readonly TurnCostPoint[];
  now?: number;
  /**
   * Re-read the balance from the gateway, on purpose.
   *
   * The panel refreshes itself after every turn, which covers the moment the number changes — but
   * a figure about money that can only be refreshed as a side effect of spending more is one
   * nobody can confirm. This is the button that answers "what is it *right now*", and it stays
   * available whatever the balance says.
   */
  onCheck?: () => void;
  checking?: boolean;
  /** Hidden by choice, for a shared screen. The button that reveals it is always present. */
  revealed?: boolean;
  onToggleReveal?: () => void;
}) {
  const now = props.now ?? Date.now();
  const revealed = props.revealed ?? true;
  const pace = spendPace(props.turns);
  const left = props.balance && pace ? runway(props.balance, pace) : null;
  const advice = props.balance ? spendAdvice({ balance: props.balance, pace }) : null;

  // With no balance to reason about there is still something worth saying — the pace itself — and
  // saying it is what teaches someone what their work costs before they ever see a warning.
  if (!props.balance) {
    return (
      <div className="spend-block">
        {pace ? <PaceRow pace={pace} /> : null}
        {pace ? <PaceSpark turns={props.turns} /> : null}
        <SpendControls
          onCheck={props.onCheck}
          checking={props.checking}
          revealed={revealed}
          onToggleReveal={props.onToggleReveal}
          now={now}
        />
        <p className="spend-note">
          {props.unavailable
            ? `Balance unavailable: ${props.unavailable}`
            : props.configured
              ? "Balance not read yet."
              : pace
                ? "Add a billing service in Settings to see how long your credit lasts at this pace."
                : "No priced turn yet, so there is no pace to show."}
        </p>
      </div>
    );
  }

  const stale = isStale(props.balance, now);

  return (
    <div className={`spend-block spend-${advice!.level}`}>
      <div className="spend-headline">
        <span className="spend-dot" aria-hidden="true" />
        <strong className="spend-balance">
          {revealed ? formatWholeRwf(props.balance.balanceRwf) : "RWF ••••"}
        </strong>
        <span className="spend-balance-label">{stale ? "left · last checked a while ago" : "left"}</span>
      </div>

      <SpendControls
        onCheck={props.onCheck}
        checking={props.checking}
        revealed={revealed}
        onToggleReveal={props.onToggleReveal}
        checkedAt={props.balance.asOf}
        now={now}
      />

      {/* The runway bar. Empty-to-full rather than a percentage of some budget: the question is
          "how much work is left in this", and twenty turns of comfort is the scale that answers it
          without making an ordinary balance look like an emergency. */}
      {left ? (
        <div className="spend-runway">
          <div
            className="spend-runway-track"
            role="img"
            aria-label={`About ${left.turns} more turns of work at the current pace.`}
          >
            <div
              className="spend-runway-fill"
              style={{ width: `${Math.min(100, Math.round((left.turns / COMFORTABLE_TURNS) * 100))}%` }}
            />
          </div>
          <p className="spend-runway-label">
            <strong>{left.turns.toLocaleString("en-US")}</strong> more {left.turns === 1 ? "turn" : "turns"}
            {left.minutes > 0 ? <> · about {formatMinutes(left.minutes)} of work</> : null}
            {left.confident ? null : <> · early estimate</>}
          </p>
        </div>
      ) : null}

      {pace ? <PaceRow pace={pace} /> : null}
      {pace ? <PaceSpark turns={props.turns} /> : null}

      <p className="spend-advice">
        <strong>{advice!.headline}</strong> {advice!.detail}
      </p>

      {/* A suggestion, never an action. Nothing in this window can move money, and a button here
          that looked like it might is a button that would be pressed in a panic. */}
      {advice!.topUpRwf ? (
        <p className="spend-topup">
          Topping up {formatWholeRwf(advice!.topUpRwf)} would cover about {COMFORTABLE_TURNS} more turns
          at this pace. Nova never charges you automatically.
        </p>
      ) : null}
    </div>
  );
}


/**
 * The check-and-reveal row.
 *
 * Present in every state of the panel, including the ones with nothing to show. A control that
 * disappears when the news is bad is a control people stop trusting, and "I could not see my
 * balance" is indistinguishable from "my balance was hidden from me".
 */
function SpendControls(props: {
  onCheck?: () => void;
  checking?: boolean;
  revealed: boolean;
  onToggleReveal?: () => void;
  checkedAt?: number;
  now: number;
}) {
  if (!props.onCheck && !props.onToggleReveal) return null;
  return (
    <div className="spend-controls">
      {props.onCheck ? (
        <button type="button" className="spend-button" onClick={props.onCheck} disabled={props.checking}>
          {props.checking ? "Checking…" : "Check balance"}
        </button>
      ) : null}
      {props.onToggleReveal ? (
        <button type="button" className="spend-button spend-button-quiet" onClick={props.onToggleReveal}>
          {props.revealed ? "Hide" : "Show balance"}
        </button>
      ) : null}
      {/* When it was last read, because a balance is a fact about a moment. */}
      {props.checkedAt !== undefined ? (
        <span className="spend-checked">{describeAge(props.now - props.checkedAt)}</span>
      ) : null}
    </div>
  );
}

/** "just now" / "4 min ago" / "2 h ago" — enough to judge whether to press the button again. */
export function describeAge(ageMs: number): string {
  const minutes = Math.floor(Math.max(0, ageMs) / 60_000);
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `checked ${hours} h ago`;
}

/** The two rates, side by side: what a turn costs, and what a minute of work costs. */
function PaceRow(props: { pace: NonNullable<ReturnType<typeof spendPace>> }) {
  const { pace } = props;
  return (
    <div className="spend-rates">
      <Rate label="per turn" micros={pace.perTurnMicros} currency={pace.currency} />
      <Rate label="per minute working" micros={pace.perMinuteMicros} currency={pace.currency} />
      <span className={`spend-trend spend-trend-${pace.trend}`}>
        {pace.trend === "rising" ? "↑ speeding up" : pace.trend === "easing" ? "↓ easing off" : "→ steady"}
      </span>
    </div>
  );
}

function Rate(props: { label: string; micros: number; currency: string }) {
  return (
    <span className="spend-rate">
      <strong>{formatRate(props.micros, props.currency)}</strong>
      <small>{props.label}</small>
    </span>
  );
}

/**
 * Spending speed over the session.
 *
 * A rate per turn rather than an amount, so a long expensive turn and a short expensive turn are
 * distinguishable — one is a big job, the other is money going fast. Gaps are gaps: an unpriced
 * turn breaks the line rather than dropping it to the floor, because a plunge to zero would read
 * as a turn that was free.
 */
function PaceSpark(props: { turns: readonly TurnCostPoint[] }) {
  const points = paceSeries(props.turns);
  const known = points.filter((point) => point.perMinuteMicros !== null);
  if (known.length < 2) return null;
  const peak = Math.max(...known.map((point) => point.perMinuteMicros!));
  if (peak <= 0) return null;

  // Segments, not one polyline: a break in the data has to be a break in the ink.
  const segments: string[][] = [];
  points.forEach((point, index) => {
    if (point.perMinuteMicros === null) {
      segments.push([]);
      return;
    }
    const x = points.length === 1 ? SPARK_WIDTH : (index / (points.length - 1)) * SPARK_WIDTH;
    const y = SPARK_HEIGHT - (point.perMinuteMicros / peak) * (SPARK_HEIGHT - 4);
    if (segments.length === 0) segments.push([]);
    segments[segments.length - 1].push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });

  return (
    <figure className="chart spend-spark">
      <figcaption className="chart-title">Spending speed</figcaption>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Cost per minute across ${points.length} turns.`}
      >
        <line x1="0" y1={SPARK_HEIGHT - 0.5} x2={SPARK_WIDTH} y2={SPARK_HEIGHT - 0.5} className="chart-axis" />
        {segments
          .filter((segment) => segment.length > 1)
          .map((segment, index) => (
            <polyline key={index} className="chart-line" points={segment.join(" ")} />
          ))}
      </svg>
    </figure>
  );
}

/**
 * A rate, formatted for a currency without a minor unit.
 *
 * RWF has no cents, so a rate of a few hundred micros would round to "RWF 0" and report a turn as
 * free. Below one whole unit the figure is given a decimal instead — the alternative is a panel
 * that says a paid turn cost nothing.
 */
export function formatRate(micros: number, currency: string): string {
  const units = micros / 1_000_000;
  if (currency !== "RWF") {
    return `${currency} ${units.toLocaleString("en-US", { maximumFractionDigits: units < 1 ? 4 : 2 })}`;
  }
  if (units > 0 && units < 1) return `RWF ${units.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return formatWholeRwf(units);
}

/** Minutes as something a person says out loud: "45 min", "2 h 10 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}
