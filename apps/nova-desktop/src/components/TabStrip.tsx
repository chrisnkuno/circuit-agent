import type { WindowTab } from "../lib/tabs";

/**
 * The strip that makes parallel work visible.
 *
 * Parallelism has an awkward property as a feature: when it is working, it is invisible. A tab
 * quietly running a turn in the background looks exactly like a tab sitting idle, unless something
 * on screen says otherwise — so this strip's real job is not switching, which any list of buttons
 * can do, but *reporting*: which tabs are working, which one needs a decision before it can go on,
 * and what has finished since you last looked.
 *
 * Three markers, in order of how much they should interrupt you:
 *
 * - **Waiting on you** — an approval is parked. Nothing more happens in that tab until it is
 *   answered, so it reads loudest and is the one marker switching tabs does not clear.
 * - **Running** — a turn is in flight. Reassurance rather than a demand.
 * - **A count** — turns that finished while you were elsewhere. Cleared by looking.
 *
 * Each is given a word as well as a colour: a strip that says what it means with hue alone excludes
 * the readers most likely to be running several things at once and needing to tell them apart.
 */

export function TabStrip(props: {
  tabs: readonly WindowTab[];
  activeTabId: string | null;
  /** One line summarising the window — "2 running · 1 waiting on you", or empty when quiet. */
  summary: string;
  busy: boolean;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onNew: () => void;
}) {
  // A single tab is not a tab strip, it is a title bar with extra steps. Hiding it until there is
  // something to switch between keeps the window exactly as it was for anyone who never wants a
  // second one — the New tab button lives in the header either way.
  if (props.tabs.length <= 1) return null;

  return (
    <div className="tab-strip" role="tablist" aria-label="Open work">
      {props.tabs.map((tab, index) => {
        const active = tab.tabId === props.activeTabId;
        return (
          <div
            key={tab.tabId}
            className={`tab ${active ? "active" : ""} ${tab.status} ${tab.needsApproval ? "needs-approval" : ""}`}
          >
            <button
              className="tab-select"
              role="tab"
              aria-selected={active}
              type="button"
              onClick={() => props.onSelect(tab.tabId)}
              // The position is in the tooltip because it is also the shortcut: the ninth tab is
              // Ctrl+9, and a strip that never says so is a strip whose shortcuts nobody discovers.
              title={`${tab.root ?? "No project"}${index < 9 ? ` · Ctrl ${index + 1}` : ""}`}
            >
              <span className="tab-title">{tab.title}</span>
              {tab.needsApproval ? (
                <span className="tab-badge waiting" title="Waiting for your approval">
                  waiting
                </span>
              ) : tab.status === "running" ? (
                <span className="tab-badge running" title="A turn is running here">
                  running
                </span>
              ) : tab.status === "failed" ? (
                <span className="tab-badge failed" title="The last turn here failed">
                  failed
                </span>
              ) : tab.unread > 0 ? (
                <span className="tab-badge unread" title={`${tab.unread} finished since you were last here`}>
                  {tab.unread}
                </span>
              ) : null}
            </button>
            <button
              className="tab-close"
              type="button"
              aria-label={`Close ${tab.title}`}
              title="Close this tab (Ctrl W)"
              onClick={() => props.onClose(tab.tabId)}
            >
              ×
            </button>
          </div>
        );
      })}

      <button className="tab-new" type="button" title="New tab (Ctrl T)" onClick={props.onNew} disabled={props.busy}>
        +
      </button>

      {/* The window's own state, once, rather than left for the reader to total up from the badges. */}
      {props.summary ? <span className="tab-summary">{props.summary}</span> : null}
    </div>
  );
}
