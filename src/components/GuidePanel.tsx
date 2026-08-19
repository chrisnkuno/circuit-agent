import { useMemo, useState } from "react";
import { GUIDE, keysFor, searchGuide } from "../lib/guide";
import { SHORTCUTS, type ShortcutAction } from "../lib/shortcuts";
import { Dialog, DialogClose, DialogContent, DialogHeader, DialogTitle } from "./ui/dialog";

/**
 * The guide, as a screen you can read beside your work.
 *
 * An index on the left and one topic on the right, which is the shape that suits a dozen entries:
 * a reader can see the whole table of contents at once and still be reading something. The search
 * narrows the index rather than replacing it with results, so you never lose your place in the
 * list to find out that a query matched nothing.
 */
export function GuidePanel(props: { open: boolean; onClose: () => void }) {
  const [topicId, setTopicId] = useState<string>(GUIDE[0].id);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => searchGuide(query), [query]);
  const topic = useMemo(() => GUIDE.find((entry) => entry.id === topicId) ?? GUIDE[0], [topicId]);

  return (
    <Dialog open={props.open} onOpenChange={(next) => { if (!next) props.onClose(); }}>
      <DialogContent className="guide-modal" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>Guide</DialogTitle>
          <DialogClose asChild><button className="btn ghost" type="button">Close</button></DialogClose>
        </DialogHeader>

        <div className="guide-panes">
          <div className="guide-index">
            <input
              className="file-search"
              type="search"
              placeholder="Search the guide…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search the guide"
              autoFocus
            />
            {matches.length === 0 ? <p className="panel-empty">Nothing in the guide mentions “{query}”.</p> : null}
            <ul className="guide-list">
              {matches.map((entry) => (
                <li key={entry.id}>
                  <button
                    className={`guide-entry${entry.id === topic.id ? " current" : ""}`}
                    type="button"
                    onClick={() => setTopicId(entry.id)}
                    aria-current={entry.id === topic.id ? "true" : undefined}
                  >
                    <span className="guide-entry-title">{entry.title}</span>
                    <span className="guide-entry-summary">{entry.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>

          <article className="guide-body" aria-live="polite">
            <h3 className="guide-body-title">{topic.title}</h3>
            {topic.body.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            {topic.shortcuts && topic.shortcuts.length > 0 ? (
              <table className="guide-keys">
                <caption className="sr-only">Shortcuts for {topic.title}</caption>
                <tbody>
                  {topic.shortcuts.map((action) => (
                    <tr key={action}>
                      <th scope="row"><kbd>{keysFor(action)}</kbd></th>
                      <td>{labelFor(action)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </article>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** What a shortcut does, in the binding's own words — one source for the help panel and the guide. */
function labelFor(action: ShortcutAction): string {
  return SHORTCUTS.find((binding) => binding.action === action)?.label ?? action;
}
