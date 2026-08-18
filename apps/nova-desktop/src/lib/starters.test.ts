import { describe, expect, it } from "vitest";
import { STARTERS, projectName, shouldShowStarters } from "./starters";

describe("the empty transcript", () => {
  it("offers starters once a project is open and nothing has been asked", () => {
    // One message is the "Opened …" line the session posts about itself.
    expect(shouldShowStarters({ root: "/work/api", messageCount: 1, busy: false })).toBe(true);
    expect(shouldShowStarters({ root: "/work/api", messageCount: 0, busy: false })).toBe(true);
  });

  it("gets out of the way once there is a conversation", () => {
    expect(shouldShowStarters({ root: "/work/api", messageCount: 2, busy: false })).toBe(false);
  });

  it("stays away while a turn is running", () => {
    // A turn can be in flight before it has produced a message; suggesting a first thing to ask
    // while Nova is answering the first thing asked would be nonsense.
    expect(shouldShowStarters({ root: "/work/api", messageCount: 1, busy: true })).toBe(false);
  });

  it("stays away when there is no project, which has an empty state of its own", () => {
    expect(shouldShowStarters({ root: null, messageCount: 0, busy: false })).toBe(false);
  });

  it("suggests nothing that edits the project", () => {
    // The first thing a new user clicks should not propose a change before they have understood
    // that the mode decides what Nova may do without asking.
    for (const starter of STARTERS) {
      expect(starter.toLowerCase()).not.toMatch(/\b(refactor|rewrite|delete|fix|migrate|upgrade)\b/);
    }
    expect(STARTERS.length).toBeGreaterThan(0);
  });
});

describe("naming the project", () => {
  it("uses the last segment of a POSIX path", () => {
    expect(projectName("/home/chris/circuit-agent")).toBe("circuit-agent");
  });

  it("uses the last segment of a Windows path, wherever the session was opened from", () => {
    expect(projectName("C:\\work\\api")).toBe("api");
  });

  it("ignores a trailing separator rather than reporting an empty name", () => {
    expect(projectName("/work/api/")).toBe("api");
    expect(projectName("C:\\work\\api\\")).toBe("api");
  });

  it("falls back to the path itself when there is no segment to take", () => {
    expect(projectName("/")).toBe("/");
  });
});
