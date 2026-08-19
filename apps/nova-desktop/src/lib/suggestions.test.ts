import { describe, expect, it } from "vitest";
import { initialChatState, type ActivityEntry, type ChatState } from "./chat-state";
import {
  changedFileCount,
  composerSuggestions,
  desktopSignals,
  recoverySuggestions,
  starters,
  type DesktopSessionState,
} from "./suggestions";

function state(overrides: Partial<DesktopSessionState> = {}, chat: Partial<ChatState> = {}): DesktopSessionState {
  return {
    chat: { ...initialChatState(), ...chat },
    root: "/work/api",
    mode: "build",
    tabs: 1,
    sandbox: false,
    openTodos: 0,
    providerConfigured: true,
    busy: false,
    taken: [],
    ...overrides,
  };
}

const wrote = (id: string, summary: string, status: ActivityEntry["status"] = "ok"): ActivityEntry => ({
  id,
  name: "write_file",
  summary,
  status,
});

describe("what the window tells the rules", () => {
  it("counts changed files from the work that actually landed", () => {
    expect(changedFileCount([wrote("1", "src/a.ts"), wrote("2", "src/b.ts")])).toBe(2);
    // Twice to the same file is one changed file, not two.
    expect(changedFileCount([wrote("1", "src/a.ts"), wrote("2", "src/a.ts")])).toBe(1);
  });

  it("does not count an edit that failed", () => {
    // A failed edit changed nothing, and offering to review it would send the reader to an empty diff.
    expect(changedFileCount([wrote("1", "src/a.ts", "failed")])).toBe(0);
  });

  it("does not count reading as changing", () => {
    expect(changedFileCount([{ id: "1", name: "read_file", summary: "src/a.ts", status: "ok" }])).toBe(0);
  });

  it("reports no project when none is open, which the CLI can never be", () => {
    expect(desktopSignals(state({ root: null })).projectOpen).toBe(false);
    expect(desktopSignals(state()).projectOpen).toBe(true);
  });

  it("takes the turn count from the turns that ended, not from the messages on screen", () => {
    const chat = { turns: 2, messages: [{ id: "a", role: "user" as const, content: "hi" }] };
    expect(desktopSignals(state({}, chat)).turns).toBe(2);
  });
});

describe("the suggestions under the composer", () => {
  it("offers a review once the agent has changed something", () => {
    const suggestions = composerSuggestions(state({}, { turns: 1, activity: [wrote("1", "src/a.ts")] }));
    expect(suggestions.map((suggestion) => suggestion.action)).toContainEqual({ kind: "ui", id: "open-diff" });
  });

  it("says nothing while a turn is running", () => {
    // The useful next step then is to watch; a live row offering to undo work still being done is
    // worse than an empty strip.
    expect(composerSuggestions(state({ busy: true }, { turns: 1, activity: [wrote("1", "src/a.ts")] }))).toEqual([]);
  });

  it("sends someone with no project to open one, and says nothing else", () => {
    const suggestions = composerSuggestions(state({ root: null }));
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].action).toEqual({ kind: "ui", id: "open-project" });
  });

  it("sends someone with no key to settings before anything else", () => {
    const suggestions = composerSuggestions(state({ providerConfigured: false }, { turns: 3 }));
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].action).toEqual({ kind: "ui", id: "open-settings" });
  });

  it("stops offering what has already been taken", () => {
    const busy = state({}, { turns: 1, activity: [wrote("1", "src/a.ts")] });
    const first = composerSuggestions(busy);
    const after = composerSuggestions({ ...busy, taken: first.map((suggestion) => suggestion.id) });
    for (const suggestion of after) expect(first.map((s) => s.id)).not.toContain(suggestion.id);
  });

  it("never offers a slash command, which this window cannot run", () => {
    for (const turns of [0, 1, 3, 6]) {
      for (const suggestion of composerSuggestions(state({ tabs: 2, sandbox: true }, { turns, budgetFraction: 0.9 }), 6)) {
        expect(suggestion.action.kind).not.toBe("command");
      }
    }
  });

  it("shows at most what it was asked for", () => {
    expect(composerSuggestions(state({}, { turns: 4, activity: [wrote("1", "a")] }), 2).length).toBeLessThanOrEqual(2);
  });
});

describe("recovery", () => {
  it("is silent while nothing has failed", () => {
    expect(recoverySuggestions(state({}, { turns: 2 }))).toEqual([]);
  });

  it("names the way out of the failure that actually happened", () => {
    const authed = recoverySuggestions(state({}, { turns: 1, lastStatus: "failed", error: "401 invalid api key" }));
    expect(authed.map((suggestion) => suggestion.action)).toContainEqual({ kind: "ui", id: "open-settings" });
    const flaky = recoverySuggestions(state({}, { turns: 1, lastStatus: "failed", error: "fetch failed" }));
    expect(flaky.map((suggestion) => suggestion.action)).toContainEqual({ kind: "ui", id: "retry-turn" });
  });

  it("says nothing about failure for an error the rules do not recognise", () => {
    // A "try again" under an unrecognised error is a guess dressed as a diagnosis.
    const unknown = recoverySuggestions(state({}, { turns: 1, lastStatus: "failed", error: "the tool blew up" }));
    expect(unknown.every((suggestion) => suggestion.category !== "recovery")).toBe(true);
  });
});

describe("starters", () => {
  it("fills the composer rather than sending", () => {
    for (const starter of starters(state())) expect(starter.action.kind).toBe("prompt");
  });

  it("names the project that is open", () => {
    expect(starters(state())[0].label).toContain("api");
  });

  it("gets out of the way once the conversation has begun", () => {
    expect(starters(state({}, { turns: 1 }))).toEqual([]);
    expect(starters(state({ busy: true }))).toEqual([]);
    expect(starters(state({ root: null }))).toEqual([]);
  });
});
