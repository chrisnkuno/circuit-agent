import { describeStatus, isBusy, type UpdateStatus } from "../lib/updates";

/**
 * Asking for a new version, and watching one arrive.
 *
 * The app checked at startup and said nothing unless it found something, which leaves the person
 * who has heard a release is out with nowhere to go and no way to tell "up to date" from "never
 * checked". A button answers both, including — especially — when the answer is that there is
 * nothing to do.
 */
export function UpdatePanel(props: {
  currentVersion: string;
  status: UpdateStatus;
  onCheck: () => void;
  onInstall: () => void;
}) {
  const { status } = props;
  const busy = isBusy(status);
  const percent = status.kind === "downloading" ? status.percent : undefined;

  return (
    <section className="update-panel">
      <div className="update-panel-row">
        <div className="update-panel-text">
          <strong>Nova {props.currentVersion}</strong>
          {/* `aria-live` so the outcome of pressing the button is announced rather than only drawn:
              "you are up to date" is the common answer and the easiest one to miss. */}
          <span className="update-panel-status" aria-live="polite">
            {status.kind === "idle" ? "Updates are checked each time Nova starts." : describeStatus(status)}
          </span>
        </div>

        {status.kind === "available" ? (
          <button className="btn primary" type="button" onClick={props.onInstall}>
            Update to {status.update.version}
          </button>
        ) : (
          <button className="btn ghost" type="button" disabled={busy} onClick={props.onCheck}>
            {status.kind === "checking" ? "Checking…" : "Check for updates"}
          </button>
        )}
      </div>

      {/* Determinate only when the server sent a length; otherwise an indeterminate bar, because a
          percentage invented from a guess sticks near the end and reads as a stall. */}
      {status.kind === "downloading" || status.kind === "installing" ? (
        <div
          className={`update-progress${percent === undefined ? " indeterminate" : ""}`}
          role="progressbar"
          aria-label="Update progress"
          {...(percent === undefined ? {} : { "aria-valuenow": percent, "aria-valuemin": 0, "aria-valuemax": 100 })}
        >
          <div className="update-progress-fill" style={percent === undefined ? undefined : { width: `${percent}%` }} />
        </div>
      ) : null}

      {status.kind === "failed" ? (
        <p className="notice danger" role="alert">{describeStatus(status)}</p>
      ) : null}
    </section>
  );
}
