import { describe, expect, it } from "vitest";
import { GUIDE_TOPICS } from "./guide";
import { visibleWidth } from "./markdown";
import {
  applyGuideAction,
  bodyHeight,
  bodyWidth,
  composeGuideFrame,
  currentTopic,
  initialGuideState,
  keyToGuideAction,
  sidebarWidth,
  topicLines,
  visibleTopics,
  type GuideBrowserState,
} from "./guide-browser";

const state = (overrides: Partial<GuideBrowserState> = {}): GuideBrowserState => ({
  ...initialGuideState(100, 30),
  ...overrides,
});

describe("the layout", () => {
  it("keeps the topic list readable without letting it eat the page", () => {
    expect(sidebarWidth(100)).toBe(26);
    expect(sidebarWidth(40)).toBe(14);
    expect(sidebarWidth(400)).toBe(26);
  });

  it("leaves the body a usable measure even in a narrow window", () => {
    expect(bodyWidth(100)).toBe(71);
    expect(bodyWidth(30)).toBe(30);
  });

  it("never computes a negative body height", () => {
    expect(bodyHeight(30)).toBe(28);
    expect(bodyHeight(1)).toBe(0);
  });
});

describe("filtering", () => {
  it("shows everything when nothing is typed", () => {
    expect(visibleTopics(state())).toHaveLength(GUIDE_TOPICS.length);
  });

  it("matches the body, not only the titles — that is what people remember", () => {
    expect(visibleTopics(state({ query: "sandbox" })).map((topic) => topic.id)).toContain("where");
    expect(visibleTopics(state({ query: "SANDBOX" })).map((topic) => topic.id)).toContain("where");
  });

  it("shows nothing rather than everything when nothing matches", () => {
    expect(visibleTopics(state({ query: "kubernetes" }))).toEqual([]);
    expect(currentTopic(state({ query: "kubernetes" }))).toBeUndefined();
  });

  it("returns to the first result as the filter changes, since the old index means nothing", () => {
    const typed = applyGuideAction(state({ selected: 5 }), { kind: "type", character: "t" });
    expect(typed).toMatchObject({ selected: 0, scroll: 0, query: "t" });
    expect(applyGuideAction(typed, { kind: "backspace" })).toMatchObject({ query: "", selected: 0 });
  });
});

describe("moving around", () => {
  it("wraps in both directions", () => {
    expect(applyGuideAction(state(), { kind: "move", step: -1 }).selected).toBe(GUIDE_TOPICS.length - 1);
    const last = state({ selected: GUIDE_TOPICS.length - 1 });
    expect(applyGuideAction(last, { kind: "move", step: 1 }).selected).toBe(0);
  });

  it("starts a new topic at its beginning", () => {
    expect(applyGuideAction(state({ scroll: 12 }), { kind: "move", step: 1 }).scroll).toBe(0);
  });

  it("scrolls the body and stops at both ends", () => {
    expect(applyGuideAction(state(), { kind: "scroll", rows: -5 }).scroll).toBe(0);
    expect(applyGuideAction(state(), { kind: "scroll", rows: 9_999 }).scroll)
      .toBeLessThanOrEqual(topicLines(GUIDE_TOPICS[0], bodyWidth(100)).length);
  });

  it("does nothing when the filter has emptied the list", () => {
    const empty = state({ query: "kubernetes" });
    expect(applyGuideAction(empty, { kind: "move", step: 1 })).toBe(empty);
    expect(applyGuideAction(empty, { kind: "scroll", rows: 3 })).toBe(empty);
  });
});

describe("the keys", () => {
  it("navigates while browsing", () => {
    expect(keyToGuideAction({ name: "down" }, undefined, false)).toEqual({ kind: "move", step: 1 });
    expect(keyToGuideAction({ name: "j" }, "j", false)).toEqual({ kind: "move", step: 1 });
    // A page is the window's height less one row of overlap, worked out by the shared viewport —
    // not a fixed count that overshoots a tall terminal and undershoots a short one.
    expect(keyToGuideAction({ name: "pagedown" }, undefined, false)).toEqual({ kind: "page", step: 1 });
    expect(keyToGuideAction({}, " ", false)).toEqual({ kind: "page", step: 1 });
  });

  it("opens the filter on slash and leaves on q", () => {
    expect(keyToGuideAction({}, "/", false)).toEqual({ kind: "search" });
    expect(keyToGuideAction({ name: "q" }, "q", false)).toEqual({ kind: "exit" });
    expect(keyToGuideAction({ name: "escape" }, undefined, false)).toEqual({ kind: "exit" });
  });

  it("treats printable keys as text once the filter is open, so typing does not navigate", () => {
    // "tabs" would otherwise be four shortcuts, one of which quits.
    for (const character of ["t", "a", "b", "s", "q", "j", "/"]) {
      expect(keyToGuideAction({ name: character }, character, true)).toEqual({ kind: "type", character });
    }
  });

  it("closes the filter on Escape rather than the guide, which is what every editor does", () => {
    expect(keyToGuideAction({ name: "escape" }, undefined, true)).toEqual({ kind: "commit" });
    expect(applyGuideAction(state({ searching: true }), { kind: "commit" }).searching).toBe(false);
  });

  it("still moves the selection with the arrows while filtering", () => {
    expect(keyToGuideAction({ name: "down" }, undefined, true)).toEqual({ kind: "move", step: 1 });
  });

  it("always answers Ctrl+C", () => {
    expect(keyToGuideAction({ name: "c", ctrl: true }, undefined, true)).toEqual({ kind: "exit" });
    expect(keyToGuideAction({ name: "c", ctrl: true }, undefined, false)).toEqual({ kind: "exit" });
  });
});

describe("a topic's page", () => {
  it("opens with the title and carries the prose", () => {
    const lines = topicLines(GUIDE_TOPICS[0], 60);
    expect(lines[0]).toMatchObject({ text: GUIDE_TOPICS[0].title, bold: true });
    expect(lines.some((line) => line.text.includes("coding agent"))).toBe(true);
  });

  it("puts each example's explanation under its command, indented", () => {
    const tabs = GUIDE_TOPICS.find((topic) => topic.id === "tabs")!;
    const lines = topicLines(tabs, 60);
    const command = lines.findIndex((line) => line.text.includes("/tab new review"));
    expect(command).toBeGreaterThan(0);
    expect(lines[command + 1].text.trim()).toContain("a second tab");
    expect(lines[command + 1].dim).toBe(true);
  });

  it("wraps to the measure it is given", () => {
    for (const width of [30, 60, 90]) {
      for (const line of topicLines(GUIDE_TOPICS[2], width)) {
        expect(visibleWidth(line.text), `width ${width}: ${line.text}`).toBeLessThanOrEqual(width);
      }
    }
  });
});

describe("the frame", () => {
  it("is exactly as tall as the window", () => {
    for (const rows of [10, 30, 50]) {
      expect(composeGuideFrame(state({ rows })), `rows ${rows}`).toHaveLength(rows);
    }
  });

  it("is exactly as wide as the window, on every row", () => {
    for (const columns of [1, 8, 19, 30, 39, 40, 60, 100, 140]) {
      const frame = composeGuideFrame(state({ columns }));
      const widths = new Set(frame.map((row) => visibleWidth(row.text)));
      expect(widths.size, `columns ${columns}: ${[...widths].join(",")}`).toBe(1);
      expect([...widths][0]).toBeLessThanOrEqual(columns);
    }
  });

  it("switches to a readable single-column page when two columns cannot fit", () => {
    const frame = composeGuideFrame(state({ columns: 30 }));
    expect(frame[0].text).toContain("nova guide");
    expect(frame.some((row) => row.text.includes("│"))).toBe(false);
  });

  it("is exactly as tall even when only one or two terminal rows exist", () => {
    expect(composeGuideFrame(state({ rows: 1 }))).toHaveLength(1);
    expect(composeGuideFrame(state({ rows: 2 }))).toHaveLength(2);
  });

  it("shows the list and the page side by side", () => {
    const body = composeGuideFrame(state()).map((row) => row.text).join("\n");
    expect(body).toContain("Getting started");
    expect(body).toContain("coding agent");
    expect(body).toContain("│");
  });

  it("marks the selected topic, and only one", () => {
    const frame = composeGuideFrame(state({ selected: 2 }));
    const marked = frame.filter((row) => row.text.startsWith("›"));
    expect(marked).toHaveLength(1);
    // Clipped to the sidebar, so the assertion is on what fits rather than on the whole title.
    expect(marked[0].text).toContain(GUIDE_TOPICS[2].title.slice(0, 12));
  });

  it("keeps the selected topic on screen in a list longer than the window", () => {
    const frame = composeGuideFrame(state({ rows: 8, selected: GUIDE_TOPICS.length - 1 }));
    expect(frame.some((row) => row.text.includes(GUIDE_TOPICS[GUIDE_TOPICS.length - 1].title))).toBe(true);
  });

  it("offers the keys, and shows the filter while it is being typed", () => {
    expect(composeGuideFrame(state()).at(-1)!.text).toContain("q leave");
    expect(composeGuideFrame(state({ searching: true, query: "tab" })).at(-1)!.text).toContain("search: tab");
  });

  it("says plainly when a filter matches nothing", () => {
    expect(composeGuideFrame(state({ query: "kubernetes" })).map((row) => row.text).join("\n"))
      .toContain("Nothing matches that.");
  });

  it("shows where the page is scrolled to once the body overflows the window, and nothing when it does not", () => {
    // A tall window fits any one topic whole — no scroll position worth naming.
    expect(composeGuideFrame(state({ rows: 60 })).at(-1)!.text).not.toMatch(/Top|Bot|\d+%/);
    // A short one cannot, so the footer earns a position: Top at the start of the page.
    expect(composeGuideFrame(state({ rows: 8 })).at(-1)!.text).toContain("Top");
    // Scrolling down moves the label off Top without jumping straight to the opposite end.
    expect(composeGuideFrame(state({ rows: 8, scroll: 3 })).at(-1)!.text).not.toContain("Top");
  });
});
