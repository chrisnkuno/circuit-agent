import { commandDescription, keyboardDescription, type ControlLanguage } from "./i18n";

/**
 * The slash-command registry.
 *
 * A table rather than an `if` chain for two reasons: `/help` is generated from it, so the two
 * cannot drift apart the way a hand-maintained help string can; and `node:readline`'s `completer`
 * option can walk it directly, which is what gives Tab-completion on "/" for free.
 */

export type CommandContext = Record<string, never>;

export type Command = {
  name: string;
  /** Shown after the name in `/help`, e.g. "[dir]" for `/pull [dir]`. Omit for no-argument commands. */
  args?: string;
  description: string;
};

export function defineCommands<T extends Record<string, Omit<Command, "name">>>(table: T): (Command & { name: keyof T & string })[] {
  return Object.entries(table).map(([name, command]) => ({ name, ...command }));
}

export const COMMANDS = defineCommands({
  "/mode": { args: "[plan|build|auto|defender]", description: "Show or switch the permission mode" },
  "/plan": { description: "Switch to plan mode — read and reason, no writes" },
  "/build": { description: "Switch to build mode — edits need approval" },
  "/auto": { description: "Auto-apply ordinary edits; sensitive actions still ask" },
  "/defender": { description: "Switch to defender mode — find and fix real security issues, every change still asks" },
  "/models": { args: "[refresh]", description: "Every model each provider actually offers, with prices — or add a key for one you can't use yet" },
  "/model": { args: "[name | N | provider model]", description: "Open the model picker, or switch straight to a name, keeping the transcript" },
  "/fallback": { args: "[off|ask|provider:model]", description: "Opt into a safe alternate model after transient provider failures" },
  "/undo": { args: "[code|conversation]", description: "Revert the last turn — files, the conversation, or both (default)" },
  "/retry": { description: "Repeat the last failed request only when no tool or file change already happened" },
  "/continue": { description: "Resume an interrupted or incomplete task from its current workspace state" },
  "/diff": { description: "What changed since the last checkpoint" },
  "/todos": { description: "The agent's current plan" },
  "/clear": { description: "Start a fresh thread" },
  "/memory": { args: "[add|replace|recall|forget]", description: "Bounded, relevant memory across sessions — # <fact> remembers for this project" },
  "/history": { args: "[<id> | search <text> | resume | status]", description: "Browse, search or pick up durable conversation history" },
  "/export": { args: "[markdown|json|support]", description: "Write a redacted session transcript or compact support artifact" },
  "/expand": { args: "[N | all | list]", description: "Show a folded block — written code, a test run, a long result — in full" },
  "/slow": { args: "[on|strict|off]", description: "Spend at a slower pace: fewer model rounds, smaller replies, a pause between turns" },
  "/workspace": { description: "Open the control panel: every tab and watched job, live, on one screen" },
  "/watch": { args: "[id|show <id>|stop <id>]", description: "Follow a background job's output without giving up the prompt" },
  "/theme": { args: "[name|list|where]", description: "Change the colours — starry-night, starry-dawn, nebula, high-contrast, or a .tss file of your own" },
  "/tab": { args: "[new|next|prev|close|rename|N]", description: "Several pieces of work, one at a time — only the tab in front runs (/detach for parallel)" },
  "/pull": { args: "[dir]", description: "Copy sandbox files here" },
  "/where": { description: "Show the current workspace" },
  "/tools": { description: "What the agent can call, and which skills, plugins, MCP servers or hooks a project added" },
  "/providers": { description: "Which model providers are configured" },
  "/settings": { description: "Configure API keys, URLs, models and voice input" },
  "/update": { args: "[auto|check|off]", description: "Update Nova now, or choose whether it updates itself" },
  "/voice": { args: "[audio-file]", description: "Record or transcribe an editable voice prompt" },
  "/wander": { args: "[topic|random|daily|weekly]", description: "Run a bounded research lab and grade what it finds" },
  "/jobs": { args: "[run|cancel|approve]", description: "Durable background work: list, start, cancel, or answer" },
  "/attach": { args: "<id>", description: "Watch a background job's log live" },
  "/detach": { args: "<task>", description: "Start work in the background; press Alt+B to send a running turn there" },
  "/cost": { description: "Token and cost breakdown for this session" },
  "/balance": { args: "[amount|clear]", description: "Set an account balance and track it locally from token costs" },
  "/pay": { args: "[amount|balance|status <ref>]", description: "Top up your Nova credit — pay on Circuit Pay's page, Nova never sees your card" },
  "/scan": { args: "[glob]", description: "Deterministic secret scan of the workspace, worst severity first — no model turn needed" },
  "/sessions": { description: "List sessions in this project (an alias for /history)" },
  "/palette": { description: "Search every command by name or by what it does" },
  "/keys": { description: "Every shortcut in full, plus line-editing keys and which chords this terminal may not deliver — /help lists them inline, next to each command" },
  "/guide": { args: "[topic|search <text>|all]", description: "The user guide, as a screen you can browse — or print one topic with /guide <topic>" },
  "/files": { description: "Browse the project tree — expand folders, preview a file, pick one to @mention" },
  "/edit": { args: "<path>", description: "Open a file in the built-in editor — through the workspace, so it works in a sandbox too" },
  "/help": { args: "[all|work|review|steer|parallel|learn|setup]", description: "Commands grouped by purpose" },
  "/exit": { description: "Leave" },
});

/**
 * Renders `/help` from the same table `completer` reads, so they cannot disagree.
 *
 * `shortcuts` (command name → chord label, e.g. `"F2"` or `"F3, Alt+M"`) merges in what used to be
 * a second lookup in `/keys` for the commands that have one: `keybindings.ts`'s
 * `KeyBindingRegistry.shortcutLabels()` is the source, kept optional here so this stays callable —
 * and testable — without constructing a whole registry.
 */
/**
 * The whole catalog, one row each — for `nova --help`, which is read piped and grepped as often
 * as it is read on screen.
 *
 * `mark` puts a leading character on the rows worth learning first. It is a parameter rather than
 * a hardcoded glyph because this same text is written to a pipe, where a star may not survive the
 * destination's encoding — the caller already knows whether this terminal can draw one.
 */
export function renderCommandHelp(
  language: ControlLanguage = "en",
  shortcuts: ReadonlyMap<string, string> = new Map(),
  options: { mark?: (command: string) => string } = {},
): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length + (command.args ? command.args.length + 1 : 0)));
  const shortcutWidth = Math.max(0, ...[...shortcuts.values()].map((label) => label.length));
  const mark = options.mark ?? (() => "  ");
  return COMMANDS.map((command) => {
    const head = command.args ? `${command.name} ${command.args}` : command.name;
    const shortcut = shortcuts.get(command.name) ?? "";
    const shortcutColumn = shortcutWidth > 0 ? shortcut.padEnd(shortcutWidth + 2) : "";
    return `${mark(command.name)}${head.padEnd(width + 2)}${shortcutColumn}${commandDescription(language, command.name, command.description)}`;
  }).join("\n");
}

/**
 * `readline`'s `completer(line)` contract: returns `[matches, matchedPortion]`. Only completes
 * when the line looks like the start of a command — typing prose that happens to contain "/" (a
 * file path in a request) should not suddenly offer command completions.
 */
export function completeCommand(line: string): [string[], string] {
  if (!line.startsWith("/")) return [[], line];
  const matches = COMMANDS.map((command) => command.name).filter((name) => name.startsWith(line));
  return [matches, line];
}

/**
 * Completes the argument to `/model` against the models this session can actually switch to.
 *
 * Only configured models are offered, for the same reason the menu only lists them: a completion
 * that produces a command which then fails is worse than no completion, because the user has been
 * told the name is right. Matching is substring rather than prefix — model ids are front-loaded
 * with vendor prefixes (`claude-`, `gpt-`), so prefix-only completion would mean typing the least
 * distinguishing part of the name before getting any help with the part that matters.
 */
export function completeModelArgument(line: string, models: readonly string[]): [string[], string] | null {
  const match = /^(\/models?\s+)(\S*)$/.exec(line);
  if (!match) return null;
  const fragment = match[2].toLowerCase();
  const prefixed = models.filter((model) => model.toLowerCase().startsWith(fragment));
  const contained = fragment === ""
    ? []
    : models.filter((model) => !model.toLowerCase().startsWith(fragment) && model.toLowerCase().includes(fragment));
  return [[...prefixed, ...contained].map((model) => `${match[1]}${model}`), line];
}

/** The `@path` fragment being typed at the end of a line, if there is one. */
const MENTION = /(^|\s)@([^\s]*)$/;

/**
 * Completes an `@path` mention against the project's files.
 *
 * Prefix matches come first and substring matches after, so `@app` still finds `src/app.ts` while
 * `@src/` still lists that directory first. The point is not typing speed — it is that a path the
 * agent is given is a path that exists, instead of one the model has to discover was a typo.
 */
export function completeFileMention(line: string, files: readonly string[]): [string[], string] | null {
  const match = MENTION.exec(line);
  if (!match) return null;
  const fragment = match[2].toLowerCase();
  const prefixed = files.filter((file) => file.toLowerCase().startsWith(fragment));
  const contained = fragment === ""
    ? []
    : files.filter((file) => !file.toLowerCase().startsWith(fragment) && file.toLowerCase().includes(fragment));
  return [[...prefixed, ...contained].slice(0, 50).map((file) => `@${file}`), `@${match[2]}`];
}

/** The completer readline is given: commands at the start of a line, file mentions anywhere in it. */
export function completeInput(line: string, files: readonly string[] = [], models: readonly string[] = []): [string[], string] {
  return completeFileMention(line, files) ?? completeModelArgument(line, models) ?? completeCommand(line);
}

/**
 * The suggestions to show for a line being typed, best match first.
 *
 * Only for a line that is *becoming* a command: it must start with "/" and still be one word, so
 * the list appears while a name is being chosen and gets out of the way the moment the user moves
 * on to arguments. An exact, complete command name suggests nothing either — by then the list has
 * said everything it can, and leaving it up is a menu hanging over a decision already made.
 */
export function suggestionsFor(line: string, models: readonly string[] = []): { command: string; args?: string; description: string }[] {
  const model = /^\/models?\s+(\S*)$/.exec(line);
  if (model) {
    const fragment = model[1].toLowerCase();
    const matched = models.filter((id) => id.toLowerCase().includes(fragment));
    return matched.length === 1 && matched[0].toLowerCase() === fragment
      ? []
      : matched.map((id) => ({ command: id, description: "" }));
  }
  if (!/^\/\S*$/.test(line)) return [];
  const matches = COMMANDS.filter((command) => command.name.startsWith(line));
  if (matches.length === 1 && matches[0].name === line) return [];
  return matches.map((command) => ({ command: command.name, ...(command.args ? { args: command.args } : {}), description: command.description }));
}

/**
 * The rest of the word, for the greyed-out completion shown after the cursor as you type.
 *
 * Search-engine behaviour, and deliberately *not* the reserved-row dropdown this replaces. That
 * dropdown needed rows of its own, and rows have to be taken from the transcript by scrolling it —
 * which is destructive, and was being done to the very rows the input bar draws on. Ghost text
 * costs no rows at all: it is painted after the cursor on a line readline is already redrawing, so
 * there is nothing to reserve and nothing to give back.
 *
 * The shortest match wins when several are possible, because it is the least presumptuous guess —
 * typing `/mod` offers `/mode` rather than reaching past it for `/models`, and one more keystroke
 * gets you either. `alternatives` is how many others were also possible, so the caller can say so
 * rather than implying the offer is the only answer.
 */
export function inlineCompletion(line: string, models: readonly string[] = []): { suffix: string; alternatives: number } {
  const none = { suffix: "", alternatives: 0 };
  const model = /^(\/models?\s+)(\S+)$/.exec(line);
  if (model) {
    const fragment = model[2].toLowerCase();
    const matched = models.filter((id) => id.toLowerCase().startsWith(fragment)).sort((a, b) => a.length - b.length);
    if (matched.length === 0 || matched[0].length === fragment.length) return none;
    return { suffix: matched[0].slice(model[2].length), alternatives: matched.length - 1 };
  }
  // Only while the line is a bare command word. Once it has an argument the completion belongs to
  // that argument, and guessing at the command again would offer to rewrite what was already typed.
  if (!/^\/\S*$/.test(line) || line === "/") return none;
  const matched = COMMANDS.map((command) => command.name)
    .filter((name) => name.startsWith(line))
    .sort((left, right) => left.length - right.length);
  if (matched.length === 0 || matched[0] === line) return none;
  return { suffix: matched[0].slice(line.length), alternatives: matched.length - 1 };
}

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((command) => command.name === name);
}

export type ModeCommand = { type: "show" } | { type: "switch"; mode: "plan" | "build" | "auto" | "defender" } | { type: "invalid" };

const MODE_NAMES = ["plan", "build", "auto", "defender"] as const;
type ModeName = (typeof MODE_NAMES)[number];
function isModeName(value: string): value is ModeName {
  return (MODE_NAMES as readonly string[]).includes(value);
}

/** Stable mode command grammar shared by the TUI and its tests. */
export function parseModeCommand(input: string): ModeCommand | null {
  const bareModeCommand = input.startsWith("/") ? input.slice(1) : "";
  if (isModeName(bareModeCommand)) return { type: "switch", mode: bareModeCommand };
  const match = /^\/mode(?:\s+(\S+))?$/.exec(input);
  if (!match) return null;
  if (!match[1]) return { type: "show" };
  return isModeName(match[1]) ? { type: "switch", mode: match[1] } : { type: "invalid" };
}

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_unused, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const candidate = Math.min(
        previous[column] + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = previous[column];
      previous[column] = candidate;
    }
  }
  return previous[right.length];
}

/**
 * The command a mistyped one probably meant.
 *
 * Without this, `/tood` is not an error at all — it is silently sent to the model as a request,
 * which costs a round trip to be told it makes no sense.
 */
export function suggestCommand(name: string): string | undefined {
  const ranked = COMMANDS
    .map((command) => ({ name: command.name, distance: editDistance(name, command.name) }))
    .sort((left, right) => left.distance - right.distance);
  const best = ranked[0];
  // Two edits is the point past which a suggestion is a guess rather than a correction.
  return best && best.distance <= 2 ? best.name : undefined;
}

/** Each row carries the id its translation is looked up by, so the order here is free to change. */
export const KEYBOARD_SHORTCUTS = [
  ["menu-move", "↑ / ↓", "Move through any menu — settings, models, the palette"],
  ["menu-number", "1-9", "Jump straight to a numbered row in a menu"],
  ["menu-take", "Enter / Esc", "Take the highlighted row / leave the menu"],
  ["complete-command", "Tab", "Complete a slash command"],
  ["complete-path", "@ + path", "Complete a project file mention"],
  ["history", "Up / Down", "Search persistent prompt history"],
  // Home/End and Alt-Backspace rather than Ctrl-A and Ctrl-W: those two belong to the Ctrl layer
  // now (/auto and /wander), and readline handles these natively, so the function never actually
  // moved out of reach. `KeyBindingRegistry.render()` prints the same relocation beside the chord
  // that took it; this row is the other half of it, for someone reading the editing keys rather
  // than the feature keys. The translated descriptions are untouched because they are still true.
  ["line-ends", "Home / End", "Move to the start / end of the input"],
  ["delete", "Alt-Backspace / Ctrl-U", "Delete the previous word / whole input"],
  ["clear", "Ctrl-L", "Clear and redraw the terminal"],
  ["interrupt", "Ctrl-C", "Interrupt the current turn"],
  ["voice", "/voice", "Record a prompt from the microphone"],
  ["expand", "Ctrl-O", "Unfold the most recent folded block"],
  ["memory", "# fact", "Remember a fact for every future session in this project"],
] as const;

export function renderKeyboardShortcuts(language: ControlLanguage = "en"): string {
  const width = Math.max(...KEYBOARD_SHORTCUTS.map(([, key]) => key.length));
  return KEYBOARD_SHORTCUTS.map(([id, key, description]) => `  ${key.padEnd(width + 2)}${keyboardDescription(language, id, description)}`).join("\n");
}
