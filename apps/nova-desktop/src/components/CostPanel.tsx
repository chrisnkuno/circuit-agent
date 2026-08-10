export function CostPanel(props: {
  report: string;
  displayTotal?: string;
  budgetFraction?: number;
  warning?: string;
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
        <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "var(--mono)", fontSize: "0.78rem", color: "var(--muted)" }}>
          {props.report || "No turns yet."}
        </pre>
      </div>
    </div>
  );
}
