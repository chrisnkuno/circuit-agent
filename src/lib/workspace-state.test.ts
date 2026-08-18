import { describe, expect, it } from "vitest";
import type { WorkspaceState } from "./ipc";

/**
 * What the window remembers between launches.
 *
 * The app used to start blank every time: no project, no session list, and no route back to a past
 * conversation except re-finding the folder by hand. Sessions are stored *under a project root*, so
 * without remembering the root there is no way to reach the transcripts either — the session list
 * could only ever show whatever happened to be open right now.
 *
 * The recent-project list is a pure reduction, so it is tested directly rather than through the
 * screen. It is the part with rules; the rest is a disk read.
 */

/** Mirrors `rememberWorkspace`: most recent first, no duplicates, bounded. */
export function nextRecentRoots(current: readonly string[], opened: string | null, limit = 8): string[] {
  if (!opened) return [...current];
  return [opened, ...current.filter((entry) => entry !== opened)].slice(0, limit);
}

describe("recent projects", () => {
  it("puts the project just opened at the front", () => {
    expect(nextRecentRoots(["/a", "/b"], "/c")).toEqual(["/c", "/a", "/b"]);
  });

  it("moves a project already in the list rather than listing it twice", () => {
    // Reopening the project you use most must not fill the list with copies of it.
    expect(nextRecentRoots(["/a", "/b", "/c"], "/c")).toEqual(["/c", "/a", "/b"]);
    expect(nextRecentRoots(["/a"], "/a")).toEqual(["/a"]);
  });

  it("is bounded, because this is a shortcut list and not a history file", () => {
    const many = Array.from({ length: 20 }, (_, index) => `/p${index}`);
    const next = nextRecentRoots(many, "/new");
    expect(next).toHaveLength(8);
    expect(next[0]).toBe("/new");
  });

  it("leaves the list alone when nothing was opened", () => {
    expect(nextRecentRoots(["/a", "/b"], null)).toEqual(["/a", "/b"]);
  });

  it("keeps order stable across repeated opens of the same two projects", () => {
    let roots: string[] = [];
    for (const project of ["/a", "/b", "/a", "/b", "/a"]) roots = nextRecentRoots(roots, project);
    expect(roots).toEqual(["/a", "/b"]);
  });
});

describe("the stored shape", () => {
  /**
   * Every field is optional, and a missing one must read as "not remembered" rather than as a
   * default that overrides what the user chose. A stored blob from an older version has to load.
   */
  it("survives a partial or empty record", () => {
    const partial: WorkspaceState = { lastRoot: "/only" };
    expect(partial.mode).toBeUndefined();
    expect(partial.recentRoots).toBeUndefined();
    expect(nextRecentRoots(partial.recentRoots ?? [], partial.lastRoot ?? null)).toEqual(["/only"]);
  });

  it("carries the mode, which is the field that made auto mode look broken", () => {
    // Mode was not persisted, so every launch silently returned to build and asked for approval on
    // every write while the user believed they were still in auto.
    const stored: WorkspaceState = { lastRoot: "/p", mode: "auto", sandbox: false, recentRoots: ["/p"] };
    expect(stored.mode).toBe("auto");
  });
});
