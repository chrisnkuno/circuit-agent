import { describe, expect, it } from "vitest";
import {
  activateTab,
  addTab,
  applyTabEvents,
  blankTab,
  describeWork,
  initialTabsState,
  neighbourTabId,
  removeTab,
  tabAtPosition,
  updateTab,
  type TabsState,
} from "./tabs";
import type { IpcEvent } from "./settings";

/**
 * The invariant that matters most here is isolation: with two turns streaming at once, every event
 * belongs to exactly one transcript, and putting it in the wrong one is silent — no error, just an
 * answer appearing where it does not belong. Most of what follows is that property, stated from
 * several directions.
 */

let tick = 0;
const clock = () => ++tick;

function twoTabs(): TabsState {
  tick = 0;
  let state = addTab(initialTabsState(), { ...blankTab("tab_1"), title: "circuit-agent", root: "/work/circuit-agent" });
  state = addTab(state, { ...blankTab("tab_2"), title: "nova-docs", root: "/work/nova-docs" });
  return state;
}

const delta = (tabId: string, text: string): IpcEvent => ({ type: "assistant_delta", text, tabId, sessionId: `s-${tabId}` });
const status = (tabId: string, value: string, summary?: string): IpcEvent =>
  ({ type: "turn_status", status: value, tabId, sessionId: `s-${tabId}`, ...(summary ? { summary } : {}) }) as IpcEvent;
const approval = (tabId: string): IpcEvent => ({
  type: "approval_needed",
  tabId,
  sessionId: `s-${tabId}`,
  requestId: `req-${tabId}`,
  toolCallId: "call-1",
  toolName: "run_command",
  summary: "rm -rf build",
  actionDigest: "digest",
  scopeKey: "scope",
});

describe("routing events to the tab that produced them", () => {
  it("keeps two streaming answers in two transcripts", () => {
    // The whole point of parallel tabs: this is the case that was impossible before, and the case
    // where a routing bug does its damage invisibly.
    const state = applyTabEvents(twoTabs(), [
      delta("tab_1", "Refactoring "),
      delta("tab_2", "Reading "),
      delta("tab_1", "the ledger"),
      delta("tab_2", "the docs"),
    ], clock);
    expect(state.tabs[0].chat.messages[0].content).toBe("Refactoring the ledger");
    expect(state.tabs[1].chat.messages[0].content).toBe("Reading the docs");
  });

  it("routes on the tab the sidecar stamped, not on which tab is in front", () => {
    const state = applyTabEvents(twoTabs(), [delta("tab_1", "background work")], clock);
    // tab_2 is the active one; the event belongs to tab_1 and must land there regardless.
    expect(state.activeTabId).toBe("tab_2");
    expect(state.tabs[0].chat.messages[0].content).toBe("background work");
    expect(state.tabs[1].chat.messages).toHaveLength(0);
  });

  it("drops an event it cannot attribute rather than filing it under the active tab", () => {
    // An untagged event, or one from a session already closed, has no home. Putting it in the front
    // tab would corrupt a transcript the user is reading, which is worse than losing a token from a
    // session nobody is watching.
    const state = applyTabEvents(twoTabs(), [
      { type: "assistant_delta", text: "orphan" } as IpcEvent,
      delta("tab_9", "from a closed tab"),
    ], clock);
    expect(state.tabs.every((tab) => tab.chat.messages.length === 0)).toBe(true);
  });

  it("returns the same state when a batch has nothing for any open tab", () => {
    const before = twoTabs();
    expect(applyTabEvents(before, [{ type: "ready" } as IpcEvent], clock)).toBe(before);
  });

  it("preserves each transcript's own sequencing when two tabs' events interleave", () => {
    // `applyChatEvents` settles a streamed answer in place at end of turn. Interleaving must not
    // break that: tab_1's turn ends while tab_2 is still streaming.
    const state = applyTabEvents(twoTabs(), [
      delta("tab_1", "first answer"),
      delta("tab_2", "second "),
      status("tab_1", "completed"),
      delta("tab_2", "answer"),
    ], clock);
    expect(state.tabs[0].chat.streaming).toBe("");
    expect(state.tabs[0].chat.messages[0].content).toBe("first answer");
    expect(state.tabs[1].chat.streaming).toBe("second answer");
  });
});

describe("what a background tab tells you", () => {
  it("counts finished turns while you are elsewhere, not tokens", () => {
    // A per-delta count would tick hundreds of times for one answer and say nothing.
    const state = applyTabEvents(twoTabs(), [
      delta("tab_1", "hello"), delta("tab_1", " there"), status("tab_1", "completed"),
    ], clock);
    expect(state.tabs[0].unread).toBe(1);
  });

  it("does not count anything against the tab you are looking at", () => {
    const state = applyTabEvents(twoTabs(), [status("tab_2", "completed")], clock);
    expect(state.tabs[1].unread).toBe(0);
  });

  it("clears the count when you switch to the tab, since that is the moment you looked", () => {
    let state = applyTabEvents(twoTabs(), [status("tab_1", "completed"), status("tab_1", "completed")], clock);
    expect(state.tabs[0].unread).toBe(2);
    state = activateTab(state, "tab_1");
    expect(state.tabs[0].unread).toBe(0);
  });

  it("shows where a tab ended up, not where its batch started", () => {
    const running = applyTabEvents(twoTabs(), [status("tab_1", "running")], clock);
    expect(running.tabs[0].status).toBe("running");
    // A whole turn in one batch settles to idle rather than sticking on "running".
    const done = applyTabEvents(twoTabs(), [status("tab_1", "running"), status("tab_1", "completed")], clock);
    expect(done.tabs[0].status).toBe("idle");
    const failed = applyTabEvents(twoTabs(), [status("tab_1", "running"), status("tab_1", "failed", "boom")], clock);
    expect(failed.tabs[0].status).toBe("failed");
  });

  it("flags a tab that is waiting on an approval, and keeps flagging it after you switch to it", () => {
    // Unread means "changed since you looked" and is answered by looking. An approval means "still
    // waiting on you", which looking does not answer — only deciding does.
    let state = applyTabEvents(twoTabs(), [approval("tab_1")], clock);
    expect(state.tabs[0].needsApproval).toBe(true);
    state = activateTab(state, "tab_1");
    expect(state.tabs[0].needsApproval).toBe(true);
  });

  it("summarises the window's work in one line, and says nothing when there is nothing to say", () => {
    expect(describeWork(twoTabs())).toBe("");
    const busy = applyTabEvents(twoTabs(), [status("tab_1", "running"), approval("tab_2")], clock);
    expect(describeWork(busy)).toBe("1 running · 1 waiting on you");
  });
});

describe("moving between tabs", () => {
  it("wraps round the strip, which is what every tabbed application has taught this key", () => {
    const state = twoTabs();
    expect(neighbourTabId(state, 1)).toBe("tab_1");
    expect(neighbourTabId(state, -1)).toBe("tab_1");
    expect(neighbourTabId(activateTab(state, "tab_1"), 1)).toBe("tab_2");
    expect(neighbourTabId(activateTab(state, "tab_1"), -1)).toBe("tab_2");
  });

  it("selects by position for the number keys, and reports nothing past the end", () => {
    const state = twoTabs();
    expect(tabAtPosition(state, 1)).toBe("tab_1");
    expect(tabAtPosition(state, 2)).toBe("tab_2");
    expect(tabAtPosition(state, 3)).toBeNull();
  });

  it("has nothing to move to in an empty window", () => {
    expect(neighbourTabId(initialTabsState(), 1)).toBeNull();
    expect(tabAtPosition(initialTabsState(), 1)).toBeNull();
  });

  it("ignores a request to activate a tab that is not there", () => {
    const state = twoTabs();
    expect(activateTab(state, "tab_9")).toBe(state);
  });
});

describe("closing a tab", () => {
  it("moves to the neighbour on the right, then to the left at the end of the strip", () => {
    let state = addTab(twoTabs(), { ...blankTab("tab_3"), title: "third" });
    state = activateTab(state, "tab_2");
    state = removeTab(state, "tab_2");
    expect(state.activeTabId).toBe("tab_3");
    state = removeTab(state, "tab_3");
    expect(state.activeTabId).toBe("tab_1");
  });

  it("leaves the front tab alone when a background tab closes", () => {
    const state = removeTab(twoTabs(), "tab_1");
    expect(state.activeTabId).toBe("tab_2");
    expect(state.tabs).toHaveLength(1);
  });

  it("reports an empty window once the last tab goes", () => {
    let state = removeTab(twoTabs(), "tab_1");
    state = removeTab(state, "tab_2");
    expect(state.tabs).toHaveLength(0);
    expect(state.activeTabId).toBeNull();
  });
});

describe("per-tab state", () => {
  it("keeps a half-typed message when you switch away and back", () => {
    // A composer shared across tabs would hand the draft for one piece of work to another, which is
    // how a message meant for the docs tab gets sent into a refactor.
    let state = updateTab(twoTabs(), "tab_2", { draft: "half a thought" });
    state = activateTab(state, "tab_1");
    expect(state.tabs[1].draft).toBe("half a thought");
    expect(state.tabs[0].draft).toBe("");
  });

  it("touches only the tab it was asked about", () => {
    const state = updateTab(twoTabs(), "tab_1", { mode: "plan" });
    expect(state.tabs[0].mode).toBe("plan");
    expect(state.tabs[1].mode).toBe("build");
  });

  it("starts a tab with its own empty transcript rather than sharing one", () => {
    const state = applyTabEvents(twoTabs(), [delta("tab_1", "only here")], clock);
    expect(state.tabs[1].chat.messages).toHaveLength(0);
    expect(state.tabs[1].chat).not.toBe(state.tabs[0].chat);
  });
});
