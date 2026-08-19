import { Button } from "./ui/button";

export type SessionSummary = { id: string; title: string; updatedAt: number };

/**
 * Past conversations in the project that is open.
 *
 * The current one is marked on its left edge rather than filled. This is a list you scan — twenty
 * rows of similar-looking titles — and a filled row is a distraction from the nineteen you are
 * scanning past, where a 2px rule is a landmark you find without being pulled to it.
 */
export function SessionList(props: {
  sessions: SessionSummary[];
  activeId?: string;
  onResume: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header">
        <span>Sessions</span>
        <Button variant="ghost" size="sm" onClick={props.onRefresh}>Refresh</Button>
      </div>
      <div className="panel-body">
        {props.sessions.length === 0 ? <p className="panel-empty">No sessions in this project yet.</p> : null}
        {props.sessions.map((session) => (
          <div key={session.id} className={`session-item${props.activeId === session.id ? " current" : ""}`}>
            <button type="button" onClick={() => props.onResume(session.id)}>
              <strong>{session.title || session.id}</strong>
              <small>{new Date(session.updatedAt).toLocaleString()}</small>
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
