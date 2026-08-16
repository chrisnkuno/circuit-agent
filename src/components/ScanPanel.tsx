import { useEffect, useState } from "react";
import { scanSecrets } from "../lib/ipc";
import { countBySeverity, sortFindings, summarize, type PlacedSecretFinding } from "../lib/scan";

/**
 * The deterministic secret scan, as a panel.
 *
 * Defender mode arrived in the desktop with no way to actually run anything — you could select the
 * posture and then had to ask the model, in prose, to go looking. This is the half that needs no
 * model at all: a fixed set of patterns over the working tree, so it is instant, free, repeatable,
 * and gives the same answer twice.
 *
 * Secrets are shown masked. The panel exists to say *where* to look, and printing the credential
 * back onto the screen — into a window that may be screen-shared, and into a screenshot attached to
 * the bug report about it — would leak the thing it is warning you about.
 */
export function ScanPanel(props: { open: boolean; onClose: () => void }) {
  const [findings, setFindings] = useState<PlacedSecretFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    scanSecrets()
      .then((result) => { if (!cancelled) setFindings(sortFindings(result.findings ?? [])); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  if (!props.open) return null;

  const counts = findings ? countBySeverity(findings) : [];
  const clean = findings !== null && findings.length === 0;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal diff-modal" role="dialog" aria-modal="true" aria-labelledby="scan-title">
        <div className="approval-head">
          <h2 id="scan-title">Secret scan</h2>
          <button className="btn ghost" type="button" onClick={props.onClose}>Close</button>
        </div>

        {loading ? <p className="panel-empty">Scanning the working tree…</p> : null}
        {error ? <div className="notice danger" role="alert"><span>{error}</span></div> : null}

        {findings && !loading && !error ? (
          <>
            <div className={`notice ${clean ? "" : "danger"}`} role="status">
              <span>{summarize(findings)}</span>
            </div>
            {counts.length > 0 ? (
              <div className="scan-counts">
                {counts.map(({ severity, count }) => (
                  <span key={severity} className={`scan-chip sev-${severity}`}>{count} {severity}</span>
                ))}
              </div>
            ) : null}
            <ul className="scan-list">
              {findings.map((finding) => (
                <li key={`${finding.path}:${finding.line}:${finding.kind}`} className="scan-item">
                  <span className={`scan-dot sev-${finding.severity}`} aria-hidden="true" />
                  <span className="scan-where">{finding.path}:{finding.line}</span>
                  <span className="scan-kind">{finding.kind}</span>
                  <code className="scan-masked">{finding.masked}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </div>
    </div>
  );
}
