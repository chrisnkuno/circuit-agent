import { CostChart } from "./CostChart";
import type { TurnCostPoint } from "../lib/cost-chart";

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
}) {
  return (
    <div className="panel">
      <div className="panel-header">Cost</div>
      <div className="panel-body">
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
