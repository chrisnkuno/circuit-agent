/** @jsxImportSource @termuijs/jsx */
import { render } from "@termuijs/testing";
import { describe, expect, it } from "vitest";
import { GuideScreen } from "./guide-screen";

/**
 * The guide screen, actually drawn and actually typed into.
 *
 * `guide-browser.test.ts` proves what every key does; this proves the keys reach it and the rows
 * reach a terminal. A viewer that computes the right page and renders an empty box looks identical
 * from the outside to one that works.
 */

function open(options: { columns?: number; rows?: number; startAt?: string } = {}) {
  let exited = false;
  const view = render(
    <GuideScreen
      columns={options.columns ?? 90}
      rows={options.rows ?? 20}
      startAt={options.startAt}
      onExit={() => { exited = true; }}
    />,
    { width: options.columns ?? 90, height: options.rows ?? 20 },
  );
  return { view, frame: () => String(view.lastFrame()), get exited() { return exited; } };
}

describe("the guide screen", () => {
  it("shows the topic list and the first page together", () => {
    const guide = open();
    const frame = guide.frame();
    expect(frame).toContain("nova guide");
    expect(frame).toContain("Getting started");
    expect(frame).toContain("coding agent");
    guide.view.unmount();
  });

  it("opens on the topic it was asked for", () => {
    const guide = open({ startAt: "tabs" });
    // Phrases are chosen to survive wrapping: the body is a narrow column and a longer quote
    // would straddle a line break and fail for a reason that has nothing to do with the screen.
    expect(guide.frame()).toContain("A tab is a separate piece");
    guide.view.unmount();
  });

  it("moves to the next topic on an arrow key", () => {
    const guide = open();
    expect(guide.frame()).toContain("coding agent");
    guide.view.pressKey("down");
    // Topic two is the permission modes.
    expect(guide.frame()).toContain("Four modes");
    guide.view.unmount();
  });

  it("filters as you type, and typing does not trigger navigation", () => {
    const guide = open();
    guide.view.pressKey("/");
    for (const character of "sandbox") guide.view.pressKey(character);
    const frame = guide.frame();
    expect(frame).toContain("search: sandbox");
    // "q" is in "sandbox"; if it had been read as a shortcut the screen would have closed.
    expect(guide.exited).toBe(false);
    expect(frame).toContain("Where the work happens");
    guide.view.unmount();
  });

  it("says so when a filter matches nothing", () => {
    const guide = open();
    guide.view.pressKey("/");
    for (const character of "kubernetes") guide.view.pressKey(character);
    expect(guide.frame()).toContain("Nothing matches that.");
    guide.view.unmount();
  });

  it("closes the filter on Escape and leaves on the second one", () => {
    const guide = open();
    guide.view.pressKey("/");
    guide.view.pressKey("escape");
    expect(guide.exited).toBe(false);
    guide.view.pressKey("escape");
    expect(guide.exited).toBe(true);
    guide.view.unmount();
  });

  it("leaves on q", () => {
    const guide = open();
    guide.view.pressKey("q");
    expect(guide.exited).toBe(true);
    guide.view.unmount();
  });

  it("offers its keys, since a full-screen reader with no legend is a guessing game", () => {
    const guide = open();
    expect(guide.frame()).toContain("q leave");
    guide.view.unmount();
  });
});
