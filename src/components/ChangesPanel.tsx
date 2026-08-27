import { Button } from "./ui/button";

/** A persistent, live answer to “did it actually change code?”, beside the tool activity. */
export function ChangesPanel(props: {
  diffStat?: string;
  paths: readonly string[];
  busy: boolean;
  onReview: () => void;
  onFiles: () => void;
}) {
  const hasChanges = Boolean(props.diffStat?.trim()) || props.paths.length > 0;
  return (
    <div className="panel changes-panel">
      <div className="panel-header">
        <span>Changes</span>
        {hasChanges ? <span className="panel-count">{props.paths.length || "live"}</span> : null}
      </div>
      <div className="panel-body">
        {hasChanges ? (
          <>
            {props.diffStat?.trim() ? <pre className="changes-stat">{props.diffStat.trim()}</pre> : null}
            {!props.diffStat?.trim() && props.paths.length > 0 ? (
              <ul className="changes-files">
                {props.paths.slice(-6).map((path) => <li key={path}>{path}</li>)}
              </ul>
            ) : null}
            <div className="btn-group">
              <Button variant="primary" size="sm" onClick={props.onReview}>Review diff</Button>
              <Button variant="ghost" size="sm" onClick={props.onFiles}>Open files</Button>
            </div>
          </>
        ) : (
          <p className="panel-empty">{props.busy ? "Watching the working tree…" : "No code changes in this session yet."}</p>
        )}
      </div>
    </div>
  );
}
