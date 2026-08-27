import { useEffect, useRef } from "react";
import { approvalDetail, approvalKey } from "../lib/approval";
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog";
import type { ApprovalPreview, PermissionDecision } from "../lib/settings";

export type ApprovalState = {
  requestId: string;
  toolName: string;
  summary: string;
  effect?: "none" | "workspace" | "external";
  safety?: { sensitive: boolean; categories: string[]; reasons: string[] };
  preview?: ApprovalPreview;
};

/** A compact unified replacement view from the exact arguments the core is waiting to execute. */
export function renderApprovalPreview(preview: ApprovalPreview): string {
  if (preview.toolName === "write_file") {
    return [`--- /dev/null`, `+++ ${preview.path}`, ...preview.content.split("\n").map((line) => `+${line}`)].join("\n");
  }
  return [
    `--- ${preview.path}`,
    `+++ ${preview.path}`,
    "@@ proposed replacement @@",
    ...preview.oldText.split("\n").map((line) => `-${line}`),
    ...preview.newText.split("\n").map((line) => `+${line}`),
  ].join("\n");
}

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

  return (
    <Dialog open>
      <DialogContent
        className="approval"
        role="alertdialog"
        aria-labelledby="approval-title"
        aria-describedby="approval-subject"
        tabIndex={-1}
        ref={dialogRef}
        // Focus lands on the dialog, never on a button. Radix would otherwise focus the first
        // focusable child, which is "Allow once" — making Enter, the key people press to dismiss
        // things, an approval. That is the one outcome that must not be reachable by reflex.
        onOpenAutoFocus={(event) => { event.preventDefault(); dialogRef.current?.focus(); }}
        // Escape is *answered*, not obeyed: the keyboard handler below turns it into a denial, so
        // Radix must not also close the dialog behind it. A dialog that vanishes while the agent is
        // still waiting is a hang with no visible cause.
        onEscapeKeyDown={(event) => event.preventDefault()}
        // An approval cannot be dismissed by clicking past it either — there is a decision to make.
        onPointerDownOutside={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <div className="approval-head">
          {/* Radix's own title, rendered as the heading this dialog already had. Without it the
              primitive has nothing to point `aria-modal` labelling at, and warns in development. */}
          <DialogTitle asChild>
            <h2 id="approval-title">{detail.executes ? "Run this command?" : "Allow this action?"}</h2>
          </DialogTitle>
          <code className="approval-tool">{props.approval.toolName}</code>
        </div>

        {detail.note ? <p className="approval-note">{detail.note}</p> : null}

        {props.approval.safety?.sensitive ? (
          <div className="approval-warning" role="note">
            <strong>Sensitive action</strong>
            <span>{props.approval.safety.reasons.join(" · ") || props.approval.safety.categories.join(" · ")}</span>
          </div>
        ) : null}

        {/* The subject is the thing under review, so it is shown in full and selectable rather than
            truncated to fit. It scrolls if it is long; it is never shortened. */}
        <pre id="approval-subject" className={`approval-subject${detail.executes ? " executes" : ""}`}>
          {detail.subject ?? "No detail was provided for this call."}
        </pre>

        {props.approval.preview ? (
          <section className="approval-change" aria-labelledby="approval-change-title">
            <h3 id="approval-change-title">Exact proposed change</h3>
            <pre>{renderApprovalPreview(props.approval.preview)}</pre>
          </section>
        ) : null}

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
      </DialogContent>
    </Dialog>
  );
}
