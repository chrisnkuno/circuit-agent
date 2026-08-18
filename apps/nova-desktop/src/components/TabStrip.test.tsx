/**
 * @vitest-environment happy-dom
 *
 * `bun test` gets its DOM from the `happydom.ts` preload in `bunfig.toml`; the repo-wide `vitest`
 * run has no such preload, so this file has to ask for one itself. Without it these tests fail with
 * `document is not defined` under the root suite — a failure about the harness, not the component,
 * and one that reads exactly like a real regression in CI.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TabStrip } from "./TabStrip";
import { blankTab, type WindowTab } from "../lib/tabs";

/**
 * `tabs.ts` proves what the state does. This proves the strip *says* it.
 *
 * The distinction matters more here than for most components, because the strip's job is not
 * switching — any list of buttons switches — it is reporting. A tab quietly running a turn in the
 * background is indistinguishable from an idle one unless this component draws the difference, so
 * "does the marker actually appear" is the behaviour worth pinning down.
 */

afterEach(cleanup);

const tab = (patch: Partial<WindowTab> & { tabId: string }): WindowTab => ({ ...blankTab(patch.tabId), ...patch });

const twoTabs: WindowTab[] = [
  tab({ tabId: "tab_1", title: "circuit-agent", root: "/work/circuit-agent" }),
  tab({ tabId: "tab_2", title: "nova-docs", root: "/work/nova-docs" }),
];

const strip = (tabs: WindowTab[], overrides: Partial<Parameters<typeof TabStrip>[0]> = {}) =>
  render(
    <TabStrip
      tabs={tabs}
      activeTabId="tab_1"
      summary=""
      busy={false}
      onSelect={() => {}}
      onClose={() => {}}
      onNew={() => {}}
      {...overrides}
    />,
  );

describe("the tab strip", () => {
  it("stays out of the way until there is something to switch between", () => {
    // One tab is not a tab strip, it is a title bar with extra steps. Anyone who never opens a
    // second one should see the window exactly as it was.
    const { container } = strip([twoTabs[0]]);
    expect(container.querySelector(".tab-strip")).toBeNull();
  });

  it("lists every open piece of work by the folder it is in", () => {
    strip(twoTabs);
    expect(screen.getByRole("tab", { name: /circuit-agent/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /nova-docs/ })).toBeTruthy();
  });

  it("says which tab is in front, in a way assistive tech can read", () => {
    strip(twoTabs);
    expect(screen.getByRole("tab", { name: /circuit-agent/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /nova-docs/ }).getAttribute("aria-selected")).toBe("false");
  });

  it("shows that a background tab is working — the thing parallelism otherwise hides", () => {
    strip([twoTabs[0], tab({ tabId: "tab_2", title: "nova-docs", status: "running" })]);
    expect(screen.getByText("running")).toBeTruthy();
  });

  it("counts what finished while you were elsewhere", () => {
    strip([twoTabs[0], tab({ tabId: "tab_2", title: "nova-docs", unread: 3 })]);
    expect(screen.getByText("3")).toBeTruthy();
  });

  it("flags a tab that is blocked on a decision, above everything else it could be saying", () => {
    // A tab with an approval parked is also a tab with unread turns and a status; "waiting" is the
    // one worth the reader's attention, because nothing moves there until they answer.
    strip([twoTabs[0], tab({ tabId: "tab_2", title: "nova-docs", needsApproval: true, unread: 2, status: "running" })]);
    expect(screen.getByText("waiting")).toBeTruthy();
    expect(screen.queryByText("running")).toBeNull();
    expect(screen.queryByText("2")).toBeNull();
  });

  it("says each state in words, not only in colour", () => {
    // Three running tabs told apart by hue alone is a strip that excludes the readers most likely
    // to have three tabs running.
    strip([twoTabs[0], tab({ tabId: "tab_2", title: "docs", status: "failed" })]);
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("selects, closes and opens through its callbacks", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const onNew = vi.fn();
    strip(twoTabs, { onSelect, onClose, onNew });
    fireEvent.click(screen.getByRole("tab", { name: /nova-docs/ }));
    expect(onSelect).toHaveBeenCalledWith("tab_2");
    fireEvent.click(screen.getByRole("button", { name: /Close nova-docs/ }));
    expect(onClose).toHaveBeenCalledWith("tab_2");
    fireEvent.click(screen.getByTitle(/New tab/));
    expect(onNew).toHaveBeenCalled();
  });

  it("teaches its own shortcut, since a strip nobody knows is clickable-only", () => {
    strip(twoTabs);
    expect(screen.getByRole("tab", { name: /circuit-agent/ }).getAttribute("title")).toContain("Ctrl 1");
    expect(screen.getByRole("tab", { name: /nova-docs/ }).getAttribute("title")).toContain("Ctrl 2");
  });

  it("summarises the window once, rather than leaving the reader to total up the badges", () => {
    strip(twoTabs, { summary: "2 running · 1 waiting on you" });
    expect(screen.getByText("2 running · 1 waiting on you")).toBeTruthy();
  });
});
