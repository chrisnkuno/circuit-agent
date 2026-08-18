import { describe, expect, it } from "vitest";
import { parseTabCommand, renderTabStrip, SEQUENTIAL_TABS_NOTE, WorkspaceController } from "./tabs";

const controller = (titles: string[] = ["nova"]) => {
  const workspace = new WorkspaceController<{ name: string }>();
  for (const title of titles) workspace.open(title, () => ({ name: title }));
  return workspace;
};

describe("opening and switching", () => {
  it("brings a new tab to the front and keeps the old one", () => {
    const workspace = controller(["refactor"]);
    workspace.open("failing test", () => ({ name: "second" }));

    expect(workspace.size).toBe(2);
    expect(workspace.active.title).toBe("failing test");
    expect(workspace.find(1)?.title).toBe("refactor");
  });

  it("builds the payload lazily, so a tab that cannot be created is never opened", () => {
    const workspace = controller();
    expect(() => workspace.open("bad", () => { throw new Error("no provider configured"); })).toThrow("no provider");
    expect(workspace.size).toBe(1);
  });

  it("keeps ids stable when a tab in the middle closes", () => {
    // Renumbering would silently repoint "/tab 3" at different work between one command and the next.
    const workspace = controller(["a", "b", "c"]);
    workspace.close(2);
    expect(workspace.all.map((tab) => tab.id)).toEqual([1, 3]);
    expect(workspace.find(3)?.title).toBe("c");
  });

  it("cycles in both directions and wraps", () => {
    const workspace = controller(["a", "b", "c"]);
    workspace.activate(1);
    expect(workspace.cycle().title).toBe("b");
    expect(workspace.cycle().title).toBe("c");
    expect(workspace.cycle().title).toBe("a");
    expect(workspace.cycle(-1).title).toBe("c");
  });

  it("refuses to open more tabs than it can show", () => {
    const workspace = new WorkspaceController<number>(2);
    workspace.open("a", () => 1);
    workspace.open("b", () => 2);
    expect(() => workspace.open("c", () => 3)).toThrow("Already at 2 tabs");
  });
});

describe("closing", () => {
  it("moves to a neighbour when the active tab closes", () => {
    const workspace = controller(["a", "b", "c"]);
    workspace.activate(2);
    expect(workspace.close(2).nextActive.title).toBe("c");
  });

  it("falls back to the previous tab when the last one closes", () => {
    const workspace = controller(["a", "b"]);
    workspace.activate(2);
    expect(workspace.close(2).nextActive.title).toBe("a");
  });

  it("refuses to close the only tab", () => {
    // An empty workspace has no prompt to return to, and this almost always means "quit".
    expect(() => controller().close(1)).toThrow("last tab");
  });

  it("refuses to close a tab that is still working", () => {
    // Closing a running tab would orphan a turn that is still spending money.
    const workspace = controller(["a", "b"]);
    workspace.started(1);
    expect(() => workspace.close(1)).toThrow("still working");
  });

  it("reports a tab that does not exist", () => {
    expect(() => controller(["a", "b"]).close(9)).toThrow("No tab 9");
  });

  it("hands back the payload so the caller can dispose of it", () => {
    const workspace = controller(["a", "b"]);
    expect(workspace.close(1).closed.payload).toEqual({ name: "a" });
  });
});

describe("unread work", () => {
  it("counts turns that finished while you were looking elsewhere", () => {
    const workspace = controller(["a", "b"]);
    workspace.activate(2);
    workspace.finished(1, "idle");
    workspace.finished(1, "idle");

    expect(workspace.find(1)?.unread).toBe(2);
    // Nothing accrues on the tab being watched — the marker means "something moved while you were away".
    workspace.finished(2, "idle");
    expect(workspace.find(2)?.unread).toBe(0);
  });

  it("clears the marker on the way back in", () => {
    const workspace = controller(["a", "b"]);
    workspace.activate(2);
    workspace.finished(1, "idle");
    expect(workspace.activate(1)?.unread).toBe(0);
  });

  it("remembers that a tab failed", () => {
    const workspace = controller(["a", "b"]);
    workspace.activate(2);
    workspace.finished(1, "failed");
    expect(workspace.views().find((view) => view.id === 1)).toMatchObject({ status: "failed", unread: 1 });
  });
});

describe("the strip", () => {
  it("stays out of the way until there is more than one tab", () => {
    expect(renderTabStrip(controller().views())).toBe("");
  });

  it("marks the active tab, running work and unread turns", () => {
    const workspace = controller(["refactor", "tests", "docs"]);
    workspace.activate(1);
    workspace.started(2);
    workspace.finished(3, "idle");

    const strip = renderTabStrip(workspace.views());
    expect(strip).toContain("[1 refactor]");
    expect(strip).toContain("2●tests");
    expect(strip).toContain("3•docs");
  });

  it("truncates rather than wrapping onto a second row", () => {
    const workspace = controller(["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"]);
    expect(renderTabStrip(workspace.views(), { width: 20 })).toHaveLength(20);
  });
});

describe("parsing", () => {
  it("reads every form", () => {
    expect(parseTabCommand("/tab")).toEqual({ kind: "list" });
    expect(parseTabCommand("/tabs")).toEqual({ kind: "list" });
    expect(parseTabCommand("/tab new")).toEqual({ kind: "new" });
    expect(parseTabCommand("/tab new  fix   the   build ")).toEqual({ kind: "new", title: "fix the build" });
    expect(parseTabCommand("/tab next")).toEqual({ kind: "next" });
    expect(parseTabCommand("/tab prev")).toEqual({ kind: "previous" });
    expect(parseTabCommand("/tab close")).toEqual({ kind: "close" });
    expect(parseTabCommand("/tab close 3")).toEqual({ kind: "close", id: 3 });
    expect(parseTabCommand("/tab 2")).toEqual({ kind: "select", id: 2 });
    expect(parseTabCommand("/tab rename api work")).toEqual({ kind: "rename", title: "api work" });
  });

  it("explains what it did not understand", () => {
    expect(parseTabCommand("/tab sideways")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("sideways") });
    expect(parseTabCommand("/tab close x")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("not a tab number") });
    expect(parseTabCommand("/tab rename")).toMatchObject({ kind: "invalid" });
  });

  it("is not a tab command", () => {
    expect(parseTabCommand("/table")).toBeNull();
    expect(parseTabCommand("/diff")).toBeNull();
  });
});

/**
 * The sequential limit, stated where people meet it.
 *
 * This is a wording test, which is unusual — but the wording is the feature here. The controller
 * has always been sequential and has always said so in its own comments; what was missing was
 * anywhere a *user* would encounter it, and the desktop window's tabs being genuinely parallel makes
 * an ambiguous sentence in the terminal into a wrong one.
 */
describe("saying that only the front tab runs", () => {
  it("names the alternative rather than only stating the limit", () => {
    // "Tabs are sequential" leaves someone holding a problem. Naming /detach hands them the answer.
    expect(SEQUENTIAL_TABS_NOTE).toMatch(/only the tab in front runs/);
    expect(SEQUENTIAL_TABS_NOTE).toContain("/detach");
  });

  it("stays one line, since it is printed into a transcript beside real output", () => {
    expect(SEQUENTIAL_TABS_NOTE).not.toContain("\n");
    expect(SEQUENTIAL_TABS_NOTE.length).toBeLessThanOrEqual(120);
  });

  it("is what the controller actually does: switching away leaves the other tab exactly as it was", () => {
    const tabs = new WorkspaceController<{ turns: number }>();
    const first = tabs.adopt("one", { turns: 0 });
    const second = tabs.open("two", () => ({ turns: 0 }));
    // A "turn" in the front tab; the background tab is untouched, which is the whole claim.
    tabs.active.payload.turns += 1;
    expect(second.payload.turns).toBe(1);
    expect(first.payload.turns).toBe(0);
  });
});

