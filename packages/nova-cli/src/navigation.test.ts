import { describe, expect, it } from "vitest";
import { COMMANDS } from "./commands";
import { paletteEntries } from "./palette";
import {
  COMMAND_GROUP,
  CommandUsage,
  GROUP_PREVIEW,
  groupedCommands,
  NAV_GROUPS,
  rankWithContext,
  renderGroupedHelp,
  renderNextStep,
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
    const line = renderNextStep({ ...base, turns: 1, changedFiles: 2 }, style);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain("/diff");
    expect(renderNextStep({ ...base, turns: 1, recent: ["/detach"] }, style)).toBe("");
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
