/**
 * Which tab a request means, and which tab an event came from.
 *
 * The sidecar used to hold exactly one of everything — one client, one workspace, one ledger — and
 * every request acted on it implicitly. That is why opening a second project killed the first: the
 * only way to start a session was to replace the session. The daemon underneath never had that
 * limit (`NovaSessionDaemon` has held a map of live sessions and serialises turns *per session* from
 * the beginning), so parallel work was always one bookkeeping layer away.
 *
 * This is that layer, and it is deliberately pure — no agent, no workspace, no daemon. Routing is
 * exactly where a mistake is most expensive and least visible: a misrouted event does not throw, it
 * appends one tab's answer to another tab's transcript, and the reader has no way to tell that is
 * what happened. Pure bookkeeping can be tested exhaustively without constructing a model provider.
 *
 * A **tab id** is the address, not a session id. Sessions are replaced inside a tab all the time —
 * opening a different folder, switching mode, resuming an old transcript all build a fresh agent —
 * and a UI that addressed tabs by session id would lose track of a tab every time its contents were
 * rebuilt. The session id stays as a secondary index because that is what the daemon tags its
 * notifications with, and translating it back to a tab is this file's other job.
 */

export type TabEntry<T> = {
  readonly tabId: string;
  /** The live session inside the tab. Changes when the tab's contents are rebuilt; the tab id does not. */
  sessionId: string;
  payload: T;
};

/** How a tab reads to the window drawing the strip. Filled in by the host from its own slots. */
export type TabSummary = {
  tabId: string;
  sessionId: string;
  title: string;
  root: string;
  mode: string;
  sandbox: boolean;
  model?: string;
  provider?: string;
  active: boolean;
};

export class TabRegistry<T> {
  private readonly entries: TabEntry<T>[] = [];
  private activeTabId: string | null = null;
  private sequence = 0;

  /**
   * The cap exists so a runaway caller cannot open sessions until the machine gives out. Each tab is
   * a live agent holding a workspace, a transcript and possibly a remote sandbox, so these are not
   * cheap the way browser tabs are — nine is the same limit the CLI's own tab controller sets, and
   * for the same reason.
   */
  constructor(private readonly limit = 9) {}

  get size(): number { return this.entries.length; }
  get activeId(): string | null { return this.activeTabId; }

  list(): readonly TabEntry<T>[] { return this.entries; }

  /** Opens a tab and brings it to the front. The id is the address every later request uses. */
  add(sessionId: string, payload: T): TabEntry<T> {
    if (this.entries.length >= this.limit) {
      throw new Error(`Already at ${this.limit} tabs — close one before opening another.`);
    }
    this.sequence += 1;
    const entry: TabEntry<T> = { tabId: `tab_${this.sequence}`, sessionId, payload };
    this.entries.push(entry);
    this.activeTabId = entry.tabId;
    return entry;
  }

  /**
   * Swaps what is inside a tab, keeping the tab itself.
   *
   * Returns the payload that was there so the caller can dispose of it — the registry holds
   * references, not lifetimes, and a client left connected is a session that never ends.
   */
  replace(tabId: string, sessionId: string, payload: T): T {
    const entry = this.require(tabId);
    const previous = entry.payload;
    entry.sessionId = sessionId;
    entry.payload = payload;
    return previous;
  }

  /**
   * The tab a request means: the one it named, or the active one when it named none.
   *
   * The fallback is what keeps every existing single-tab caller working unchanged — a request with
   * no tab id means "the tab I am looking at", which is exactly what it meant when there was only
   * one.
   */
  resolve(tabId?: string): TabEntry<T> {
    if (tabId) return this.require(tabId);
    const active = this.entries.find((entry) => entry.tabId === this.activeTabId);
    if (!active) throw new Error("Open a project session first.");
    return active;
  }

  /** Present but not required — for the paths that want to know rather than to fail. */
  find(tabId?: string): TabEntry<T> | undefined {
    if (tabId) return this.entries.find((entry) => entry.tabId === tabId);
    return this.entries.find((entry) => entry.tabId === this.activeTabId);
  }

  /** Which tab a daemon notification belongs to. Undefined for a session that has already been closed. */
  bySession(sessionId: string): TabEntry<T> | undefined {
    return this.entries.find((entry) => entry.sessionId === sessionId);
  }

  activate(tabId: string): TabEntry<T> {
    const entry = this.require(tabId);
    this.activeTabId = tabId;
    return entry;
  }

  /**
   * Closes a tab and says what was in it, so the caller can shut that session down.
   *
   * The tab that takes its place is its neighbour — the one to the right, or the left when the last
   * tab is closed. Jumping to the first tab instead would be simpler and wrong: closing three tabs
   * in a row would throw the user back to the beginning of their list each time.
   */
  close(tabId: string): { payload: T; nextActive: string | null } {
    const index = this.entries.findIndex((entry) => entry.tabId === tabId);
    if (index < 0) throw new Error(`No such tab: ${tabId}`);
    const [removed] = this.entries.splice(index, 1);
    if (this.activeTabId === tabId) {
      const neighbour = this.entries[index] ?? this.entries[index - 1];
      this.activeTabId = neighbour?.tabId ?? null;
    }
    return { payload: removed.payload, nextActive: this.activeTabId };
  }

  /** Everything, emptied — for shutdown, where every payload still has to be disposed of. */
  drain(): T[] {
    const payloads = this.entries.map((entry) => entry.payload);
    this.entries.length = 0;
    this.activeTabId = null;
    return payloads;
  }

  private require(tabId: string): TabEntry<T> {
    const entry = this.entries.find((candidate) => candidate.tabId === tabId);
    if (!entry) throw new Error(`No such tab: ${tabId}`);
    return entry;
  }
}
