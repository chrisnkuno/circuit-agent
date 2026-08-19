import { useEffect, useRef } from "react";
import type { ActivityEntry } from "../lib/chat-state";

/**
 * What the agent is doing, beside the conversation rather than inside it.
 *
 * Tool calls used to be appended straight into the transcript — two lines each, one for the call
 * and one for the result — so a turn that read four files and ran the tests put ten machine lines
 * between one sentence of the answer and the next. Two different kinds of reading were competing
 * for one column: the answer, which is prose, and the log, which is checked rather than read.
 *
 * Each entry resolves in place: it arrives running and the result settles the same row. That keeps
 * the panel the length of the work rather than twice the length of it, and makes "what is it doing
 * right now" the last line rather than something to hunt for.
 */
export function ActivityPanel(props: { entries?: readonly ActivityEntry[]; busy: boolean }) {
  const listRef = useRef<HTMLOListElement>(null);
  // Tolerates a tab whose chat state predates this panel. The reducer always supplies the list, so
  // this is not a guard against the app's own logic — it is a guard against a *stale shape*, which
  // is what a hot reload hands you mid-session and what a restored session could hand you later.
  // A missing log is worth an empty panel; it is not worth taking the window down, which is what it
  // did the moment it was introduced.
  const entries = props.entries ?? [];
  const count = entries.length;

  useEffect(() => {
    // Follows the newest entry. The panel is short and the interesting end is the bottom; a log
    // that has to be scrolled to see what is happening now is not answering the question.
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [count]);

  return (
    <div className="panel">
      <div className="panel-header">
        <span>Activity</span>
        {count > 0 ? <span className="panel-count">{count}</span> : null}
      </div>
      <div className="panel-body">
        {count === 0 ? (
          <p className="panel-empty">
            {props.busy ? "Working…" : "Nothing yet. Tools Nova runs — reads, edits, commands — are listed here."}
          </p>
        ) : (
          <ol className="activity" ref={listRef}>
            {entries.map((entry) => (
              <li key={entry.id} className={`activity-row ${entry.status}`}>
                <span className="activity-mark" aria-hidden="true" />
                <div className="activity-text">
                  <span className="activity-name">{entry.name}</span>
                  {entry.summary ? <span className="activity-summary" title={entry.summary}>{entry.summary}</span> : null}
                  {/* Only for a tool that failed: a preview beside every successful call is the wall
                      of text this panel exists to get out of the transcript. */}
                  {entry.status === "failed" && entry.preview ? (
                    <span className="activity-preview">{entry.preview}</span>
                  ) : null}
                </div>
                {/* The state in a word as well as a colour, so it survives colour blindness and a
                    screen reader alike. */}
                <span className={`activity-state ${entry.status}`}>
                  {entry.status === "running" ? "running" : entry.status === "ok" ? "done" : "failed"}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}
