import { describe, expect, it } from "vitest";
import { TabRegistry } from "./tabs.js";

/**
 * The invariants here are all about *addressing*, because that is what parallel tabs turn into a
 * question. With one session there was nothing to get wrong; with several, every event carries an
 * implicit "which of these does this belong to", and a wrong answer is silent — the wrong transcript
 * grows, and nothing throws.
 */

type Slot = { label: string; disposed?: boolean };

const slot = (label: string): Slot => ({ label });

describe("addressing a tab", () => {
  it("hands back a stable id that does not move when other tabs come and go", () => {
    const tabs = new TabRegistry<Slot>();
    const first = tabs.add("session-a", slot("a"));
    const second = tabs.add("session-b", slot("b"));
    tabs.close(first.tabId);
    const third = tabs.add("session-c", slot("c"));
    // Closing the first tab must not renumber the second into its place, or every id the window is
    // holding starts pointing at a different tab than it did a moment ago.
    expect(tabs.resolve(second.tabId).payload.label).toBe("b");
    expect(third.tabId).not.toBe(first.tabId);
  });

  it("treats a request with no tab id as meaning the tab in front", () => {
    // This is what keeps every existing single-tab call working untouched: "no tab named" meant
    // "the only tab" before, and means "the active tab" now, which is the same tab.
    const tabs = new TabRegistry<Slot>();
    tabs.add("session-a", slot("a"));
    const second = tabs.add("session-b", slot("b"));
    expect(tabs.resolve().payload.label).toBe("b");
    expect(tabs.activeId).toBe(second.tabId);
  });

  it("says something a person can act on when there is no session at all", () => {
    expect(() => new TabRegistry<Slot>().resolve()).toThrow(/Open a project session first/);
    expect(() => new TabRegistry<Slot>().resolve("tab_9")).toThrow(/No such tab/);
  });

  it("keeps the tab when the session inside it is rebuilt", () => {
    // Opening a different folder, switching mode and resuming an old transcript all build a fresh
    // agent with a fresh session id. A window addressing tabs by session id would lose the tab each
    // time — this is the case that makes the tab id worth having at all.
    const tabs = new TabRegistry<Slot>();
    const tab = tabs.add("session-a", slot("a"));
    const previous = tabs.replace(tab.tabId, "session-a2", slot("a2"));
    expect(previous.label).toBe("a");
    expect(tabs.resolve(tab.tabId).payload.label).toBe("a2");
    expect(tabs.resolve(tab.tabId).sessionId).toBe("session-a2");
    expect(tabs.size).toBe(1);
  });

  it("translates a session id back to its tab, which is how an event finds its transcript", () => {
    const tabs = new TabRegistry<Slot>();
    const first = tabs.add("session-a", slot("a"));
    const second = tabs.add("session-b", slot("b"));
    expect(tabs.bySession("session-a")?.tabId).toBe(first.tabId);
    expect(tabs.bySession("session-b")?.tabId).toBe(second.tabId);
    // A rebuilt tab answers to its new session, and no longer to the old one — an event arriving
    // late from a replaced session must not be filed into the tab that replaced it.
    tabs.replace(first.tabId, "session-a2", slot("a2"));
    expect(tabs.bySession("session-a")).toBeUndefined();
    expect(tabs.bySession("session-a2")?.tabId).toBe(first.tabId);
  });

  it("has no tab for a session that has been closed, rather than guessing one", () => {
    const tabs = new TabRegistry<Slot>();
    const only = tabs.add("session-a", slot("a"));
    tabs.close(only.tabId);
    expect(tabs.bySession("session-a")).toBeUndefined();
  });
});

describe("closing a tab", () => {
  it("gives back what was inside, because a session nobody disposes of never ends", () => {
    const tabs = new TabRegistry<Slot>();
    const tab = tabs.add("session-a", slot("a"));
    expect(tabs.close(tab.tabId).payload.label).toBe("a");
    expect(tabs.size).toBe(0);
  });

  it("moves to the neighbour rather than back to the first tab", () => {
    // Closing three tabs in a row should walk along the strip, not throw the reader back to the
    // beginning of their list each time.
    const tabs = new TabRegistry<Slot>();
    const first = tabs.add("s1", slot("1"));
    const second = tabs.add("s2", slot("2"));
    const third = tabs.add("s3", slot("3"));
    tabs.activate(second.tabId);
    expect(tabs.close(second.tabId).nextActive).toBe(third.tabId);
    // Closing the last one falls back to its left-hand neighbour, there being nothing to the right.
    expect(tabs.close(third.tabId).nextActive).toBe(first.tabId);
  });

  it("leaves the front tab alone when a background tab closes", () => {
    const tabs = new TabRegistry<Slot>();
    const first = tabs.add("s1", slot("1"));
    const second = tabs.add("s2", slot("2"));
    tabs.activate(second.tabId);
    expect(tabs.close(first.tabId).nextActive).toBe(second.tabId);
  });

  it("reports no active tab once the last one is gone", () => {
    const tabs = new TabRegistry<Slot>();
    const only = tabs.add("s1", slot("1"));
    expect(tabs.close(only.tabId).nextActive).toBeNull();
    expect(() => tabs.resolve()).toThrow(/Open a project session first/);
  });
});

describe("limits and shutdown", () => {
  it("refuses to open past the cap, naming the way out", () => {
    const tabs = new TabRegistry<Slot>(2);
    tabs.add("s1", slot("1"));
    tabs.add("s2", slot("2"));
    // Each tab is a live agent with a workspace and possibly a paid remote sandbox behind it, so
    // this cap is about real resources rather than tidiness.
    expect(() => tabs.add("s3", slot("3"))).toThrow(/close one/i);
    expect(tabs.size).toBe(2);
  });

  it("returns every payload on shutdown, so nothing is left running", () => {
    const tabs = new TabRegistry<Slot>();
    tabs.add("s1", slot("1"));
    tabs.add("s2", slot("2"));
    expect(tabs.drain().map((payload) => payload.label)).toEqual(["1", "2"]);
    expect(tabs.size).toBe(0);
    expect(tabs.activeId).toBeNull();
  });
});
