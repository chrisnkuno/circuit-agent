import { describe, expect, it } from "vitest";
import type { SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import {
  countTurns,
  parseHistoryCommand,
  relativeTime,
  renderHistoryList,
  renderHistoryUsage,
  renderReplay,
  searchHistory,
  summarizeSession,
  type HistoryEntry,
} from "./chat-history";
import { visibleWidth } from "./markdown";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 76): SectionStyle => ({ width, depth: "none" });

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 2,
    revision: 1,
    id: "20260808T001720Z-2ubjpz",
    createdAt: 1_000,
    updatedAt: 2_000,
    root: "/repo",
    title: "fix the failing tests",
    approvals: {},
    totalRwf: 0,
    messages: [
      { role: "system", content: "you are Nova" },
      { role: "user", content: "fix the failing tests" },
      { role: "assistant", content: "", toolCalls: [{ id: "1", name: "run_command", arguments: { command: "npm test" } }] },
      { role: "tool", content: "exit 1", toolCallId: "1", name: "run_command" },
      { role: "assistant", content: "The **money** test was wrong." },
      { role: "user", content: "thanks" },
      { role: "assistant", content: "Any time." },
    ],
    ...overrides,
  } as SessionRecord;
}

describe("summarising a session", () => {
  it("counts turns as exchanges, which is what a person means by 'how long was it'", () => {
    expect(countTurns(session().messages)).toBe(2);
    expect(summarizeSession(session())).toMatchObject({ turns: 2, messages: 7, title: "fix the failing tests" });
  });
});

describe("relative time", () => {
  it("uses the unit a person would say out loud, at every scale", () => {
    const now = Date.now();
    expect(relativeTime(now, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
    expect(relativeTime(now - 60 * 86_400_000, now)).toBe("2mo ago");
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe("2y ago");
  });

  it("never reports a future timestamp as a negative age", () => {
    const now = Date.now();
    expect(relativeTime(now + 60_000, now)).toBe("just now");
  });
});

describe("searching", () => {
  const entries: HistoryEntry[] = [
    { id: "a", title: "fix the failing tests", updatedAt: 100, turns: 2, messages: 6 },
    { id: "b", title: "add a health check", updatedAt: 300, turns: 1, messages: 3 },
    { id: "c", title: "Fix the flaky test", updatedAt: 200, turns: 5, messages: 20 },
  ];

  it("matches the words someone remembers typing, regardless of case", () => {
    expect(searchHistory(entries, "fix").map((entry) => entry.id)).toEqual(["c", "a"]);
  });

  it("returns everything, most recent first, for an empty query", () => {
    expect(searchHistory(entries, "  ").map((entry) => entry.id)).toEqual(["b", "c", "a"]);
  });

  it("returns nothing rather than everything when nothing matches", () => {
    expect(searchHistory(entries, "kubernetes")).toEqual([]);
  });

  it("finds decisions, tool names and commands inside the conversation, not only its title", () => {
    const indexed = summarizeSession(session());
    expect(searchHistory([indexed], "money test")).toHaveLength(1);
    expect(searchHistory([indexed], "npm test")).toHaveLength(1);
    expect(searchHistory([indexed], "run_command")).toHaveLength(1);
  });
});

describe("the list view", () => {
  const entries: HistoryEntry[] = [
    { id: "a", title: "fix the failing tests", updatedAt: Date.now() - 3_600_000, turns: 2, messages: 6 },
    { id: "b", title: "add a health check", updatedAt: Date.now(), turns: 1, messages: 3 },
  ];

  it("says plainly when there is no history, rather than printing an empty frame", () => {
    expect(plain(renderHistoryList([], style()))).toContain("no past sessions");
  });

  it("shows recency and size beside each title, which is how a session is recognised", () => {
    const rendered = plain(renderHistoryList(entries, style()));
    expect(rendered).toContain("fix the failing tests");
    expect(rendered).toContain("1h ago");
    expect(rendered).toContain("2 turns");
    expect(rendered).toMatch(/\b1 turn\b/);
  });

  it("marks the session you are in", () => {
    const rendered = plain(renderHistoryList(entries, style(), { current: "b" })).split("\n");
    const marked = rendered.filter((line) => line.trimStart().startsWith("●"));
    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("add a health check");
  });

  it("stays inside the terminal at any width", () => {
    for (const width of [40, 76, 120]) {
      const rendered = plain(renderHistoryList(entries, style(width)));
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("shows native match evidence without exceeding the terminal width", () => {
    const withEvidence: HistoryEntry = {
      ...entries[0],
      evidence: { source: "journal", snippet: "Ran [PaymentIntent] retry tests", why: ["FTS5 lexical match in tool result", "evidence source: journal"] },
    };
    const rendered = plain(renderHistoryList([withEvidence], style(52)));
    expect(rendered).toContain("journal evidence");
    expect(rendered).toContain("PaymentIntent");
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(52);
  });
});

describe("replaying a conversation", () => {
  it("separates the turns with rules, so a question and its answer are visibly distinct", () => {
    const rendered = plain(renderReplay(session(), style()));
    expect(rendered).toContain("turn 1");
    expect(rendered).toContain("turn 2");
    expect(rendered).toContain("end of session");
  });

  it("renders the assistant's markdown rather than printing its asterisks", () => {
    const rendered = plain(renderReplay(session(), style()));
    expect(rendered).toContain("The money test was wrong.");
  });

  it("shows a tool call as one line naming what it did", () => {
    const rendered = plain(renderReplay(session(), style()));
    expect(rendered).toContain("run_command");
    expect(rendered).toContain("npm test");
  });

  it("never replays the system prompt, which is not part of the conversation", () => {
    expect(plain(renderReplay(session(), style()))).not.toContain("you are Nova");
  });

  it("keeps the last N turns when asked, and says the rest was left out", () => {
    const rendered = plain(renderReplay(session(), style(), { turns: 1 }));
    expect(rendered).toContain("earlier turns omitted");
    expect(rendered).toContain("thanks");
    // One turn rule, not two: the earlier exchange is summarised away rather than replayed.
    expect(rendered.split("\n").filter((line) => /── turn \d/.test(line))).toHaveLength(1);
  });
});

describe("the /history grammar", () => {
  it("lists on a bare command, under either name", () => {
    expect(parseHistoryCommand("/history")).toEqual({ kind: "list" });
    expect(parseHistoryCommand("/sessions")).toEqual({ kind: "list" });
  });

  it("searches for free text", () => {
    expect(parseHistoryCommand("/history search failing tests")).toEqual({ kind: "search", query: "failing tests" });
    expect(parseHistoryCommand("/history search")).toMatchObject({ kind: "invalid" });
    expect(parseHistoryCommand("/history status")).toEqual({ kind: "status" });
    expect(parseHistoryCommand("/history doctor")).toEqual({ kind: "status" });
  });

  it("reads back a session by id, optionally only its last few turns", () => {
    expect(parseHistoryCommand("/history 20260808T001720Z-2ubjpz")).toEqual({ kind: "show", id: "20260808T001720Z-2ubjpz" });
    expect(parseHistoryCommand("/history 20260808T001720Z-2ubjpz 3")).toEqual({ kind: "show", id: "20260808T001720Z-2ubjpz", turns: 3 });
  });

  it("resumes, with or without an id", () => {
    expect(parseHistoryCommand("/history resume")).toEqual({ kind: "resume" });
    expect(parseHistoryCommand("/history resume latest")).toEqual({ kind: "resume", id: "latest" });
    expect(parseHistoryCommand("/history resume nonsense")).toMatchObject({ kind: "invalid" });
  });

  it("explains rather than guessing when the argument is neither an id nor a verb", () => {
    const parsed = parseHistoryCommand("/history yesterday");
    expect(parsed?.kind).toBe("invalid");
    expect(parsed && "reason" in parsed && parsed.reason).toContain("yesterday");
  });

  it("ignores anything that is not the command", () => {
    expect(parseHistoryCommand("/historical")).toBeNull();
  });
});

describe("renderHistoryUsage", () => {
  const style = { width: 80, depth: "none" as const };
  const DAY = 86_400_000;
  const now = new Date("2026-08-16T12:00:00Z").getTime();
  const entry = (daysAgo: number, turns: number, id = `s${daysAgo}`) =>
    ({ id, title: "t", updatedAt: now - daysAgo * DAY, turns, messages: turns * 2 });

  it("draws a bar per day across the window, including the days with no work", () => {
    const rendered = renderHistoryUsage([entry(0, 5), entry(3, 2)], style, { now, days: 5 });
    // Five days requested means five bars, not two — the quiet days are the information.
    expect(rendered.split("\n").filter((line) => line.includes("░") || line.includes("█"))).toHaveLength(5);
  });

  it("sums every session that lands on the same day", () => {
    const both = renderHistoryUsage([entry(0, 3, "a"), entry(0, 4, "b")], style, { now, days: 2 });
    const one = renderHistoryUsage([entry(0, 7, "c")], style, { now, days: 2 });
    // 3 + 4 and 7 are the same day's work and must draw the same bar.
    expect(both.split("\n").at(-1)).toBe(one.split("\n").at(-1));
  });

  it("says nothing at all when there is nothing to show", () => {
    expect(renderHistoryUsage([], style, { now })).toBe("");
    // Every session older than the window leaves an all-zero chart, which is noise rather than news.
    expect(renderHistoryUsage([entry(90, 4)], style, { now, days: 7 })).toBe("");
  });

  it("ignores sessions from outside the window rather than folding them into the edge bar", () => {
    const withOld = renderHistoryUsage([entry(0, 2), entry(60, 99)], style, { now, days: 3 });
    const withoutOld = renderHistoryUsage([entry(0, 2)], style, { now, days: 3 });
    expect(withOld).toBe(withoutOld);
  });

  it("never exceeds the width it was given", () => {
    for (const line of renderHistoryUsage([entry(0, 5)], { width: 40, depth: "none" }, { now, days: 4 }).split("\n")) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(40);
    }
  });
});
