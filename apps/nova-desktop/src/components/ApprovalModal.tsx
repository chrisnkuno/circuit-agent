import { useEffect, useRef } from "react";
import { approvalDetail, approvalKey } from "../lib/approval";
import type { PermissionDecision } from "../lib/settings";

export type ApprovalState = {
  requestId: string;
  toolName: string;
  summary: string;
};

const CHOICES: Array<{ decision: PermissionDecision; label: string; key: string; hint: string; tone?: "danger" }> = [
  { decision: "allow", label: "Allow once", key: "Y", hint: "Run this one call" },
  { decision: "deny", label: "Deny", key: "N", hint: "Refuse this one call" },
  { decision: "allow_always", label: "Always allow", key: "A", hint: "Remember for this exact action" },
  { decision: "deny_always", label: "Always deny", key: "D", hint: "Remember for this exact action", tone: "danger" },
];

export function ApprovalModal(props: {
  approval: ApprovalState;
  onRespond: (decision: PermissionDecision) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const detail = approvalDetail(props.approval.toolName, props.approval.summary);

  // Focus moves to the dialog, not to a button. Landing on "Allow once" would make Enter — the key
  // people press to dismiss things — an approval, which is the one outcome that must never be
  // reachable by reflex.
  useEffect(() => { dialogRef.current?.focus(); }, [props.approval.requestId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const result = approvalKey(event);
      if (!result || !("decision" in result)) return;
      event.preventDefault();
      props.onRespond(result.decision);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  /** Keeps Tab inside the dialog: nothing behind it is answerable while it is open. */
  function trapTab(event: React.KeyboardEvent) {
    if (event.key !== "Tab") return;
    const focusable = dialogRef.current?.querySelectorAll<HTMLElement>("button");
    if (!focusable || focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return (
    <div className="modal-backdrop">
      <div
        className="modal approval"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="approval-title"
        aria-describedby="approval-subject"
        tabIndex={-1}
        ref={dialogRef}
        onKeyDown={trapTab}
      >
        <div className="approval-head">
          <h2 id="approval-title">{detail.executes ? "Run this command?" : "Allow this action?"}</h2>
          <code className="approval-tool">{props.approval.toolName}</code>
        </div>

        {detail.note ? <p className="approval-note">{detail.note}</p> : null}

        {/* The subject is the thing under review, so it is shown in full and selectable rather than
            truncated to fit. It scrolls if it is long; it is never shortened. */}
        <pre id="approval-subject" className={`approval-subject${detail.executes ? " executes" : ""}`}>
          {detail.subject ?? "No detail was provided for this call."}
        </pre>

        <div className="modal-actions">
          {CHOICES.map((choice) => (
            <button
              key={choice.decision}
              className={`btn approval-choice${choice.tone === "danger" ? " danger" : ""}`}
              type="button"
              title={choice.hint}
              onClick={() => props.onRespond(choice.decision)}
            >
              <span>{choice.label}</span>
              <kbd>{choice.key}</kbd>
            </button>
          ))}
        </div>
        <p className="approval-footnote">
          Escape denies. “Always” applies only to this exact action, not to the tool in general.
        </p>
      </div>
    </div>
  );
}
