import type { PermissionDecision } from "../lib/settings";

export type ApprovalState = {
  requestId: string;
  toolName: string;
  summary: string;
};

export function ApprovalModal(props: {
  approval: ApprovalState;
  onRespond: (decision: PermissionDecision) => void;
}) {
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <h2 id="approval-title">Approve tool call</h2>
        <p>
          <strong>{props.approval.toolName}</strong>
          <br />
          {props.approval.summary}
        </p>
        <div className="modal-actions">
          <button className="btn primary" type="button" onClick={() => props.onRespond("allow")}>
            Yes
          </button>
          <button className="btn" type="button" onClick={() => props.onRespond("deny")}>
            No
          </button>
          <button className="btn" type="button" onClick={() => props.onRespond("allow_always")}>
            Always
          </button>
          <button className="btn" type="button" onClick={() => props.onRespond("deny_always")}>
            Deny always
          </button>
        </div>
      </div>
    </div>
  );
}
