import { applyChatEvents, initialChatState, type ChatState } from "./chat-state";
import type { IpcEvent, NovaMode, ProviderId } from "./settings";

/**
 * Several pieces of work in one window.
 *
 * The window held one transcript, one project, one cost and one mode, and the sidecar underneath
 * held one session — so opening a second project ended the first. That is the wrong shape for how
 * the work actually goes: you are mid-refactor when a test starts failing for an unrelated reason,
 * and the choice was to lose the refactor's context or to open a second window with its own copy of
 * everything.
 *
 * Unlike the CLI's tabs, these are genuinely **parallel**: the daemon serialises turns per session,
 * not globally, so a turn in one tab runs while another tab streams. The CLI's are sequential for a
 * reason that does not apply here — a scrolling terminal transcript has one bottom, and two agents
 * writing to it would interleave into nonsense. A window has as many transcripts as it has tabs.
 *
 * That parallelism is what makes this file's job worth doing carefully. Once two turns can be in
 * flight, every event carries an implicit "whose is this?", and getting it wrong is silent: the
 * wrong transcript grows and nothing complains. So events are routed on the `tabId` the sidecar
 * stamped them with, never on which tab is in front.
 *
 * Pure functions over a plain value, in the style `chat-state.ts` set for exactly this reason — the
 * most important behaviour in the window should not be the behaviour that needs a DOM to observe.
 */

export type TabStatus = "idle" | "running" | "failed";

export type WindowTab = {
  /** The sidecar's tab id — the address every request and event uses. Stable across session rebuilds. */
  readonly tabId: string;
  /** The live session inside the tab; changes when the tab's agent is rebuilt. */
  sessionId?: string;
  title: string;
  root: string | null;
  mode: NovaMode;
  sandbox: boolean;
  model?: string;
  provider?: ProviderId;
  status: TabStatus;
  /**
   * Turns that finished here since it was last looked at.
   *
   * The whole point of a background tab is that you are not watching it, so "what moved while I was
   * elsewhere" is the question the strip has to answer. Counted per tab and cleared on activation.
   */
  unread: number;
  /** True when this tab is waiting on an approval — the one badge worth interrupting for. */
  needsApproval: boolean;
  chat: ChatState;
  /** Kept per tab so switching away mid-sentence does not throw the sentence away. */
  draft: string;
  /**
   * A request for this tab is in flight — opening a project, switching mode, undoing.
   *
   * Separate from `status`, which is about *turns*. Both make a tab busy, but only one of them is
   * the agent working: a strip that showed "running" while a sandbox was booting would be claiming
   * the model was thinking when nothing had been sent to it yet.
   */
  busy: boolean;
  /** This tab's own budget warning, since two tabs have two ledgers. */
  warning?: string;
  todos: Array<{ id: string; content: string; status: string }>;
};

export type TabsState = {
  tabs: WindowTab[];
  activeTabId: string | null;
};

export function initialTabsState(): TabsState {
  return { tabs: [], activeTabId: null };
}

export function activeTab(state: TabsState): WindowTab | undefined {
  return state.tabs.find((tab) => tab.tabId === state.activeTabId);
}

export function findTab(state: TabsState, tabId: string): WindowTab | undefined {
  return state.tabs.find((tab) => tab.tabId === tabId);
}

/** A tab as it exists before any session is open in it — the blank one the window starts with. */
export function blankTab(tabId: string, mode: NovaMode = "build"): WindowTab {
  return {
    tabId,
    title: "New tab",
    root: null,
    mode,
    sandbox: false,
    status: "idle",
    unread: 0,
    needsApproval: false,
    chat: initialChatState(),
    draft: "",
    busy: false,
    todos: [],
  };
}

export function addTab(state: TabsState, tab: WindowTab): TabsState {
  return { tabs: [...state.tabs, tab], activeTabId: tab.tabId };
}

/**
 * Brings a tab to the front, and clears what it was holding for you.
 *
 * The unread count is cleared here rather than when the events arrived, because that count means
 * "changed since you looked" and this is the moment you looked. The approval badge is *not* cleared:
 * it means "still waiting on you", which switching to the tab does not answer.
 */
export function activateTab(state: TabsState, tabId: string): TabsState {
  if (!findTab(state, tabId)) return state;
  return {
    activeTabId: tabId,
    tabs: state.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, unread: 0 } : tab)),
  };
}

/**
 * Removes a tab, moving to its neighbour.
 *
 * The right-hand neighbour, or the left when the last tab goes — the same rule the sidecar's
 * registry follows, so the window and the engine agree about which tab is in front without having
 * to ask. Closing three in a row walks along the strip instead of throwing the reader back to the
 * start of their list each time.
 */
export function removeTab(state: TabsState, tabId: string): TabsState {
  const index = state.tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.tabId !== tabId);
  if (state.activeTabId !== tabId) return { ...state, tabs };
  const neighbour = tabs[index] ?? tabs[index - 1];
  return { tabs, activeTabId: neighbour?.tabId ?? null };
}

/**
 * Gives a tab the id the sidecar chose for it.
 *
 * The window opens a blank tab before any session exists — you can type into it, and a scratch
 * session is created on send — so it needs a local id first and takes the real one afterwards. The
 * alternative is a tab that cannot be addressed until its session opens, which means events
 * arriving during the open have nowhere to go.
 */
export function adoptTabId(state: TabsState, localId: string, tabId: string): TabsState {
  if (localId === tabId) return state;
  return {
    activeTabId: state.activeTabId === localId ? tabId : state.activeTabId,
    tabs: state.tabs.map((tab) => (tab.tabId === localId ? { ...tab, tabId } : tab)),
  };
}

/** Replaces one tab's fields, leaving every other tab exactly as it was. */
export function updateTab(state: TabsState, tabId: string, patch: Partial<Omit<WindowTab, "tabId">>): TabsState {
  return { ...state, tabs: state.tabs.map((tab) => (tab.tabId === tabId ? { ...tab, ...patch } : tab)) };
}

/** Which tab in the strip is `steps` away from the front — how Ctrl+Tab and Ctrl+Shift+Tab move. */
export function neighbourTabId(state: TabsState, steps: number): string | null {
  if (state.tabs.length === 0) return null;
  const index = state.tabs.findIndex((tab) => tab.tabId === state.activeTabId);
  if (index < 0) return state.tabs[0]?.tabId ?? null;
  // Wrapping, unlike every list in the CLI. A tab strip is short, fully visible and horizontal:
  // there is no "somewhere off screen" for the cursor to disappear to, and cycling round is what
  // every tabbed application has taught this key to do.
  const size = state.tabs.length;
  return state.tabs[((index + steps) % size + size) % size]?.tabId ?? null;
}

/** The tab at a 1-based position — what Ctrl+1 … Ctrl+9 select. */
export function tabAtPosition(state: TabsState, position: number): string | null {
  return state.tabs[position - 1]?.tabId ?? null;
}

/**
 * Folds a batch of sidecar events into the tabs they belong to.
 *
 * Grouped by tab and applied per tab, rather than one at a time against the whole window, so that
 * `applyChatEvents`'s own sequencing rules — a delta coalescing into the streaming message, a turn
 * settling in place — hold within each transcript even when two tabs' events are interleaved in the
 * queue, which is exactly what happens when two turns stream at once.
 *
 * An event whose tab has been closed, or which the sidecar could not attribute, is dropped rather
 * than applied to the active tab: appending one tab's answer to another's transcript is a worse
 * outcome than losing a token from a session nobody is watching any more.
 */
export function applyTabEvents(state: TabsState, events: readonly IpcEvent[], now: () => number = Date.now): TabsState {
  const grouped = new Map<string, IpcEvent[]>();
  for (const event of events) {
    const tabId = "tabId" in event ? event.tabId : undefined;
    if (!tabId || !findTab(state, tabId)) continue;
    const bucket = grouped.get(tabId);
    if (bucket) bucket.push(event);
    else grouped.set(tabId, [event]);
  }
  if (grouped.size === 0) return state;

  return {
    ...state,
    tabs: state.tabs.map((tab) => {
      const batch = grouped.get(tab.tabId);
      if (!batch) return tab;
      const chat = applyChatEvents(tab.chat, batch, now);
      const background = tab.tabId !== state.activeTabId;
      return {
        ...tab,
        chat,
        status: statusAfter(tab.status, batch),
        // Only a *finished* turn counts as something to come back to. Counting deltas would tick the
        // badge hundreds of times for one answer and tell the reader nothing they did not know.
        unread: background ? tab.unread + batch.filter(isFinishedTurn).length : 0,
        needsApproval: chat.approval !== null,
      };
    }),
  };
}

function isFinishedTurn(event: IpcEvent): boolean {
  return event.type === "turn_status" && event.status !== "running";
}

/**
 * What a batch does to a tab's status light.
 *
 * Read from the last status-bearing event in the batch rather than from the first, because a batch
 * can contain a whole turn — running through to completed — and the light should show where the tab
 * ended up, not where it started.
 */
function statusAfter(current: TabStatus, batch: readonly IpcEvent[]): TabStatus {
  let status = current;
  for (const event of batch) {
    if (event.type === "turn_status") {
      status = event.status === "running" ? "running" : event.status === "failed" ? "failed" : "idle";
    } else if (event.type === "error") {
      status = "failed";
    }
  }
  return status;
}

/**
 * A one-line summary of what the window is doing, for the strip's own heading.
 *
 * Worth stating because parallelism is invisible when it works: two tabs quietly running look
 * exactly like two tabs quietly idle unless something says otherwise.
 */
export function describeWork(state: TabsState): string {
  const running = state.tabs.filter((tab) => tab.status === "running").length;
  const waiting = state.tabs.filter((tab) => tab.needsApproval).length;
  const parts: string[] = [];
  if (running > 0) parts.push(`${running} running`);
  if (waiting > 0) parts.push(`${waiting} waiting on you`);
  return parts.join(" · ");
}
