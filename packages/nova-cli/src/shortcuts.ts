import type { Interface } from "node:readline/promises";
import { KeyBindingRegistry, type KeypressEvent } from "./keybindings";
import { paletteEntries, runCommandPalette, type PaletteKey } from "./palette";

/**
 * Where feature keys meet the terminal.
 *
 * Everything a key does, it does by submitting a slash command — the same string the user could
 * have typed. That keeps one execution path for every feature: a shortcut cannot drift from the
 * command it stands for, because it *is* the command, and a terminal that eats the key has lost
 * only the shortcut.
 */

export type ShortcutHost = {
  readline: Interface;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  registry: KeyBindingRegistry;
  /**
   * First refusal on a matched command, for the one case plain submission cannot cover: a turn is
   * already running, so there is no pending `readline.question()` to submit into — text written to
   * the line buffer now would just sit there and be read as the *next* prompt once the turn ends,
   * not act on the turn in progress. Returning `true` claims the key; `false` (or omitting the
   * hook) falls through to the ordinary submit-as-if-typed path.
   */
  onIntercept?: (command: string) => boolean;
};

/** Replaces whatever is on the line and submits, so a key works mid-typing without appending to it. */
function submit(readline: Interface, command: string): void {
  readline.write(null, { ctrl: true, name: "u" });
  readline.write(command);
  if (!command.endsWith(" ")) readline.write(null, { name: "return" });
}

/**
 * Paints over its own previous frame.
 *
 * Small enough not to be worth `ReplaceableBlock`, which is built for lines interleaved with a
 * running transcript; the palette owns the bottom of the screen for as long as it is open.
 */
function painter(output: NodeJS.WriteStream): (frame: string) => void {
  let rows = 0;
  return (frame) => {
    for (let row = 0; row < rows; row += 1) output.write("\x1b[1A\x1b[2K");
    output.write("\r");
    output.write(`${frame}\n`);
    rows = frame.split("\n").length;
  };
}

/**
 * Runs the palette with the terminal to itself.
 *
 * `readline` is listening for the same keypresses and would treat them as line editing — Up would
 * recall history instead of moving the selection. Detaching its listener for the duration is the
 * narrow way to borrow the keyboard; restoring in `finally` is what keeps a thrown error from
 * leaving the prompt permanently deaf.
 */
export async function openPalette(host: ShortcutHost, self?: unknown): Promise<string | undefined> {
  const borrowed = host.input.listeners("keypress").filter((listener) => listener !== self);
  for (const listener of borrowed) host.input.off("keypress", listener as never);

  const pending: PaletteKey[] = [];
  let wake: (() => void) | undefined;
  const collect = (str: string | undefined, key: KeypressEvent) => {
    pending.push({ ...(str === undefined ? {} : { str }), key: key ?? {} });
    wake?.();
  };
  host.input.on("keypress", collect);

  async function* keys(): AsyncGenerator<PaletteKey> {
    for (;;) {
      while (pending.length > 0) yield pending.shift()!;
      await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
    }
  }

  const paint = painter(host.output);
  try {
    const chords = Object.fromEntries(host.registry.bindings.map((binding) => [binding.command, formatBinding(binding.chord)]));
    return await runCommandPalette(keys(), paletteEntries(chords), paint);
  } finally {
    host.input.off("keypress", collect);
    for (const listener of borrowed) host.input.on("keypress", listener as never);
  }
}

function formatBinding(chord: { key: string; ctrl: boolean; shift: boolean; meta: boolean }): string {
  const key = /^f\d+$/.test(chord.key) ? chord.key.toUpperCase() : chord.key.toUpperCase();
  return `${chord.ctrl ? "Ctrl+" : ""}${chord.meta ? "Alt+" : ""}${chord.shift ? "Shift+" : ""}${key}`;
}

/**
 * Starts listening for feature keys. Returns the teardown, which must run before exit or the
 * listener keeps the process alive with a handle on stdin.
 */
export function installShortcuts(host: ShortcutHost): () => void {
  let busy = false;
  const onKeypress = (_str: string | undefined, key: KeypressEvent) => {
    if (busy || !key) return;
    const command = host.registry.match(key);
    if (!command) return;
    if (host.onIntercept?.(command)) return;
    if (command !== "/palette") {
      submit(host.readline, command);
      return;
    }
    busy = true;
    void openPalette(host, onKeypress as never)
      .then((chosen) => { if (chosen) submit(host.readline, chosen); })
      .finally(() => {
        busy = false;
        host.readline.prompt(true);
      });
  };

  host.input.on("keypress", onKeypress);
  return () => host.input.off("keypress", onKeypress);
}
