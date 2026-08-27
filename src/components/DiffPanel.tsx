import { useEffect, useState } from "react";
import { getDiff } from "../lib/ipc";

/**
 * What changed since the last checkpoint.
 *
 * `diff.get` existed in the sidecar and nothing called it, which left the app in an odd position:
 * it offered an Undo button and git checkpoints, but no way to see what you would be undoing. A
 * agent that edits your files and shows you nothing is asking for a lot of trust.
 */
export function DiffPanel(props: { open: boolean; onClose: () => void; tabId?: string; refreshKey?: number }) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!props.open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    getDiff(props.tabId)
      .then((result) => { if (!cancelled) setDiff((result as { diff?: string }).diff ?? ""); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.open, props.tabId, props.refreshKey]);

  useEffect(() => {
    if (!props.open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props]);

  if (!props.open) return null;

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
      <div className="modal diff-modal" role="dialog" aria-modal="true" aria-labelledby="diff-title">
        <div className="approval-head">
          <h2 id="diff-title">Changes since the last checkpoint</h2>
          <button className="btn ghost" type="button" onClick={props.onClose}>Close</button>
        </div>
        {loading ? <p className="panel-empty">Reading the working tree…</p> : null}
        {error ? <div className="notice danger" role="alert"><span>{error}</span></div> : null}
        {!loading && !error ? (
          diff && diff.trim()
            ? <pre className="diff-body">{diff}</pre>
            : <p className="panel-empty">Nothing has changed since the last checkpoint.</p>
        ) : null}
      </div>
    </div>
  );
}
