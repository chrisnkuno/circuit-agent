export type SessionSummary = { id: string; title: string; updatedAt: number };

export function SessionList(props: {
  sessions: SessionSummary[];
  activeId?: string;
  onResume: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="panel">
      <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span>Sessions</span>
        <button className="btn ghost" type="button" onClick={props.onRefresh}>
          Refresh
        </button>
      </div>
      <div className="panel-body">
        {props.sessions.length === 0 ? <div className="msg system">No sessions in this project yet.</div> : null}
        {props.sessions.map((session) => (
          <div key={session.id} className="session-item" style={props.activeId === session.id ? { borderColor: "rgba(61,214,198,0.5)" } : undefined}>
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
