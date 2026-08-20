import { describe, expect, it } from "vitest";
import { COMMANDS } from "./commands";
import { paletteEntries } from "./palette";
import { UNICODE_GLYPHS } from "./glyphs";
import {
  COMMAND_GROUP,
  CommandUsage,
  ESSENTIAL_COMMANDS,
  GROUP_PREVIEW,
  groupedCommands,
  isEssential,
  renderEssentials,
  NAV_GROUPS,
  rankWithContext,
  renderGroupedHelp,
  renderHint,
  renderRecovery,
  renderStarters,
  renderSuggestions,
  suggestHints,
  suggestNext,
  type NavContext,
} from "./navigation";

const base: NavContext = {
  mode: "build", turns: 0, changedFiles: 0, openTodos: 0, runningJobs: 0, tabs: 1,
  sandbox: false, providerConfigured: true, hasSpend: false, recent: [],
};
const style = { width: 78, depth: "none" as const };

describe("grouping", () => {
  it("gives every command a group, so none can vanish from grouped help", () => {
    const ungrouped = COMMANDS.filter((command) => !COMMAND_GROUP[command.name]);
    expect(ungrouped.map((command) => command.name)).toEqual([]);
  });

  it("groups only into groups that exist", () => {
    const known = new Set(NAV_GROUPS.map((group) => group.id));
    for (const [command, group] of Object.entries(COMMAND_GROUP)) expect(known.has(group), `${command} → ${group}`).toBe(true);
  });

  it("shows every command exactly once when asked for everything", () => {
    const listed = groupedCommands(base, true).flatMap((group) => group.commands.map((command) => command.name));
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.length).toBe(COMMANDS.length);
  });

  it("previews a few per group and says how many it held back", () => {
    for (const group of groupedCommands(base)) {
      expect(group.commands.length).toBeLessThanOrEqual(GROUP_PREVIEW);
      expect(group.hidden).toBeGreaterThanOrEqual(0);
    }
    const previewed = groupedCommands(base).reduce((sum, group) => sum + group.commands.length, 0);
    expect(previewed).toBeLessThan(COMMANDS.length);
  });

  it("leaves out what cannot apply here, and puts it back when it can", () => {
    // The preview is filtered by what the session can use; `all` is the complete reference and is
    // deliberately not filtered — a command you cannot use yet is still one you should be able to
    // read about.
    const quiet = groupedCommands(base).flatMap((group) => group.commands.map((command) => command.name));
    expect(quiet).not.toContain("/pull");
    expect(quiet).not.toContain("/attach");

    const busy = groupedCommands({ ...base, sandbox: true, runningJobs: 2, turns: 3, openTodos: 1, recent: ["/pull", "/attach", "/todos"] })
      .flatMap((group) => group.commands.map((command) => command.name));
    expect(busy).toContain("/pull");
    expect(busy).toContain("/attach");
    expect(busy).toContain("/todos");
  });

  it("does not offer the mode you are already in", () => {
    const listed = groupedCommands({ ...base, mode: "plan", turns: 2 }).flatMap((group) => group.commands.map((command) => command.name));
    expect(listed).not.toContain("/plan");
    expect(listed).toContain("/build");
  });
});

describe("suggestions", () => {
  it("says the one blocking thing and nothing else when nothing can work yet", () => {
    expect(suggestNext({ ...base, providerConfigured: false, changedFiles: 9, runningJobs: 3 }))
      .toEqual([{ command: "/settings", reason: "no model provider is configured yet" }]);
  });

  it("offers review after the agent has changed files, with the count as the reason", () => {
    const suggestions = suggestNext({ ...base, turns: 1, changedFiles: 3 });
    expect(suggestions[0]).toEqual({ command: "/diff", reason: "3 files changed and not looked at yet" });
    expect(suggestions.map((suggestion) => suggestion.command)).toContain("/undo");
  });

  it("counts in singular and plural rather than saying '1 files'", () => {
    expect(suggestNext({ ...base, turns: 1, changedFiles: 1 })[0].reason).toBe("1 file changed and not looked at yet");
    expect(suggestNext({ ...base, turns: 1, openTodos: 1 }).find((s) => s.command === "/todos")?.reason).toContain("1 item ");
  });

  it("stops offering what this session has already used", () => {
    const context = { ...base, turns: 1, changedFiles: 2 };
    expect(suggestNext(context).map((s) => s.command)).toContain("/diff");
    expect(suggestNext({ ...context, recent: ["/diff"] }).map((s) => s.command)).not.toContain("/diff");
  });

  it("moves a finished plan towards building it", () => {
    const suggestions = suggestNext({ ...base, mode: "plan", turns: 2 });
    expect(suggestions.map((s) => s.command)).toContain("/build");
  });

  it("points at the security work when a scan found something and the mode cannot fix it", () => {
    expect(suggestNext({ ...base, turns: 1, openFindings: 4 })[0])
      .toEqual({ command: "/defender", reason: "4 security findings to work through" });
    // Already in defender mode: the suggestion would be telling you to do what you are doing.
    expect(suggestNext({ ...base, mode: "defender", turns: 1, openFindings: 4 }).map((s) => s.command)).not.toContain("/defender");
  });

  it("never suggests more than it was asked for, and nothing at all when there is nothing to say", () => {
    expect(suggestNext({ ...base, turns: 1 }, 2).length).toBeLessThanOrEqual(2);
    expect(suggestNext({ ...base, turns: 1, recent: ["/detach"] }, 3)).toEqual([]);
  });
});

describe("context-aware ranking", () => {
  const entries = paletteEntries();

  it("never breaks the literal tiers: a name match still outranks a description match", () => {
    const ranked = rankWithContext(entries, "diff", { ...base, turns: 5, changedFiles: 0, recent: ["/undo"] });
    expect(ranked[0].command).toBe("/diff");
  });

  it("orders the empty query by the situation instead of by the catalog", () => {
    const catalog = rankWithContext(entries, "", base);
    const changed = rankWithContext(entries, "", { ...base, turns: 2, changedFiles: 4 });
    expect(changed[0].command).toBe("/diff");
    expect(catalog[0].command).not.toBe("/diff");
  });

  it("floats what you just used above what you never have", () => {
    const ranked = rankWithContext(entries, "", { ...base, turns: 2, recent: ["/theme", "/model"] });
    const positionOf = (command: string) => ranked.findIndex((entry) => entry.command === command);
    expect(positionOf("/theme")).toBeLessThan(positionOf("/providers"));
    expect(positionOf("/theme")).toBeGreaterThan(-1);
  });

  it("keeps every entry a plain ranking would keep", () => {
    for (const query of ["", "d", "model", "revert"]) {
      expect(rankWithContext(entries, query, base).length).toBeGreaterThan(0);
    }
    expect(rankWithContext(entries, "zzzznotacommand", base)).toEqual([]);
  });
});

describe("rendering", () => {
  it("leads with where you are, then the groups, then the way to everything else", () => {
    const rendered = renderGroupedHelp({ ...base, turns: 2, changedFiles: 2 }, style);
    expect(rendered).toContain("Where you are");
    expect(rendered.indexOf("Where you are")).toBeLessThan(rendered.indexOf("Do the work"));
    expect(rendered).toContain("/help all");
    for (const line of rendered.split("\n")) expect(line.length).toBeLessThanOrEqual(style.width);
  });

  it("drops the suggestion block from the full listing, where nothing is being held back", () => {
    const all = renderGroupedHelp({ ...base, turns: 2, changedFiles: 2 }, style, { all: true });
    expect(all).not.toContain("Where you are");
    expect(all).toContain("/palette");
  });

  it("writes one line, or none at all when there is nothing worth saying", () => {
    const line = renderSuggestions({ ...base, turns: 1, changedFiles: 2 }, style, { limit: 1 });
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("/diff");
    expect(renderSuggestions({ ...base, turns: 1, recent: ["/detach"] }, style, { limit: 1 })).toBe("");
  });
});

describe("session usage", () => {
  it("keeps most recent first, without repeats", () => {
    const log = new CommandUsage();
    log.record("/diff");
    log.record("/model claude-opus-5");
    log.record("/diff");
    expect(log.recent).toEqual(["/diff", "/model"]);
  });

  it("ignores anything that is not a command", () => {
    const log = new CommandUsage();
    log.record("fix the failing test");
    log.record("  ");
    expect(log.recent).toEqual([]);
  });

  it("remembers a bounded number of them", () => {
    const log = new CommandUsage(3);
    for (const command of ["/a", "/b", "/c", "/d"]) log.record(command);
    expect(log.recent).toEqual(["/d", "/c", "/b"]);
  });
});

describe("the suggestive prompt", () => {
  it("shows what to do next, and one thing worth knowing when there is room", () => {
    const block = renderSuggestions({ ...base, turns: 5, hasSpend: true }, style, { limit: 2, hints: true });
    const lines = block.split("\n");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.length).toBeLessThanOrEqual(2);
  });

  it("drops the teaching line first when the session has real work to report", () => {
    // Two next steps fill the block; an ambient hint printed under them would be a third thing to
    // skip past, and the row people learn to skip is the row nothing can be taught in again.
    const busy = { ...base, turns: 5, changedFiles: 3, hasSpend: true };
    const block = renderSuggestions(busy, style, { limit: 2, hints: true });
    const lines = block.split("\n");
    expect(lines).toHaveLength(2);
    for (const hint of suggestHints(busy, 3)) expect(block).not.toContain(hint.reason);
  });

  it("says nothing at all when there is nothing to say", () => {
    expect(renderSuggestions({ ...base, turns: 1, recent: ["/detach"] }, style, { limit: 2 })).toBe("");
  });

  it("teaches something in an empty result, and stops once it has been taken", () => {
    const quiet = { ...base, turns: 4 };
    const hint = renderHint(quiet, style);
    expect(hint).not.toBe("");
    const taken = suggestHints(quiet, 9).map((suggestion) => suggestion.command);
    expect(renderHint({ ...quiet, recent: taken }, style)).toBe("");
  });

  it("offers a way out of a failure, naming the failure", () => {
    const recovery = renderRecovery({ ...base, turns: 1, lastStatus: "failed", lastError: "401 invalid api key" }, style);
    expect(recovery).toContain("/settings");
    expect(recovery).toContain("key");
  });

  it("offers no way out when nothing failed", () => {
    expect(renderRecovery({ ...base, turns: 1, lastStatus: "completed" }, style)).toBe("");
  });

  it("says what to ask for into an empty session, and gets out of the way after the first turn", () => {
    const starters = renderStarters(base, style, "api");
    expect(starters).toContain("api");
    expect(starters.split("\n").length).toBeGreaterThan(1);
    expect(renderStarters({ ...base, turns: 1 }, style, "api")).toBe("");
  });
});

/**
 * The few commands a first session actually needs.
 *
 * Grouping answers "what is this for", which is the wrong question on day one: forty rows in six
 * honest categories still reads as forty rows. These tests pin the shorter answer — that a small
 * marked set exists, that it survives every filter and truncation between the catalog and the
 * screen, and that it stays small.
 */
describe("the commands worth learning first", () => {
  const fresh = (over: Partial<NavContext> = {}): NavContext => ({ ...base, turns: 0, ...over });

  it("names commands that actually exist", () => {
    // A marked command that no longer exists is a star beside nothing, and the mark quietly stops
    // meaning anything the moment one entry is wrong.
    const known = new Set<string>(COMMANDS.map((command) => command.name));
    for (const name of ESSENTIAL_COMMANDS) expect(known.has(name), `${name} is not a command`).toBe(true);
  });

  it("stays short enough to be a shortlist", () => {
    // A list where the eighth item is "essential" is a list whose first item is not. Additions
    // should have to displace something rather than accumulate.
    expect(ESSENTIAL_COMMANDS.length).toBeLessThanOrEqual(7);
    expect(new Set(ESSENTIAL_COMMANDS).size).toBe(ESSENTIAL_COMMANDS.length);
  });

  it("covers the four questions a newcomer cannot answer any other way", () => {
    // Not a popularity ranking: each of these answers a question that will come up in a first
    // session and that nothing else in the interface answers.
    expect(isEssential("/help")).toBe(true);   // where is everything
    expect(isEssential("/diff")).toBe(true);   // what did it change
    expect(isEssential("/undo")).toBe(true);   // take that back
    expect(isEssential("/mode")).toBe(true);   // may it write to my files
    expect(isEssential("/tab")).toBe(false);   // real, useful, and not a day-one question
  });

  it("survives a group's preview truncation, which is the whole point", () => {
    // `/undo` sits in a group with several other commands and would otherwise be a candidate for
    // the "… N more" line — hiding the safety net from exactly the person most likely to need it.
    const groups = groupedCommands(fresh({ turns: 3, changedFiles: 2 }));
    const shown = groups.flatMap((group) => group.commands.map((command) => command.name));
    for (const name of ESSENTIAL_COMMANDS) {
      // `/mode` is suppressed when you are already in that mode, which is a statement not a
      // command; everything else must be on screen without expanding anything.
      if (name === `/${fresh().mode}`) continue;
      expect(shown, `${name} was truncated out of grouped help`).toContain(name);
    }
  });

  it("marks them on screen, and says what the mark means", () => {
    const rendered = renderGroupedHelp(fresh({ turns: 3, changedFiles: 1 }), style);
    // The *catalog* row, not the contextual "Where you are" row above it — both mention `/undo`,
    // and it is the catalog listing that has to carry the mark.
    const line = rendered.split("\n").find((row) => row.includes("/undo") && row.includes("Revert the last turn"));
    expect(line, "no catalog row for /undo").toBeDefined();
    expect(line).toContain(UNICODE_GLYPHS.star);
    // A mark nobody can decode is decoration. The legend travels with it.
    expect(rendered).toContain("start with these");
  });

  it("leaves ordinary commands unmarked, so the mark still means something", () => {
    const rendered = renderGroupedHelp(fresh({ turns: 3 }), style);
    const line = rendered.split("\n").find((row) => row.includes("/theme"));
    expect(line).toBeDefined();
    expect(line).not.toContain(UNICODE_GLYPHS.star);
  });

  it("offers the one-line reminder to a new session and to nobody else", () => {
    // Once, at the top of a first session. A permanent tip bar is something people learn to look
    // past within a day, and by the second session these are known or findable.
    expect(renderEssentials(fresh(), style)).toContain("/undo");
    expect(renderEssentials(fresh({ turns: 1 }), style)).toBe("");
  });

  it("keeps the way out of being lost when the terminal is too narrow for the rest", () => {
    // Dropped whole rather than clipped: half a command name teaches nothing, and `/help` is the
    // one that leads to every other, so it is the last to go.
    const narrow = renderEssentials(fresh(), { ...style, width: 28 });
    expect(narrow).toContain("/help");
  });
});
