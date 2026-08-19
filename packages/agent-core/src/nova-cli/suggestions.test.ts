import { describe, expect, it } from "vitest";
import {
  askModelForSuggestions,
  CATEGORY_ORDER,
  classifyFailure,
  defaultSignals,
  mergeModelSuggestions,
  shouldOfferStarters,
  starterSuggestions,
  parseModelSuggestions,
  suggest,
  suggestionIds,
  type SessionSignals,
  type Suggestion,
  type SuggestionSurface,
} from "./suggestions";

const cli = { surface: "cli" as SuggestionSurface, limit: 6 };
const desktop = { surface: "desktop" as SuggestionSurface, limit: 6 };

/** Every situation worth asserting a property over, so an invariant is checked against a spread. */
const SITUATIONS: SessionSignals[] = [
  defaultSignals(),
  defaultSignals({ providerConfigured: false }),
  defaultSignals({ projectOpen: false }),
  defaultSignals({ turns: 1, changedFiles: 3 }),
  defaultSignals({ turns: 4, changedFiles: 1, openTodos: 2, hasSpend: true }),
  defaultSignals({ turns: 2, runningJobs: 2, tabs: 3 }),
  defaultSignals({ turns: 2, sandbox: true }),
  defaultSignals({ turns: 3, mode: "plan" }),
  defaultSignals({ turns: 3, openFindings: 4 }),
  defaultSignals({ turns: 1, lastStatus: "failed", lastError: "401 invalid api key" }),
  defaultSignals({ turns: 1, lastStatus: "failed", lastError: "fetch failed" }),
  defaultSignals({ turns: 1, lastStatus: "iteration_limit" }),
  defaultSignals({ turns: 1, lastStatus: "cancelled", changedFiles: 2 }),
  defaultSignals({ turns: 8, hasSpend: true, budgetFraction: 0.9 }),
];

describe("the suggestion engine", () => {
  it("never offers a suggestion without a reason", () => {
    // A suggestion without a reason fires a command the reader did not choose and teaches nothing
    // about when to choose it — the difference between a hint and an advertisement.
    for (const signals of SITUATIONS) {
      for (const surface of ["cli", "desktop"] as const) {
        for (const suggestion of suggest(signals, { surface, limit: 6 })) {
          expect(suggestion.reason.trim(), `${suggestion.id} on ${surface}`).not.toBe("");
          expect(suggestion.label.trim(), `${suggestion.id} on ${surface}`).not.toBe("");
        }
      }
    }
  });

  it("says the one blocking thing and nothing else when nothing can work yet", () => {
    const blocked = suggest(defaultSignals({ providerConfigured: false, changedFiles: 9, runningJobs: 3 }), cli);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].category).toBe("blocked");
    expect(blocked[0].action).toEqual({ kind: "command", command: "/settings" });
  });

  it("tells a window with no project to open one — a case the CLI cannot be in", () => {
    const signals = defaultSignals({ projectOpen: false });
    expect(suggest(signals, desktop)[0].action).toEqual({ kind: "ui", id: "open-project" });
    // The CLI always has a root, so the rule has no command and simply does not exist there.
    expect(suggest(signals, cli).map((s) => s.id)).not.toContain("open-project");
  });

  it("puts recovery ahead of routine work after a failure", () => {
    const suggestions = suggest(defaultSignals({ turns: 2, changedFiles: 2, lastStatus: "failed", lastError: "401 unauthorized" }), cli);
    expect(suggestions[0].category).toBe("recovery");
    const categories = suggestions.map((suggestion) => CATEGORY_ORDER.indexOf(suggestion.category));
    expect([...categories].sort((a, b) => a - b)).toEqual(categories);
  });

  it("names the specific way out of each kind of failure", () => {
    const ids = (signals: Partial<SessionSignals>) => suggest(defaultSignals({ turns: 1, ...signals }), cli).map((s) => s.id);
    expect(ids({ lastStatus: "failed", lastError: "401 invalid api key" })).toContain("recover-auth");
    expect(ids({ lastStatus: "failed", lastError: "getaddrinfo ENOTFOUND api.example.com" })).toContain("recover-network");
    expect(ids({ lastStatus: "failed", lastError: "exceeds the reserved model budget" })).toContain("recover-budget");
    expect(ids({ lastStatus: "iteration_limit" })).toContain("recover-limit");
  });

  it("classifies a failure by what the reader has to do about it", () => {
    expect(classifyFailure(defaultSignals({ lastStatus: "cancelled" }))).toBe("cancelled");
    expect(classifyFailure(defaultSignals({ lastStatus: "iteration_limit" }))).toBe("limit");
    expect(classifyFailure(defaultSignals({ lastStatus: "failed", lastError: "429 rate limit" }))).toBe("budget");
    expect(classifyFailure(defaultSignals({ lastStatus: "failed", lastError: "socket hang up" }))).toBe("network");
    expect(classifyFailure(defaultSignals({ lastStatus: "failed", lastError: "the tool blew up" }))).toBe("unknown");
  });

  it("says nothing about failure when the last turn succeeded", () => {
    const suggestions = suggest(defaultSignals({ turns: 2, changedFiles: 1, lastStatus: "completed", lastError: "401 unauthorized" }), cli);
    expect(suggestions.map((s) => s.category)).not.toContain("recovery");
  });

  it("counts in singular and plural rather than saying '1 files'", () => {
    const one = suggest(defaultSignals({ turns: 1, changedFiles: 1 }), cli).find((s) => s.id === "review-diff");
    expect(one?.reason).toBe("1 file changed and not looked at yet");
    const many = suggest(defaultSignals({ turns: 1, changedFiles: 3 }), cli).find((s) => s.id === "review-diff");
    expect(many?.reason).toBe("3 files changed and not looked at yet");
  });

  it("stops offering what has already been taken, by id or by the command that was typed", () => {
    const signals = defaultSignals({ turns: 1, changedFiles: 2 });
    expect(suggest(signals, cli).map((s) => s.id)).toContain("review-diff");
    expect(suggest({ ...signals, taken: ["review-diff"] }, cli).map((s) => s.id)).not.toContain("review-diff");
    // Typing `/diff` reviews the diff just as surely as clicking the chip does.
    expect(suggest({ ...signals, taken: ["/diff"] }, cli).map((s) => s.id)).not.toContain("review-diff");
  });

  it("never offers the same action twice under two names", () => {
    for (const signals of SITUATIONS) {
      for (const surface of ["cli", "desktop"] as const) {
        const keys = suggest(signals, { surface, limit: 8 }).map((s) =>
          s.action.kind === "command" ? s.action.command : s.action.kind === "ui" ? s.action.id : s.action.text,
        );
        expect(new Set(keys).size, `${surface}: ${keys.join(", ")}`).toBe(keys.length);
      }
    }
  });

  it("gives every rule a unique id, which is what 'taken' is recorded against", () => {
    const ids = suggestionIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("is a pure function of its signals — the same situation suggests the same thing", () => {
    for (const signals of SITUATIONS) {
      expect(suggest(signals, cli)).toEqual(suggest(signals, cli));
    }
  });

  it("never returns more than it was asked for, and nothing when asked for nothing", () => {
    for (const signals of SITUATIONS) {
      expect(suggest(signals, { surface: "cli", limit: 2 }).length).toBeLessThanOrEqual(2);
      expect(suggest(signals, { surface: "cli", limit: 0 })).toEqual([]);
    }
  });

  it("keeps ambient discovery out of the way until it is asked for", () => {
    const signals = defaultSignals({ turns: 5, hasSpend: true });
    const quiet = suggest(signals, { surface: "cli", limit: 5, categories: ["blocked", "recovery", "next"] });
    expect(quiet.map((s) => s.category)).not.toContain("discover");
    const ambient = suggest(signals, { surface: "cli", limit: 5, categories: ["discover"] });
    expect(ambient.length).toBeGreaterThan(0);
    expect(ambient.every((s) => s.category === "discover")).toBe(true);
  });

  it("only teaches a feature the session has not reached for", () => {
    const signals = defaultSignals({ turns: 5 });
    const first = suggest(signals, { surface: "cli", limit: 3, categories: ["discover"] });
    expect(first.length).toBeGreaterThan(0);
    const after = suggest({ ...signals, taken: first.map((s) => s.id) }, { surface: "cli", limit: 3, categories: ["discover"] });
    for (const suggestion of after) expect(first.map((s) => s.id)).not.toContain(suggestion.id);
  });

  it("does not suggest the mode you are already in", () => {
    const inDefender = suggest(defaultSignals({ turns: 2, mode: "defender", openFindings: 4 }), cli);
    expect(inDefender.map((s) => s.id)).not.toContain("fix-findings");
    const inPlan = suggest(defaultSignals({ turns: 5, mode: "plan" }), { surface: "cli", limit: 8, categories: ["discover"] });
    expect(inPlan.map((s) => s.id)).not.toContain("learn-plan-mode");
  });

  it("speaks up before the budget runs out rather than after", () => {
    const suggestions = suggest(defaultSignals({ turns: 4, hasSpend: true, budgetFraction: 0.8 }), cli);
    const warning = suggestions.find((s) => s.id === "watch-budget");
    expect(warning?.reason).toContain("80%");
    expect(suggest(defaultSignals({ turns: 4, hasSpend: true, budgetFraction: 0.2 }), cli).map((s) => s.id)).not.toContain("watch-budget");
  });
});

describe("starters", () => {
  it("offers them only into an empty, ready session", () => {
    expect(shouldOfferStarters(defaultSignals({ turns: 0 }))).toBe(true);
    expect(shouldOfferStarters(defaultSignals({ turns: 1 }))).toBe(false);
    expect(shouldOfferStarters(defaultSignals({ turns: 0 }), true)).toBe(false);
    expect(shouldOfferStarters(defaultSignals({ turns: 0, providerConfigured: false }))).toBe(false);
    expect(shouldOfferStarters(defaultSignals({ turns: 0, projectOpen: false }))).toBe(false);
  });

  it("suggests nothing that edits the project", () => {
    // The first thing a new reader clicks should not propose a change before they have understood
    // that the mode decides what Nova may do without asking.
    for (const starter of starterSuggestions(defaultSignals())) {
      expect(starter.label.toLowerCase()).not.toMatch(/\b(refactor|rewrite|delete|fix|migrate|upgrade)\b/);
      expect(starter.action.kind).toBe("prompt");
    }
  });

  it("names the project when it knows it", () => {
    expect(starterSuggestions(defaultSignals({ projectName: "api" }))[0].label).toContain("api");
    expect(starterSuggestions(defaultSignals())[0].label).toContain("this project");
  });
});

describe("optional model suggestions", () => {
  const rule: Suggestion = { id: "review-diff", label: "See what changed", reason: "3 files changed", category: "next", action: { kind: "command", command: "/diff" } };
  const guess: Suggestion = { id: "model-1", label: "Add a test for the parser", reason: "the parser changed and has no test", category: "next", action: { kind: "prompt", text: "Add a test for the parser" } };

  it("appends behind the rules and never reorders them", () => {
    const merged = mergeModelSuggestions([rule], [guess]);
    expect(merged[0]).toEqual(rule);
    expect(merged[1].id).toBe("model-1");
  });

  it("marks a guess as a guess", () => {
    expect(mergeModelSuggestions([rule], [guess])[1].fromModel).toBe(true);
    expect(mergeModelSuggestions([rule], [guess])[0].fromModel).toBeUndefined();
  });

  it("caps how much a model may add, and drops what the rules already said", () => {
    const many = Array.from({ length: 5 }, (_unused, index) => ({ ...guess, id: `model-${index}` }));
    expect(mergeModelSuggestions([rule], many, { maxModel: 2 })).toHaveLength(3);
    expect(mergeModelSuggestions([rule], [{ ...guess, id: "review-diff" }])).toEqual([rule]);
  });

  it("drops a model suggestion that says nothing", () => {
    expect(mergeModelSuggestions([rule], [{ ...guess, reason: "  " }])).toEqual([rule]);
    expect(mergeModelSuggestions([rule], [{ ...guess, label: "" }])).toEqual([rule]);
  });
});

describe("the optional model pass", () => {
  it("reads a well-formed reply as prompts, never as actions", () => {
    const parsed = parseModelSuggestions('[{"ask":"Add a test for the parser","why":"it changed and has none"}]');
    expect(parsed).toHaveLength(1);
    // A generated line can only ever propose something to ask for. The worst outcome of a bad rule
    // is a wasted click; the worst outcome of a bad generated *action* is a revert nobody asked for.
    expect(parsed[0].action).toEqual({ kind: "prompt", text: "Add a test for the parser" });
    expect(parsed[0].fromModel).toBe(true);
  });

  it("finds the array inside a reply that could not resist explaining itself", () => {
    expect(parseModelSuggestions('Sure! [{"ask":"Run the tests","why":"nothing has verified it"}] Hope that helps.')).toHaveLength(1);
  });

  it("yields nothing from anything malformed — a half-read guess is still a guess", () => {
    expect(parseModelSuggestions("not json")).toEqual([]);
    expect(parseModelSuggestions("[")).toEqual([]);
    expect(parseModelSuggestions('{"ask":"x","why":"y"}')).toEqual([]);
    expect(parseModelSuggestions('[{"ask":"","why":"y"},{"ask":"x"},{"why":"y"},null,3]')).toEqual([]);
  });

  it("returns nothing when the model fails, rather than surfacing an error over a hint", () => {
    const broken = { complete: () => Promise.reject(new Error("no")) };
    return expect(askModelForSuggestions(broken, defaultSignals())).resolves.toEqual([]);
  });

  it("tells the model what happened without handing it the transcript", async () => {
    let seen = "";
    const model = {
      complete: async (request: { messages: { role: "system" | "user"; content: string }[]; maxOutputTokens: number }) => {
        seen = request.messages.map((message) => message.content).join("\n");
        return { content: "[]" };
      },
    };
    await askModelForSuggestions(model, defaultSignals({ turns: 2, changedFiles: 3, mode: "plan" }), { lastRequest: "add caching" });
    expect(seen).toContain("files changed since the last checkpoint: 3");
    expect(seen).toContain("mode: plan");
    expect(seen).toContain("add caching");
  });
});
