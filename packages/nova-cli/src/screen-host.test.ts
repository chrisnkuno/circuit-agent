import { describe, expect, it, vi } from "vitest";
import {
  MINIMUM_SCREEN,
  canDrawScreen,
  explainScreenRefusal,
  withFullScreen,
  type TerminalControls,
} from "./screen-host";

/**
 * Handing the terminal over and getting it back.
 *
 * The failure this guards against is the worst kind a CLI has: a screen that throws on the way up
 * and leaves readline paused, shortcuts uninstalled and the cursor in an alternate buffer — a
 * session that looks hung and cannot be typed into. Every path through here must restore.
 */

function controls(): TerminalControls & { calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => void calls.push(name);
  return {
    calls,
    clearStatus: record("clearStatus"),
    releaseScreen: record("releaseScreen"),
    uninstallShortcuts: record("uninstallShortcuts"),
    installShortcuts: record("installShortcuts"),
    pauseInput: record("pauseInput"),
    resumeInput: record("resumeInput"),
    restoreScreen: record("restoreScreen"),
  };
}

const big = { interactive: true, columns: 100, rows: 30 };

describe("whether a screen can be drawn", () => {
  it("refuses without a terminal, before loading anything", () => {
    expect(canDrawScreen({ ...big, interactive: false })).toMatchObject({ ok: false, reason: "not-interactive" });
  });

  it("refuses a window too small to hold its own chrome, and says how small it is", () => {
    const outcome = canDrawScreen({ interactive: true, columns: 20, rows: 4 });
    expect(outcome).toMatchObject({ ok: false, reason: "too-small" });
    expect(outcome.ok === false && outcome.detail).toContain("20×4");
  });

  it("allows a terminal at exactly the minimum", () => {
    expect(canDrawScreen({ interactive: true, ...MINIMUM_SCREEN })).toEqual({ ok: true });
  });
});

describe("what the user is told", () => {
  it("says what to do about it rather than naming an internal state", () => {
    expect(explainScreenRefusal({ ok: false, reason: "not-interactive" })).toContain("interactive terminal");
    expect(explainScreenRefusal({ ok: false, reason: "too-small", detail: "needs 40×8" })).toContain("bigger window");
    expect(explainScreenRefusal({ ok: false, reason: "framework-missing", detail: "boom" })).toContain("boom");
  });
});

describe("taking the terminal and giving it back", () => {
  it("takes it in order, and restores it in order", async () => {
    const terminal = controls();
    const outcome = await withFullScreen(big, terminal, async () => {});
    expect(outcome).toEqual({ ok: true });
    expect(terminal.calls).toEqual([
      "clearStatus", "releaseScreen", "uninstallShortcuts", "pauseInput",
      "resumeInput", "installShortcuts", "restoreScreen",
    ]);
  });

  it("restores everything when the screen throws on the way up", async () => {
    const terminal = controls();
    const outcome = await withFullScreen(big, terminal, async () => { throw new Error("no framework"); });
    expect(outcome).toMatchObject({ ok: false, reason: "framework-missing", detail: "no framework" });
    // The three restore steps ran regardless — this is the difference between a fallback and a
    // session nobody can type into.
    expect(terminal.calls.slice(-3)).toEqual(["resumeInput", "installShortcuts", "restoreScreen"]);
  });

  it("reinstalls the shortcuts rather than assuming they survived", async () => {
    const terminal = controls();
    await withFullScreen(big, terminal, async () => {});
    expect(terminal.calls.filter((call) => call === "installShortcuts")).toHaveLength(1);
    expect(terminal.calls.indexOf("installShortcuts")).toBeGreaterThan(terminal.calls.indexOf("uninstallShortcuts"));
  });

  it("does not touch the terminal at all when a screen was never possible", async () => {
    const terminal = controls();
    const open = vi.fn();
    const outcome = await withFullScreen({ ...big, interactive: false }, terminal, open);
    expect(outcome).toMatchObject({ ok: false, reason: "not-interactive" });
    expect(open).not.toHaveBeenCalled();
    expect(terminal.calls).toEqual([]);
  });

  it("loads the framework inside the guarded section, so a bad import still restores", async () => {
    const terminal = controls();
    await withFullScreen(big, terminal, async () => {
      await import("./no-such-module-anywhere" as string).catch((error) => { throw error; });
    });
    expect(terminal.calls).toContain("resumeInput");
    expect(terminal.calls).toContain("restoreScreen");
  });
});
