/** @jsxImportSource @termuijs/jsx */
import { render } from "@termuijs/testing";
import { describe, expect, it } from "vitest";
import { NO_COLOR_PALETTE } from "./theme";
import { Workspace } from "./workspace-screen";
import type { WorkspacePane, WorkspaceSnapshot } from "./workspace-model";

/**
 * The panel, actually drawn.
 *
 * `workspace-model.test.ts` proves every decision the panel makes; what it cannot prove is that the
 * decisions reach a screen. A component that computes the right pane and renders an empty box looks
 * identical to a correct one from the outside, which is precisely the gap TermUI's in-memory
 * renderer exists to close.
 */

const pane = (overrides: Partial<WorkspacePane> = {}): WorkspacePane => ({
  kind: "tab",
  key: "1",
  title: "nova",
  subtitle: "claude-sonnet-5",
  status: "idle",
  lines: ["first line", "second line"],
  dropped: 0,
  ...overrides,
});

const snapshot = (overrides: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  panes: [pane()],
  selected: 0,
  scroll: 0,
  palette: NO_COLOR_PALETTE,
  columns: 60,
  rows: 12,
  ...overrides,
});

function open(initial: WorkspaceSnapshot) {
  let current = initial;
  let exited = false;
  const view = render(
    <Workspace read={() => current} onExit={() => { exited = true; }} refreshMs={10_000} />,
    { width: initial.columns, height: initial.rows },
  );
  return {
    view,
    frame: () => String(view.lastFrame()),
    set: (next: WorkspaceSnapshot) => { current = next; },
    get exited() { return exited; },
  };
}

describe("the workspace, rendered", () => {
  it("shows the selected pane's content", () => {
    const panel = open(snapshot());
    expect(panel.frame()).toContain("second line");
    panel.view.unmount();
  });

  it("names every pane in the bar, numbered the way the number keys select them", () => {
    const panel = open(snapshot({
      panes: [pane({ key: "1", title: "nova" }), pane({ key: "2", title: "sandbox" })],
    }));
    const frame = panel.frame();
    expect(frame).toContain("1 nova");
    expect(frame).toContain("2 sandbox");
    panel.view.unmount();
  });

  it("says what the pane is running and where, which is why a panel beats a list", () => {
    const panel = open(snapshot({
      panes: [pane({ subtitle: "gpt-5.6 · e2b · $0.10" })],
    }));
    expect(panel.frame()).toContain("gpt-5.6");
    expect(panel.frame()).toContain("e2b");
    panel.view.unmount();
  });

  it("offers the keys, since a full-screen view with no legend is a guessing game", () => {
    const panel = open(snapshot());
    expect(panel.frame()).toContain("q leave");
    panel.view.unmount();
  });

  it("leaves when asked, rather than trapping the session in a screen", () => {
    const panel = open(snapshot());
    panel.view.pressKey("q");
    expect(panel.exited).toBe(true);
    panel.view.unmount();
  });

  it("draws a pane with nothing in it instead of failing on an empty session", () => {
    const panel = open(snapshot({ panes: [] }));
    expect(panel.frame()).toContain("no panes");
    panel.view.unmount();
  });
});
