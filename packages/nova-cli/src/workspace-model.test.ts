import { describe, expect, it } from "vitest";
import { NO_COLOR_PALETTE } from "./theme";
import type { TabView } from "./tabs";
import {
  WORKSPACE_LEGEND,
  PaneActivity,
  applyAction,
  composeFrame,
  atLiveEdge,
  keyToAction,
  paneHeight,
  paneTabs,
  selectedPane,
  tabPanes,
  visibleLines,
  type WorkspacePane,
  type WorkspaceSnapshot,
} from "./workspace-model";
import { visibleWidth } from "./markdown";

const pane = (key: string, lines: number, overrides: Partial<WorkspacePane> = {}): WorkspacePane => ({
  kind: "tab",
  key,
  title: `pane ${key}`,
  subtitle: "claude-sonnet-5",
  status: "idle",
  lines: Array.from({ length: lines }, (_unused, index) => `${key}:${index}`),
  dropped: 0,
  ...overrides,
});

const snapshot = (panes: WorkspacePane[], overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  panes,
  selected: 0,
  scroll: 0,
  palette: NO_COLOR_PALETTE,
  columns: 100,
  rows: 24,
  ...overrides,
});

describe("the window into a pane", () => {
  it("leaves room for the chrome, and never computes a negative height", () => {
    expect(paneHeight(24)).toBe(20);
    expect(paneHeight(4)).toBe(1);
    expect(paneHeight(0)).toBe(1);
  });

  it("shows the newest lines by default, which is where attention belongs", () => {
    expect(visibleLines(pane("a", 10), 3, 0)).toEqual(["a:7", "a:8", "a:9"]);
  });

  it("scrolls backward through history, counting from the bottom", () => {
    expect(visibleLines(pane("a", 10), 3, 2)).toEqual(["a:5", "a:6", "a:7"]);
  });

  it("stops at the beginning rather than scrolling past it into nothing", () => {
    expect(visibleLines(pane("a", 5), 3, 99)).toEqual(["a:0", "a:1", "a:2"]);
  });

  it("shows everything it has when there is less than a screenful", () => {
    expect(visibleLines(pane("a", 2), 10, 0)).toEqual(["a:0", "a:1"]);
  });

  it("knows whether it is at the live edge, which is what makes 'am I current' answerable", () => {
    expect(atLiveEdge(pane("a", 10), 3, 0)).toBe(true);
    expect(atLiveEdge(pane("a", 10), 3, 1)).toBe(false);
    // A pane shorter than the window is always live: there is nothing to scroll away from.
    expect(atLiveEdge(pane("a", 2), 10, 5)).toBe(true);
  });
});

describe("choosing a pane", () => {
  it("corrects an index out of range instead of returning nothing", () => {
    expect(selectedPane(snapshot([pane("a", 1), pane("b", 1)], { selected: 9 }))?.key).toBe("b");
    expect(selectedPane(snapshot([]))).toBeUndefined();
  });

  it("selects by number and cycles with wrapping in both directions", () => {
    const base = snapshot([pane("a", 1), pane("b", 1), pane("c", 1)]);
    expect(applyAction(base, { kind: "select", index: 2 }).selected).toBe(2);
    expect(applyAction(base, { kind: "cycle", step: -1 }).selected).toBe(2);
    expect(applyAction({ ...base, selected: 2 }, { kind: "cycle", step: 1 }).selected).toBe(0);
  });

  it("ignores a number that names no pane, rather than selecting the nearest one", () => {
    const base = snapshot([pane("a", 1)]);
    expect(applyAction(base, { kind: "select", index: 4 })).toBe(base);
  });

  it("returns to the live edge when the pane changes, since an offset means nothing elsewhere", () => {
    const base = snapshot([pane("a", 100), pane("b", 100)], { scroll: 40 });
    expect(applyAction(base, { kind: "cycle", step: 1 }).scroll).toBe(0);
    expect(applyAction(base, { kind: "select", index: 1 }).scroll).toBe(0);
  });
});

describe("scrolling", () => {
  const base = snapshot([pane("a", 100)], { rows: 24 }); // height 20 → furthest 80

  it("moves by lines and pages", () => {
    expect(applyAction(base, { kind: "scroll", lines: 1 }).scroll).toBe(1);
    expect(applyAction(base, { kind: "scroll", lines: 10 }).scroll).toBe(10);
  });

  it("cannot scroll past either end", () => {
    expect(applyAction(base, { kind: "scroll", lines: -5 }).scroll).toBe(0);
    expect(applyAction(base, { kind: "scroll", lines: 9_999 }).scroll).toBe(80);
  });

  it("jumps to the ends", () => {
    expect(applyAction(base, { kind: "top" }).scroll).toBe(80);
    expect(applyAction({ ...base, scroll: 50 }, { kind: "bottom" }).scroll).toBe(0);
  });

  it("does nothing at all with no panes", () => {
    const empty = snapshot([]);
    expect(applyAction(empty, { kind: "scroll", lines: 5 })).toBe(empty);
  });
});

describe("the keys", () => {
  it("leaves on the three things everyone tries", () => {
    expect(keyToAction({ name: "escape" })).toEqual({ kind: "exit" });
    expect(keyToAction({ name: "q" }, "q")).toEqual({ kind: "exit" });
    expect(keyToAction({ name: "c", ctrl: true })).toEqual({ kind: "exit" });
  });

  it("moves between panes with Tab and the arrows", () => {
    expect(keyToAction({ name: "tab" })).toEqual({ kind: "cycle", step: 1 });
    expect(keyToAction({ name: "tab", shift: true })).toEqual({ kind: "cycle", step: -1 });
    expect(keyToAction({ name: "right" })).toEqual({ kind: "cycle", step: 1 });
  });

  it("scrolls with the arrows and with a pager's keys, because both hands exist", () => {
    expect(keyToAction({ name: "up" })).toEqual({ kind: "scroll", lines: 1 });
    expect(keyToAction({ name: "k" }, "k")).toEqual({ kind: "scroll", lines: 1 });
    expect(keyToAction({ name: "down" })).toEqual({ kind: "scroll", lines: -1 });
    expect(keyToAction({ name: "pageup" })).toEqual({ kind: "scroll", lines: 10 });
  });

  it("takes a digit as the pane number, one-based the way the bar is labelled", () => {
    expect(keyToAction({}, "3")).toEqual({ kind: "select", index: 2 });
    // Zero is not a pane; the bar starts at 1.
    expect(keyToAction({}, "0")).toEqual({ kind: "none" });
  });

  it("jumps to the ends the way a pager does", () => {
    expect(keyToAction({}, "g")).toEqual({ kind: "top" });
    expect(keyToAction({}, "G")).toEqual({ kind: "bottom" });
  });

  it("does nothing for a key it has no meaning for", () => {
    expect(keyToAction({ name: "f7" })).toEqual({ kind: "none" });
  });
});

describe("building panes from tabs", () => {
  const views: TabView[] = [
    { id: 1, title: "nova", status: "idle", unread: 0, active: true, model: "claude-sonnet-5", backend: "local", cost: "$0.02" },
    { id: 2, title: "sandbox", status: "running", unread: 3, active: false, model: "gpt-5.6", backend: "e2b", cost: "$0.10" },
  ];

  it("says what each tab is running and where, which is the whole point of the panel", () => {
    const panes = tabPanes(views, () => ({ lines: [], dropped: 0 }));
    expect(panes[0].subtitle).toContain("claude-sonnet-5");
    expect(panes[0].subtitle).not.toContain("local"); // the default location is not worth a word
    expect(panes[1].subtitle).toContain("gpt-5.6");
    expect(panes[1].subtitle).toContain("e2b");
    expect(panes[1].subtitle).toContain("$0.10");
  });

  it("carries each tab's own recorded output", () => {
    const panes = tabPanes(views, (id) => ({ lines: [`from tab ${id}`], dropped: id }));
    expect(panes[0].lines).toEqual(["from tab 1"]);
    expect(panes[1]).toMatchObject({ lines: ["from tab 2"], dropped: 2 });
  });

  it("numbers the bar from one, and marks exactly one cell active", () => {
    const tabs = paneTabs(snapshot(tabPanes(views, () => ({ lines: [], dropped: 0 })), { selected: 1 }));
    expect(tabs.map((tab) => tab.label)).toEqual(["1 nova", "2 sandbox"]);
    expect(tabs.filter((tab) => tab.active)).toHaveLength(1);
    expect(tabs[1].active).toBe(true);
  });
});

describe("the frame", () => {
  it("is exactly as tall as the window, however much or little there is to show", () => {
    for (const rows of [8, 24, 40]) {
      const frame = composeFrame(snapshot([pane("a", 3)], { rows }));
      expect(frame, `rows ${rows}`).toHaveLength(rows);
    }
  });

  it("puts the legend on the last row and nowhere else — the bug that flex layout caused", () => {
    // A pane with far more lines than fit is the case that used to push the legend into the middle
    // of the transcript, because each section was sized on its own and then overlapped.
    const frame = composeFrame(snapshot([pane("a", 200)], { rows: 40 }));
    const legendRows = frame.map((row, index) => ({ row, index })).filter(({ row }) => row.text.includes("q leave"));
    expect(legendRows).toHaveLength(1);
    expect(legendRows[0].index).toBe(39);
    expect(frame[39].text).toContain(WORKSPACE_LEGEND);
  });

  it("shows the newest lines of the pane, ending just above the legend", () => {
    const frame = composeFrame(snapshot([pane("a", 200)], { rows: 10 }));
    // Bar, header, then paneHeight(10)=6 body rows, then padding, then the legend.
    expect(frame[2].text).toBe("a:194");
    expect(frame[7].text).toBe("a:199");
  });

  it("names the pane and what it is running, on its own row", () => {
    const frame = composeFrame(snapshot([pane("a", 1, { title: "sandbox", subtitle: "gpt-5.6 · e2b" })]));
    expect(frame[1].text).toContain("sandbox");
    expect(frame[1].text).toContain("gpt-5.6");
  });

  it("says when a pane has lost the beginning of its history", () => {
    const frame = composeFrame(snapshot([pane("a", 5, { dropped: 42 })]));
    expect(frame[1].text).toContain("42 earlier lines dropped");
  });

  it("marks that you are reading back, so the live edge is never assumed", () => {
    const scrolled = composeFrame(snapshot([pane("a", 200)], { rows: 20, scroll: 30 }));
    expect(scrolled[19].text).toContain("scrolled back");
    const live = composeFrame(snapshot([pane("a", 200)], { rows: 20, scroll: 0 }));
    expect(live[19].text).not.toContain("scrolled back");
  });

  it("names how far back, not just that it is scrolled", () => {
    // height = paneHeight(20) = 16, pane has 200 lines: plenty of room to be somewhere in the middle.
    const middle = composeFrame(snapshot([pane("a", 200)], { rows: 20, scroll: 30 }));
    expect(middle[19].text).toMatch(/\d+%/);
    // Scrolled all the way back to the oldest line the pane kept.
    const farthest = composeFrame(snapshot([pane("a", 200)], { rows: 20, scroll: 184 }));
    expect(farthest[19].text).toContain("Top");
    // At the live edge there is nothing to name — the "scrolled back" marker itself is absent.
    const live = composeFrame(snapshot([pane("a", 200)], { rows: 20, scroll: 0 }));
    expect(live[19].text).not.toMatch(/Top|Bot|\d+%/);
  });

  it("draws something rather than nothing when no pane exists", () => {
    const frame = composeFrame(snapshot([], { rows: 6 }));
    expect(frame).toHaveLength(6);
    expect(frame[1].text).toBe("nothing open");
  });

  it("survives a window too short to hold its own chrome", () => {
    const frame = composeFrame(snapshot([pane("a", 5)], { rows: 2 }));
    expect(frame).toHaveLength(2);
    expect(frame[frame.length - 1].text).toContain("q leave");
  });

  it("clips every finished row instead of letting TermUI wrap and displace the footer", () => {
    const crowded = snapshot([
      pane("a", 5, { title: "a very long pane title", subtitle: "a very long model and backend subtitle", lines: ["output ".repeat(40)] }),
      pane("b", 5, { title: "another long pane title" }),
    ], { selected: 1 });
    for (const columns of [1, 8, 19, 40, 80]) {
      const frame = composeFrame({ ...crowded, columns });
      for (const row of frame) expect(visibleWidth(row.text), `columns ${columns}: ${row.text}`).toBeLessThanOrEqual(columns);
    }
  });

  it("keeps the active pane named when the full tab strip cannot fit", () => {
    const panes = Array.from({ length: 6 }, (_unused, index) => pane(`${index}`, 1, { title: `pane-${index}-with-a-long-name` }));
    const bar = composeFrame(snapshot(panes, { selected: 4, columns: 32 }))[0].text;
    expect(bar).toContain("5 pane-4");
    expect(visibleWidth(bar)).toBeLessThanOrEqual(32);
  });
});

describe("pane activity", () => {
  const pane = (key: string, lines: number, dropped = 0) => ({ key, lines: Array.from({ length: lines }, (_, index) => `${index}`), dropped });

  it("measures the rate between frames, not the total", () => {
    const activity = new PaneActivity();
    activity.sample([pane("1", 10)]);
    activity.sample([pane("1", 14)]);
    const third = activity.sample([pane("1", 14)]);
    expect(third.get("1")).toEqual([4, 0]);
  });

  it("draws no spike for a pane it is seeing for the first time", () => {
    const activity = new PaneActivity();
    expect(activity.sample([pane("1", 500)]).get("1")).toEqual([]);
  });

  it("counts lines that fell off the log, so the busiest pane does not read as idle", () => {
    const activity = new PaneActivity();
    activity.sample([pane("1", 100, 0)]);
    // The log stayed full at 100 lines while 50 more were produced and dropped off the front.
    const next = activity.sample([pane("1", 100, 50)]);
    expect(next.get("1")).toEqual([50]);
  });

  it("forgets a pane that closed rather than carrying its history onto a new one", () => {
    const activity = new PaneActivity();
    activity.sample([pane("1", 10), pane("2", 10)]);
    activity.sample([pane("1", 20)]);
    const reopened = activity.sample([pane("1", 30), pane("2", 999)]);
    expect(reopened.get("1")).toEqual([10, 10]);
    expect(reopened.get("2")).toEqual([]);
  });

  it("keeps a bounded window of samples", () => {
    const activity = new PaneActivity(5);
    for (let frame = 0; frame <= 20; frame += 1) activity.sample([pane("1", frame)]);
    expect(activity.sample([pane("1", 21)]).get("1")).toHaveLength(5);
  });

  it("puts the waveline on the header only when there is something to show", () => {
    const base = {
      panes: [{ kind: "tab" as const, key: "1", title: "main", subtitle: "opus", status: "running" as const, lines: ["a"], dropped: 0 }],
      selected: 0, scroll: 0, palette: NO_COLOR_PALETTE, columns: 100, rows: 12,
    };
    const quiet = composeFrame(base);
    const busy = composeFrame({ ...base, panes: [{ ...base.panes[0], activity: [0, 4, 9, 2, 0, 7] }] });

    expect(quiet[1].text).not.toMatch(/[╱╲▁▔─]/);
    expect(busy[1].text).toMatch(/[╱╲▁▔─]/);
    // The header is still one row and still clipped to the terminal.
    expect(busy[1].text.length).toBeLessThanOrEqual(100);
  });

  it("leaves the waveline off a terminal too narrow to hold both it and the title", () => {
    const narrow = composeFrame({
      panes: [{ kind: "tab", key: "1", title: "a rather long pane title here", subtitle: "claude-opus-5 · sandbox", status: "running", lines: ["a"], dropped: 0, activity: [1, 2, 3, 4] }],
      selected: 0, scroll: 0, palette: NO_COLOR_PALETTE, columns: 56, rows: 12,
    });
    expect(narrow[1].text).not.toMatch(/[╱╲]/);
  });
});
