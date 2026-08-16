import { describe, expect, it } from "vitest";
import { COMMANDS, completeCommand, inlineCompletion, completeFileMention, completeInput, completeModelArgument, isKnownCommand, parseModeCommand, renderCommandHelp, renderKeyboardShortcuts, suggestCommand, suggestionsFor } from "./commands";

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

  it("documents the explicit mode switch alongside its quick shortcuts", () => {
    const help = renderCommandHelp();
    expect(help).toContain("/mode [plan|build|auto|defender]");
    expect(completeCommand("/mo")[0]).toContain("/mode");
  });

  it("inlines a command's keyboard shortcut when one is given, and leaves commands without one alone", () => {
    const help = renderCommandHelp("en", new Map([["/model", "F3, Alt+M"]]));
    expect(help).toMatch(/\/model.*F3, Alt\+M/);
    // A command with no shortcut still lines up — no dangling gap or misaligned description.
    expect(help).toContain("/undo");
  });

  it("omits the shortcut column entirely when nothing was given, unchanged from before shortcuts existed", () => {
    expect(renderCommandHelp()).toBe(renderCommandHelp("en", new Map()));
  });
});

describe("mode commands", () => {
  it("supports explicit mode inspection and every switch shortcut", () => {
    expect(parseModeCommand("/mode")).toEqual({ type: "show" });
    expect(parseModeCommand("/mode auto")).toEqual({ type: "switch", mode: "auto" });
    expect(parseModeCommand("/plan")).toEqual({ type: "switch", mode: "plan" });
    expect(parseModeCommand("/build")).toEqual({ type: "switch", mode: "build" });
    expect(parseModeCommand("/auto")).toEqual({ type: "switch", mode: "auto" });
    expect(parseModeCommand("/defender")).toEqual({ type: "switch", mode: "defender" });
    expect(parseModeCommand("/mode defender")).toEqual({ type: "switch", mode: "defender" });
  });

  it("distinguishes an invalid mode from ordinary prompt text", () => {
    expect(parseModeCommand("/mode fast")).toEqual({ type: "invalid" });
    expect(parseModeCommand("please plan this")).toBeNull();
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

describe("completeInput", () => {
  const files = ["src/app.ts"];

  it("completes commands at the start of a line and mentions anywhere in it", () => {
    expect(completeInput("/pl", files)[0]).toContain("/plan");
    expect(completeInput("please read @src/", files)[0]).toContain("@src/app.ts");
  });

  it("offers nothing for ordinary prose", () => {
    expect(completeInput("fix the failing test", files)[0]).toEqual([]);
  });

  it("prefers the mention when a line has both a command and a mention", () => {
    // The mention is what the cursor is on, so it is what completing should act on.
    expect(completeInput("/model @src/", files)[0]).toContain("@src/app.ts");
  });
});

describe("model argument completion", () => {
  const models = ["claude-sonnet-5", "claude-opus-5", "gpt-5.6-terra"];

  it("completes the whole line, so accepting a match leaves a runnable command", () => {
    // Returning the bare model id would replace `/model claude-` with `claude-sonnet-5`, which is
    // not a command at all — readline substitutes the match for the entire line it was given.
    expect(completeModelArgument("/model claude-s", models)?.[0]).toEqual(["/model claude-sonnet-5"]);
  });

  it("matches inside the id, not just at the front", () => {
    // Model ids are front-loaded with vendor prefixes; prefix-only completion would mean typing
    // the least distinguishing part of the name before getting any help with the rest.
    expect(completeModelArgument("/model opus", models)?.[0]).toEqual(["/model claude-opus-5"]);
  });

  it("ranks prefix matches above substring matches", () => {
    expect(completeModelArgument("/model claude", models)?.[0]).toEqual(["/model claude-sonnet-5", "/model claude-opus-5"]);
  });

  it("offers every model on a bare /model", () => {
    expect(completeModelArgument("/model ", models)?.[0]).toHaveLength(3);
  });

  it("declines lines that are not a model argument", () => {
    expect(completeModelArgument("/mode plan", models)).toBeNull();
    expect(completeModelArgument("/model", models)).toBeNull();
    expect(completeModelArgument("/model a b", models)).toBeNull();
    expect(completeModelArgument("switch the model", models)).toBeNull();
  });

  it("offers only what the session can switch to", () => {
    // An unconfigured provider's model completing is a completion that produces a failing command,
    // which is worse than none: the user has been told the name is right.
    expect(completeInput("/model gpt", [], ["claude-opus-5"])[0]).toEqual([]);
  });

  it("falls back to command completion when no models are known", () => {
    expect(completeInput("/mod", [], [])[0]).toEqual(expect.arrayContaining(["/model", "/models"]));
  });
});

describe("what the suggestion dropdown offers", () => {
  const models = ["claude-sonnet-5", "claude-opus-5"];

  it("offers the commands sharing the prefix being typed", () => {
    expect(suggestionsFor("/mod").map((entry) => entry.command)).toEqual(["/mode", "/models", "/model"]);
  });

  it("stops once the name is complete and nothing else shares it", () => {
    // A list hanging over a decision already made is a menu in the way, not a hint. `/model` is
    // not that case: `/models` is a real other command, and hiding it would hide a live choice.
    expect(suggestionsFor("/diff")).toEqual([]);
    expect(suggestionsFor("/model", models).map((entry) => entry.command)).toEqual(["/models", "/model"]);
  });

  it("switches to models once the command takes an argument", () => {
    expect(suggestionsFor("/model op", models).map((entry) => entry.command)).toEqual(["claude-opus-5"]);
    expect(suggestionsFor("/model ", models)).toHaveLength(2);
    expect(suggestionsFor("/model claude-opus-5", models)).toEqual([]);
  });

  it("stays out of ordinary prose, including lines containing a path", () => {
    // A "/" mid-sentence is a path or a date; the dropdown must not appear over a normal message.
    expect(suggestionsFor("check /home/me/notes.txt")).toEqual([]);
    expect(suggestionsFor("")).toEqual([]);
    expect(suggestionsFor("fix the tests")).toEqual([]);
  });

  it("offers nothing for a command name that does not exist", () => {
    expect(suggestionsFor("/zzz")).toEqual([]);
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

describe("inlineCompletion", () => {
  it("completes a unique prefix to the whole command", () => {
    expect(inlineCompletion("/def")).toEqual({ suffix: "ender", alternatives: 0 });
    expect(inlineCompletion("/hel")).toEqual({ suffix: "p", alternatives: 0 });
  });

  it("offers the shortest match when several are possible, and says how many others there were", () => {
    // /mod prefixes /mode, /model and /models. The shortest is the least presumptuous guess: one
    // more keystroke reaches either of the others, where completing straight to /models would have
    // to be undone to get back to /mode.
    expect(inlineCompletion("/mod")).toEqual({ suffix: "e", alternatives: 2 });
  });

  it("offers nothing once the command is complete, so a finished word is not decorated", () => {
    expect(inlineCompletion("/help")).toEqual({ suffix: "", alternatives: 0 });
    expect(inlineCompletion("/cost")).toEqual({ suffix: "", alternatives: 0 });
  });

  it("offers nothing for a bare slash or for something that matches no command", () => {
    expect(inlineCompletion("/")).toEqual({ suffix: "", alternatives: 0 });
    expect(inlineCompletion("/zzz")).toEqual({ suffix: "", alternatives: 0 });
  });

  it("stays out of ordinary prose, including a sentence that happens to contain a slash", () => {
    expect(inlineCompletion("fix the bug")).toEqual({ suffix: "", alternatives: 0 });
    expect(inlineCompletion("look at src/mod")).toEqual({ suffix: "", alternatives: 0 });
  });

  it("completes a model id after /model, against the models actually available", () => {
    const models = ["claude-sonnet-5", "claude-sonnet-5-mini", "gpt-5.6-terra"];
    expect(inlineCompletion("/model claude-son", models)).toEqual({ suffix: "net-5", alternatives: 1 });
    expect(inlineCompletion("/model gpt", models)).toEqual({ suffix: "-5.6-terra", alternatives: 0 });
  });

  it("offers nothing for a model argument that is already whole, or matches nothing", () => {
    const models = ["claude-sonnet-5"];
    expect(inlineCompletion("/model claude-sonnet-5", models)).toEqual({ suffix: "", alternatives: 0 });
    expect(inlineCompletion("/model zzz", models)).toEqual({ suffix: "", alternatives: 0 });
  });

  it("never offers a suffix that does not actually finish a real command", () => {
    // Whatever it proposes, typed-plus-suffix has to be a command that exists — otherwise pressing
    // right arrow would produce something the parser rejects.
    const names = new Set<string>(COMMANDS.map((command) => command.name));
    for (const command of COMMANDS) {
      for (let length = 2; length < command.name.length; length += 1) {
        const typed = command.name.slice(0, length);
        const { suffix } = inlineCompletion(typed);
        if (suffix !== "") expect(names.has(typed + suffix), `${typed} -> ${typed}${suffix}`).toBe(true);
      }
    }
  });
});
