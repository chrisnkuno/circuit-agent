import { COMMANDS } from "./commands";

/**
 * Feature keys, and the line-editing keys they must not eat.
 *
 * The listed shortcuts used to be documentation: almost every one was a `node:readline` default
 * that worked whether or not anything wrote it down. This is the registry that makes the rest real
 * — a chord is bound to a command, conflicts are refused rather than silently resolved, and
 * anything the terminal will not deliver still has a way to be invoked.
 *
 * The binding target is always a slash command, never a private handler. That is what makes the
 * fallback automatic: a terminal that swallows F4 has not lost the feature, because `/wander` still
 * runs it, and there is no second code path that could drift from the one the key triggers.
 */

export type Chord = {
  /** Normalised key name: a single lowercase character, or "f1".."f12", "tab", "enter", "escape". */
  key: string;
  ctrl: boolean;
  shift: boolean;
  /** Alt/Option. Reported by terminals as a meta prefix. */
  meta: boolean;
};

const FUNCTION_KEY = /^f([1-9]|1[0-2])$/;
const NAMED_KEYS = new Set(["tab", "enter", "escape", "space", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "backspace", "delete"]);

function isKeyName(value: string): boolean {
  return value.length === 1 || FUNCTION_KEY.test(value) || NAMED_KEYS.has(value);
}

/** Canonical, comparable form — modifiers in a fixed order so two spellings of one chord match. */
export function chordId(chord: Chord): string {
  return `${chord.ctrl ? "ctrl+" : ""}${chord.meta ? "alt+" : ""}${chord.shift ? "shift+" : ""}${chord.key}`;
}

/** Parses "ctrl+shift+tab", "F4", "alt+p". Returns undefined rather than a partly-understood chord. */
export function parseChord(input: string): Chord | undefined {
  const parts = input.trim().toLowerCase().split("+").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return undefined;
  const key = parts[parts.length - 1];
  if (!isKeyName(key)) return undefined;
  const chord: Chord = { key, ctrl: false, shift: false, meta: false };
  for (const modifier of parts.slice(0, -1)) {
    if (modifier === "ctrl" || modifier === "control") chord.ctrl = true;
    else if (modifier === "shift") chord.shift = true;
    else if (modifier === "alt" || modifier === "meta" || modifier === "option") chord.meta = true;
    else return undefined;
  }
  return chord;
}

export function formatChord(chord: Chord): string {
  const key = FUNCTION_KEY.test(chord.key) ? chord.key.toUpperCase() : chord.key.length === 1 ? chord.key.toUpperCase() : chord.key.replace(/^./, (first) => first.toUpperCase());
  return `${chord.ctrl ? "Ctrl+" : ""}${chord.meta ? "Alt+" : ""}${chord.shift ? "Shift+" : ""}${key}`;
}

/** The shape `node:readline` emits on its `keypress` event. */
export type KeypressEvent = { name?: string; ctrl?: boolean; shift?: boolean; meta?: boolean; sequence?: string };

export function chordFromKeypress(key: KeypressEvent): Chord | undefined {
  const name = key.name?.toLowerCase();
  if (!name || !isKeyName(name)) return undefined;
  return { key: name, ctrl: Boolean(key.ctrl), shift: Boolean(key.shift), meta: Boolean(key.meta) };
}

/**
 * Chords `node:readline` already owns, and what it does with them.
 *
 * This list is why the registry refuses rather than warns. Every one of these is a line-editing
 * action people use without thinking, and a feature key layered on top does not shadow it cleanly —
 * it breaks editing in a way that looks like the terminal is broken. Notably `ctrl+k` (kill to end
 * of line) and `ctrl+t` (transpose characters) are both taken, which rules out the two chords that
 * read as the obvious defaults for a palette and a new tab.
 */
export const RESERVED_CHORDS: Readonly<Record<string, string>> = {
  "ctrl+a": "move to start of line",
  "ctrl+b": "move back one character",
  "ctrl+c": "interrupt the current turn",
  "ctrl+d": "end of input",
  "ctrl+e": "move to end of line",
  "ctrl+f": "move forward one character",
  "ctrl+h": "delete the previous character",
  "ctrl+k": "delete to end of line",
  "ctrl+l": "clear and redraw",
  "ctrl+n": "next history entry",
  "ctrl+p": "previous history entry",
  "ctrl+r": "reverse history search",
  "ctrl+t": "transpose characters",
  "ctrl+u": "delete to start of line",
  "ctrl+w": "delete the previous word",
  "ctrl+y": "yank",
  "ctrl+z": "suspend",
  tab: "complete a command or file mention",
  enter: "submit",
  up: "previous history entry",
  down: "next history entry",
};

export type KeyBinding = {
  /** The slash command this runs, and the identity used when overriding it. */
  command: string;
  chord: Chord;
  description: string;
};

/**
 * Defaults, chosen from what is actually free.
 *
 * Function keys and `Ctrl+G` are the usable space once line editing has taken the Ctrl+letter
 * range; `Ctrl+G` is the one Ctrl chord `node:readline` leaves unbound. Nothing here is essential —
 * each is a shortcut to a command that can always be typed.
 */
/**
 * Why a command may hold several chords, and why the letters are on Alt.
 *
 * A bare letter cannot be a shortcut at this prompt. The prompt is where free text is typed, so
 * binding `w` to `/wander` costs you every message beginning with "write" — and restricting it to
 * an empty line does not help, because an empty line is exactly where "write a test" starts. Alt
 * keeps the mnemonic ("w for wander" is Alt+W) while leaving every letter typeable, and it is the
 * range this file already uses for `/detach` and the tab keys.
 *
 * The F-keys stay alongside them rather than being replaced: they are already documented, some
 * people have learned them, and a terminal that swallows Alt is a different terminal from one that
 * swallows F4 — two routes to the same command means a terminal has to break both to lose it.
 */
export const DEFAULT_BINDINGS: readonly { command: string; chords: readonly string[]; description: string }[] = [
  { command: "/palette", chords: ["ctrl+g"], description: "Open the command palette" },
  { command: "/help", chords: ["f1", "alt+h"], description: "Command list" },
  { command: "/mode", chords: ["f2"], description: "Show or switch the permission mode" },
  { command: "/model", chords: ["f3", "alt+m"], description: "Switch model mid-session" },
  { command: "/wander", chords: ["f4", "alt+w"], description: "Run a bounded research exploration" },
  { command: "/jobs", chords: ["f6"], description: "Background and detached work" },
  { command: "/diff", chords: ["f8", "alt+d"], description: "What changed since the last checkpoint" },
  { command: "/todos", chords: ["f9"], description: "The agent's current plan" },
  { command: "/auto", chords: ["alt+a"], description: "Auto mode: ordinary edits apply" },
  { command: "/plan", chords: ["alt+p"], description: "Plan mode: read and reason, never write" },
  { command: "/undo", chords: ["alt+u"], description: "Revert the last turn" },
  { command: "/cost", chords: ["alt+c"], description: "Token and cost breakdown" },
  { command: "/tools", chords: ["alt+o"], description: "What the agent can call, and where it came from" },
  // Ctrl+Tab is the conventional tab switcher and is unusable here twice over: terminals rarely
  // transmit it, and Tab itself is completion. Alt+arrows are delivered widely and free.
  { command: "/tab new", chords: ["alt+t"], description: "Open another tab" },
  { command: "/tab next", chords: ["alt+right"], description: "Next tab" },
  { command: "/tab prev", chords: ["alt+left"], description: "Previous tab" },
  // Ctrl+B is line editing (move back one character); Alt+B is free and mnemonic ("background").
  // This is the one binding that does not merely submit its command as typed text — the whole
  // point is firing while a turn is already running, where there is no prompt to submit into.
  // It keeps Alt+B for that reason, which is why `/build` has no letter of its own: the mode it
  // switches to is one keypress away on F2, and a shortcut that can only be reached by typing is
  // not worth taking the one shortcut that cannot.
  { command: "/detach", chords: ["alt+b"], description: "Send the running turn to the background" },
];

/**
 * Parses `NOVA_KEYS`, e.g. `"/diff=alt+d, /wander=off"`.
 *
 * A flat string rather than nested configuration because that is what the settings file already
 * stores and what an environment variable can carry — one shape for both, instead of a schema that
 * only one of them can express.
 */
export function parseBindingOverrides(spec: string | undefined): BindingOverrides {
  const overrides: Record<string, string> = {};
  for (const clause of (spec ?? "").split(/[,\n]/)) {
    const [command, chord] = clause.split("=");
    if (command?.trim() && chord?.trim()) overrides[command.trim()] = chord.trim();
  }
  return overrides;
}

export type BindingConflict = { command: string; chord: string; reason: string };

export type BindingResolution = {
  bindings: KeyBinding[];
  /** Bindings that were dropped, and why — surfaced rather than silently discarded. */
  conflicts: BindingConflict[];
};

/**
 * Overrides, as `command -> chord`. `"off"` unbinds without having to find a spare chord to park
 * a command on, which is the only honest way to say "I never want this key to fire".
 */
export type BindingOverrides = Readonly<Record<string, string>>;

/**
 * Builds the active binding table.
 *
 * Keyed by command rather than by chord because that is the direction a person edits in — they want
 * `/diff` on a different key, not to discover what F8 currently does. A rejected binding is
 * reported, never dropped quietly: a shortcut that does nothing and says nothing is worse than one
 * that was refused with a reason.
 */
export function resolveBindings(overrides: BindingOverrides = {}, options: { commands?: readonly string[] } = {}): BindingResolution {
  const known = new Set(options.commands ?? [...COMMANDS.map((command) => command.name), "/palette"]);
  const bindings: KeyBinding[] = [];
  const conflicts: BindingConflict[] = [];
  const taken = new Map<string, string>();

  const defaults = new Map(DEFAULT_BINDINGS.map((binding) => [binding.command, binding]));
  const commands = [...new Set([...defaults.keys(), ...Object.keys(overrides)])];

  for (const command of commands) {
    const fallback = defaults.get(command);
    // An override names one key and means exactly that key: it replaces every default chord for
    // the command rather than adding to them, so "I want /diff on Alt+X" does not silently leave
    // F8 live as well.
    const override = overrides[command];
    const requestedChords = override !== undefined ? [override] : fallback?.chords ?? [];
    if (requestedChords.length === 0) continue;
    if (override !== undefined && override.trim().toLowerCase() === "off") continue;

    const description = fallback?.description ?? COMMANDS.find((entry) => entry.name === command)?.description ?? command;
    for (const requested of requestedChords) {
      const chord = parseChord(requested);
      if (!chord) {
        conflicts.push({ command, chord: requested, reason: `not a key I understand — try "f4", "ctrl+g" or "alt+p"` });
        continue;
      }
      // A command that does not exist cannot be bound to. A typo in someone's configuration is worth
      // reporting at startup rather than on a key that does nothing; a *default* for a feature this
      // build does not ship is not their mistake, so it is skipped without noise.
      // A binding may carry arguments ("/tab next"); only the command itself has to exist.
      if (!known.has(command.split(/\s+/)[0])) {
        if (override !== undefined) conflicts.push({ command, chord: formatChord(chord), reason: "no such command" });
        continue;
      }
      const id = chordId(chord);
      const reserved = RESERVED_CHORDS[id];
      if (reserved) {
        conflicts.push({ command, chord: formatChord(chord), reason: `reserved for line editing (${reserved})` });
        continue;
      }
      const owner = taken.get(id);
      if (owner) {
        conflicts.push({ command, chord: formatChord(chord), reason: `already bound to ${owner}` });
        continue;
      }
      taken.set(id, command);
      bindings.push({ command, chord, description });
    }
  }

  return { bindings, conflicts };
}

/**
 * Whether this terminal can be trusted to deliver a chord.
 *
 * Function keys and modified Tab travel as escape sequences that plenty of terminals rewrite or
 * swallow — tmux, older Windows consoles, and anything that has claimed F-keys for its own menus.
 * There is no way to detect this reliably, so the registry does not pretend to: it marks the
 * doubtful ones so `/keys` can point at the slash command instead of leaving someone pressing a
 * key that will never arrive.
 */
export function isLikelyDeliverable(chord: Chord, environment: { TERM?: string; TERM_PROGRAM?: string; TMUX?: string; WT_SESSION?: string } = {}): boolean {
  if (environment.TERM === "dumb") return false;
  if (chord.key === "tab" && (chord.ctrl || chord.shift)) return false;
  if (FUNCTION_KEY.test(chord.key)) return !environment.TMUX;
  if (chord.meta) return !environment.TMUX;
  return true;
}

export class KeyBindingRegistry {
  private readonly byChord = new Map<string, KeyBinding>();
  readonly conflicts: readonly BindingConflict[];

  constructor(overrides: BindingOverrides = {}, private readonly environment: Record<string, string | undefined> = {}) {
    const resolved = resolveBindings(overrides);
    this.conflicts = resolved.conflicts;
    for (const binding of resolved.bindings) this.byChord.set(chordId(binding.chord), binding);
  }

  /** The command a keypress should run, or undefined to let readline handle the key as usual. */
  match(key: KeypressEvent): string | undefined {
    const chord = chordFromKeypress(key);
    return chord ? this.byChord.get(chordId(chord))?.command : undefined;
  }

  get bindings(): KeyBinding[] {
    return [...this.byChord.values()];
  }

  /**
   * The `/keys` view: what is bound, what line editing owns, and what this terminal may not deliver.
   */
  render(): string {
    // One row per command, not per chord: a command with two keys was printing two adjacent lines
    // with identical text, which reads as a duplicate rather than as a choice. `F1, Alt+H` says the
    // same thing in half the space and makes the alternative obvious.
    const byCommand = new Map<string, { chords: Chord[]; description: string }>();
    for (const binding of this.bindings) {
      const entry = byCommand.get(binding.command) ?? { chords: [], description: binding.description };
      entry.chords.push(binding.chord);
      byCommand.set(binding.command, entry);
    }
    const rows: [string, string][] = [...byCommand].map(([command, { chords, description }]) => {
      // Undeliverable chords are called out only when *every* route to the command is doubtful:
      // if F4 may not arrive but Alt+W will, the command is reachable and saying otherwise is noise.
      const deliverable = chords.some((chord) => isLikelyDeliverable(chord, this.environment));
      return [
        chords.map(formatChord).join(", "),
        deliverable ? `${description} (${command})` : `${description} — this terminal may not send it; use ${command}`,
      ];
    });
    // Line-editing keys are rendered by `renderKeyboardShortcuts`, which is translated. Repeating
    // them here would put an English-only copy of the same list one line below the translated one.
    const width = Math.max(16, ...rows.map(([key]) => key.length));
    const lines = ["Feature keys", ...rows.map(([key, label]) => `  ${key.padEnd(width + 2)}${label}`)];
    if (this.conflicts.length > 0) {
      lines.push("", "Not bound");
      for (const conflict of this.conflicts) lines.push(`  ${conflict.chord.padEnd(width + 2)}${conflict.command} — ${conflict.reason}`);
    }
    return lines.join("\n");
  }
}
