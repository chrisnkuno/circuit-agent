import { CostChart } from "./CostChart";
import { SpendPanel } from "./SpendPanel";
import type { TurnCostPoint } from "../lib/cost-chart";
import type { BalanceReading } from "../lib/spend";

/**
 * What the session has spent.
 *
 * The total is the largest figure in the window and the only one set at display size: it is the one
 * number a person checks without being prompted, and it should be readable from across a desk. The
 * written report stays underneath the charts because it is the table they are read against — and
 * the one place an unpriced model or a non-model expense is spelled out rather than drawn.
 */
export function CostPanel(props: {
  report: string;
  displayTotal?: string;
  budgetFraction?: number;
  warning?: string;
  /** Per turn. The charts answer "which turn cost that", which a running total cannot. */
  turns?: readonly TurnCostPoint[];
  /** What the gateway last said is left. Absent when no billing service is configured. */
  balance?: BalanceReading;
  balanceUnavailable?: string;
  billingConfigured?: boolean;
  /** The deliberate re-read, always available — see SpendPanel. */
  onCheckBalance?: () => void;
  checkingBalance?: boolean;
  balanceRevealed?: boolean;
  onToggleBalance?: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header">Cost</div>
      <div className="panel-body">
        {/* Above the total, because it is the question people actually have. What a session has
            cost is a fact about the past; what is left and how fast it is going is the part that
            decides whether they can keep working. */}
        <SpendPanel
          balance={props.balance}
          unavailable={props.balanceUnavailable}
          configured={props.billingConfigured ?? false}
          turns={props.turns ?? []}
          onCheck={props.onCheckBalance}
          checking={props.checkingBalance}
          revealed={props.balanceRevealed}
          onToggleReveal={props.onToggleBalance}
        />
        <div className="cost-block">
          {/* Display size is for a figure. With nothing spent yet there is no figure, and setting
              the words "cost unknown" in 20px makes the absence of data look like data. */}
          {props.displayTotal
            ? <strong className="cost-total">{props.displayTotal}</strong>
            : <span className="cost-unknown">Nothing spent yet</span>}
          {props.budgetFraction != null ? (
            <small>Budget used: {Math.round(props.budgetFraction * 100)}%</small>
          ) : null}
          {props.warning ? <small className="cost-warning">{props.warning}</small> : null}
        </div>
        {props.turns && props.turns.length > 0 ? <CostChart turns={props.turns} /> : null}
        <pre className="cost-report">{props.report || "No turns yet."}</pre>
      </div>
    </div>
  );
}
