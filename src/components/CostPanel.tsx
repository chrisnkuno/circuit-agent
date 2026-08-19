import { CostChart } from "./CostChart";
import type { TurnCostPoint } from "../lib/cost-chart";

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
          <strong>{props.displayTotal ?? "cost unknown"}</strong>
          {props.budgetFraction != null ? (
            <small>
              <br />
              Budget used: {Math.round(props.budgetFraction * 100)}%
            </small>
          ) : null}
          {props.warning ? (
            <small>
              <br />
              {props.warning}
            </small>
          ) : null}
        </div>
        {props.turns && props.turns.length > 0 ? <CostChart turns={props.turns} /> : null}
        {/* The written report stays: it is the table view the charts are read against, and the one
            place an unpriced model or a non-model expense is spelled out rather than drawn. */}
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--muted)" }}>
          {props.report || "No turns yet."}
        </pre>
      </div>
    </div>
  );
}
