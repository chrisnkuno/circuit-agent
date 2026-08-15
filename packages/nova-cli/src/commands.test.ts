import { describe, expect, it } from "vitest";
import { COMMANDS, completeCommand, completeFileMention, completeHistory, completeInput, isKnownCommand, renderCommandHelp, renderKeyboardShortcuts, suggestCommand } from "./commands";

describe("command registry", () => {
  it("lists every command exactly once, each starting with a slash", () => {
    const names = COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.startsWith("/")).toBe(true);
  });

  it("renders help from the same table completion reads, so they can't drift apart", () => {
    const help = renderCommandHelp();
    for (const command of COMMANDS) {
      expect(help).toContain(command.name);
      expect(help).toContain(command.description);
    }
  });
});

describe("tab completion", () => {
  it("completes a partial command to every command sharing its prefix", () => {
    const [matches] = completeCommand("/pl");
    expect(matches).toContain("/plan");
  });

  it("returns every command name for a bare slash", () => {
    const [matches] = completeCommand("/");
    expect(matches.length).toBe(COMMANDS.length);
  });

  it("does not treat ordinary prose as a command, even mid-sentence", () => {
    const [matches] = completeCommand("fix the file at src/parser.ts");
    expect(matches).toEqual([]);
  });

  it("returns no matches for a slash that starts no known command", () => {
    const [matches] = completeCommand("/nonexistent");
    expect(matches).toEqual([]);
  });
});

describe("keyboard shortcuts", () => {
  it("documents at least the interrupt and completion keys", () => {
    const rendered = renderKeyboardShortcuts();
    expect(rendered).toContain("Ctrl-C");
    expect(rendered).toContain("Tab");
  });
});

describe("file mention completion", () => {
  const files = ["src/app.ts", "src/app.test.ts", "src/deep/util.ts", "README.md"];

  it("completes a path fragment into the paths that exist", () => {
    const [matches, replaced] = completeFileMention("read @src/ap", files)!;
    expect(matches).toEqual(["@src/app.ts", "@src/app.test.ts"]);
    expect(replaced).toBe("@src/ap"); // readline replaces exactly this much of the line
  });

  it("finds a file by a fragment from the middle of its path", () => {
    // Typing the basename is what people actually do; requiring the directory first is friction.
    const [matches] = completeFileMention("@util", files)!;
    expect(matches).toEqual(["@src/deep/util.ts"]);
  });

  it("puts prefix matches ahead of mid-path matches", () => {
    const [matches] = completeFileMention("@app", ["z/app.ts", "app.ts"])!;
    expect(matches[0]).toBe("@app.ts");
  });

  it("offers everything for a bare @, and matches case-insensitively", () => {
    expect(completeFileMention("@", files)![0]).toHaveLength(files.length);
    expect(completeFileMention("@README", files)![0]).toEqual(["@README.md"]);
    expect(completeFileMention("@readme", files)![0]).toEqual(["@README.md"]);
  });

  it("is not a mention when the @ is mid-word, as in an email address", () => {
    // A mention starts a word. Without that rule, typing an email address turns the rest of the
    // line into a path search.
    expect(completeFileMention("mail someone@example.com", files)).toBeNull();
    expect(completeFileMention("no mention here", files)).toBeNull();
  });

  it("caps its suggestions rather than flooding the terminal", () => {
    const many = Array.from({ length: 500 }, (_unused, index) => `src/file${index}.ts`);
    expect(completeFileMention("@src/", many)![0].length).toBeLessThanOrEqual(50);
  });
});

describe("completeHistory", () => {
  const history = ["fix the login bug", "fix the failing test", "add a health check"];

  it("finds previous requests that start with what's typed so far", () => {
    const [matches] = completeHistory("fix the", history)!;
    expect(matches).toContain("fix the login bug");
    expect(matches).toContain("fix the failing test");
    expect(matches).not.toContain("add a health check");
  });

  it("prefers the most recently asked match first", () => {
    const [matches] = completeHistory("fix the", history)!;
    expect(matches[0]).toBe("fix the failing test"); // asked after "fix the login bug"
  });

  it("finds nothing for empty input, slash commands, or an @mention", () => {
    expect(completeHistory("", history)).toBeNull();
    expect(completeHistory("/plan", history)).toBeNull();
    expect(completeHistory("read @src/app", history)).toBeNull();
  });

  it("does not suggest the line back to itself", () => {
    expect(completeHistory("fix the login bug", history)).toBeNull();
  });

  it("finds nothing when nothing in history matches", () => {
    expect(completeHistory("write a new feature", history)).toBeNull();
  });
});

describe("completeInput", () => {
  const files = ["src/app.ts"];

  it("completes commands at the start of a line and mentions anywhere in it", () => {
    expect(completeInput("/pl", files)[0]).toContain("/plan");
    expect(completeInput("please read @src/", files)[0]).toContain("@src/app.ts");
  });

  it("offers nothing for ordinary prose with no matching history", () => {
    expect(completeInput("fix the failing test", files)[0]).toEqual([]);
  });

  it("offers matching history for ordinary prose when history is given", () => {
    const matches = completeInput("fix the", files, ["fix the login bug"])[0];
    expect(matches).toContain("fix the login bug");
  });

  it("prefers the mention when a line has both a command and a mention", () => {
    // The mention is what the cursor is on, so it is what completing should act on.
    expect(completeInput("/model @src/", files)[0]).toContain("@src/app.ts");
  });
});

describe("suggestCommand", () => {
  it("names the command a near miss probably meant", () => {
    expect(suggestCommand("/tood")).toBe("/todos");
    expect(suggestCommand("/dif")).toBe("/diff");
    expect(suggestCommand("/exti")).toBe("/exit");
  });

  it("suggests nothing when the input resembles no command, rather than guessing", () => {
    expect(suggestCommand("/wholly-unrelated-thing")).toBeUndefined();
  });
});

describe("isKnownCommand", () => {
  it("recognises every command in the table and nothing else", () => {
    for (const command of COMMANDS) expect(isKnownCommand(command.name)).toBe(true);
    expect(isKnownCommand("/nope")).toBe(false);
  });
});
