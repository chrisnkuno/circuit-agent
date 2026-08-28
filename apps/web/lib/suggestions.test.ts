import { describe, expect, it } from "vitest";
import { MAX_SUGGESTIONS, suggestNext, type SuggestionState } from "./suggestions";

function state(overrides: Partial<SuggestionState> = {}): SuggestionState {
  return { hasWorkspace: true, draft: "", tasks: [], runningSandboxes: 0, ...overrides };
}

describe("suggestNext", () => {
  it("stays silent while someone is typing", () => {
    // Offering a different idea mid-sentence is the opposite of helpful.
    expect(suggestNext(state({ draft: "Build a thing" }))).toEqual([]);
    expect(suggestNext(state({ draft: "   " }))).not.toEqual([]);
  });

  it("says nothing until there is a workspace to act in", () => {
    expect(suggestNext(state({ hasWorkspace: false }))).toEqual([]);
  });

  it("offers starting points to a workspace that has never run anything", () => {
    const suggestions = suggestNext(state());
    expect(suggestions).toHaveLength(3);
    expect(suggestions.every((suggestion) => suggestion.kind === "start")).toBe(true);
    // A starter fills the composer rather than running anything on its own.
    expect(suggestions[0].prompt.length).toBeGreaterThan(0);
  });

  it("puts a stuck deliverable ahead of a finished one", () => {
    const suggestions = suggestNext(state({
      tasks: [
        { id: "a", title: "Launch status app", status: "blocked", blockedReason: "DEPLOYMENT.md is missing." },
        { id: "b", title: "Uptime summary", status: "completed" },
      ],
    }));
    expect(suggestions[0].kind).toBe("unblock");
    expect(suggestions[0].prompt).toContain("DEPLOYMENT.md is missing.");
    expect(suggestions[1].kind).toBe("inspect");
    // A chip that opens something carries what to open, rather than being matched back by label.
    expect(suggestions[1].taskId).toBe("b");
  });

  it("carries the reason into the prompt so the fix does not have to be retyped", () => {
    const [suggestion] = suggestNext(state({ tasks: [{ id: "a", title: "App", status: "blocked" }] }));
    // With no recorded reason it still offers to continue rather than offering nothing.
    expect(suggestion.kind).toBe("unblock");
    expect(suggestion.prompt).toContain("App");
  });

  it("invites a second sandbox while the first is still running", () => {
    const suggestions = suggestNext(state({ runningSandboxes: 1, tasks: [{ id: "a", title: "App", status: "running" }] }));
    expect(suggestions).toEqual([{ label: "Start another in parallel", prompt: "", kind: "continue" }]);
  });

  it("shortens a long title instead of letting it run off the chip", () => {
    const long = "Build an emergency response platform with responder dashboards";
    const [suggestion] = suggestNext(state({ tasks: [{ id: "a", title: long, status: "completed" }] }));
    expect(suggestion.label.length).toBeLessThan(long.length);
    expect(suggestion.label).toContain("…");
  });

  it("never offers more than a person can scan", () => {
    const tasks = Array.from({ length: 9 }, (_, index) => ({ id: `${index}`, title: `Task ${index}`, status: "blocked" }));
    expect(suggestNext(state({ tasks }))).toHaveLength(MAX_SUGGESTIONS);
  });
});
