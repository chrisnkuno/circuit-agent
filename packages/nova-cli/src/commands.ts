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
  "/plan": { description: "Switch to plan mode — read and reason, no writes" },
  "/build": { description: "Switch to build mode — edits need approval" },
  "/auto": { description: "Switch to auto mode — edits apply without approval" },
  "/model": { args: "[provider] [model]", description: "Switch model mid-session, keeping the transcript" },
  "/undo": { description: "Revert the last turn's changes" },
  "/diff": { description: "What changed since the last checkpoint" },
  "/todos": { description: "The agent's current plan" },
  "/clear": { description: "Start a fresh thread" },
  "/pull": { args: "[dir]", description: "Copy sandbox files here" },
  "/where": { description: "Show the current workspace" },
  "/providers": { description: "Which model providers are configured" },
  "/cost": { description: "Token and cost breakdown for this session" },
  "/sessions": { description: "List sessions in this project" },
  "/keys": { description: "Keyboard shortcuts" },
  "/help": { description: "This list" },
  "/exit": { description: "Leave" },
});

/** Renders `/help` from the same table `completer` reads, so they cannot disagree. */
export function renderCommandHelp(): string {
  const width = Math.max(...COMMANDS.map((command) => command.name.length + (command.args ? command.args.length + 1 : 0)));
  return COMMANDS.map((command) => {
    const head = command.args ? `${command.name} ${command.args}` : command.name;
    return `  ${head.padEnd(width + 2)}${command.description}`;
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
export function completeInput(line: string, files: readonly string[] = []): [string[], string] {
  return completeFileMention(line, files) ?? completeCommand(line);
}

export function isKnownCommand(name: string): boolean {
  return COMMANDS.some((command) => command.name === name);
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

export const KEYBOARD_SHORTCUTS = [
  ["Tab", "Complete a slash command"],
  ["Ctrl-C", "Interrupt the current turn"],
  ["Up / Down", "Previous / next input"],
] as const;

export function renderKeyboardShortcuts(): string {
  const width = Math.max(...KEYBOARD_SHORTCUTS.map(([key]) => key.length));
  return KEYBOARD_SHORTCUTS.map(([key, description]) => `  ${key.padEnd(width + 2)}${description}`).join("\n");
}
