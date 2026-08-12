import type { Interface } from "node:readline/promises";
import { KeyBindingRegistry, type KeypressEvent } from "./keybindings";
import { paletteEntries, runCommandPalette, type PaletteKey, type RunPaletteOptions } from "./palette";
import { runModelPicker, type PickerResult, type RunModelPickerOptions } from "./model-picker";
import { runChooser, type ChooserItem, type ChooserPaint, type RunChooserOptions } from "./chooser";

/**
 * Where feature keys meet the terminal.
 *
 * Everything a key does, it does by submitting a slash command — the same string the user could
 * have typed. That keeps one execution path for every feature: a shortcut cannot drift from the
 * command it stands for, because it *is* the command, and a terminal that eats the key has lost
 * only the shortcut.
 */

/**
 * The minimum needed to take the keyboard for a moment: something to read, something to paint on,
 * and the readline to hand control back to. A plain menu needs no keybinding registry, and asking
 * for one would mean the settings menu could not open before shortcuts are installed.
 */
export type KeyboardHost = {
  readline: Interface;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
};

export type ShortcutHost = KeyboardHost & {
  registry: KeyBindingRegistry;
  /**
   * First refusal on a matched command, for the one case plain submission cannot cover: a turn is
   * already running, so there is no pending `readline.question()` to submit into — text written to
   * the line buffer now would just sit there and be read as the *next* prompt once the turn ends,
   * not act on the turn in progress. Returning `true` claims the key; `false` (or omitting the
   * hook) falls through to the ordinary submit-as-if-typed path.
   */
  onIntercept?: (command: string) => boolean;
  /**
   * Whether typing "/" should open the suggestion dropdown right now.
   *
   * The host owns this because the shortcut layer cannot tell a waiting prompt from a running turn:
   * the keypress listener stays attached either way, and an empty line during a turn looks exactly
   * like an empty line at the prompt. Opening a menu over a turn in progress would steal the
   * keyboard from a user who is trying to Ctrl-C it.
   */
  canSuggest?: () => boolean;
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
 * Runs a full-screen chooser with the terminal to itself.
 *
 * `readline` is listening for the same keypresses and would treat them as line editing — Up would
 * recall history instead of moving the selection. Detaching its listener for the duration is the
 * narrow way to borrow the keyboard; restoring in `finally` is what keeps a thrown error from
 * leaving the prompt permanently deaf.
 *
 * Shared by the palette and the model picker rather than written twice: the borrowing is the part
 * that is easy to get subtly wrong and impossible to notice until a prompt somewhere stops
 * responding, so there is one copy of it to be correct.
 */
export async function withBorrowedKeyboard<T>(
  host: KeyboardHost,
  self: unknown,
  body: (keys: AsyncIterable<PaletteKey>, paint: (frame: string) => void) => Promise<T>,
): Promise<T> {
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

  try {
    return await body(keys(), painter(host.output));
  } finally {
    host.input.off("keypress", collect);
    for (const listener of borrowed) host.input.on("keypress", listener as never);
  }
}

export async function openPalette(host: ShortcutHost, self?: unknown, options: RunPaletteOptions = {}): Promise<string | undefined> {
  const chords = Object.fromEntries(host.registry.bindings.map((binding) => [binding.command, formatBinding(binding.chord)]));
  return withBorrowedKeyboard(host, self, (keys, paint) => runCommandPalette(keys, paletteEntries(chords), paint, options));
}

/**
 * A generic list chooser over the borrowed keyboard — what `SettingsPrompts.choose` is wired to.
 *
 * Takes the host rather than a readline so every menu in the CLI reaches the terminal the same
 * way, and so a caller cannot accidentally leave readline listening underneath an open menu.
 */
export async function openChooser<T>(
  host: KeyboardHost,
  items: readonly ChooserItem<T>[],
  options: Omit<RunChooserOptions, "paint"> & { paint: ChooserPaint },
  self?: unknown,
): Promise<T | undefined> {
  return withBorrowedKeyboard(host, self, (keys, paint) => runChooser(keys, items, paint, options));
}

/** The model chooser, over the same borrowed keyboard the palette uses. */
export async function openModelPicker(host: KeyboardHost, options: RunModelPickerOptions, self?: unknown): Promise<PickerResult | undefined> {
  return withBorrowedKeyboard(host, self, (keys, paint) => runModelPicker(keys, paint, options));
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

  /** Runs the palette with the keyboard, then puts back whatever the user is left holding. */
  const run = (options: RunPaletteOptions) => {
    busy = true;
    void openPalette(host, onKeypress as never, options)
      .then((chosen) => { if (chosen) submit(host.readline, chosen); })
      .finally(() => {
        busy = false;
        host.readline.prompt(true);
      });
  };

  const onKeypress = (str: string | undefined, key: KeypressEvent) => {
    if (busy || !key) return;

    // The suggestion dropdown is deliberately *not* driven from here. Opening a palette on "/"
    // means the palette owns the keyboard from the first character, so the rest of a typed
    // `/model haiku` lands in its query instead of the line — the command is then never run, and
    // history, Ctrl-A/E and @-completion are dead for the whole time it is open. Suggestions are
    // painted non-modally by the screen instead (`PinnedScreen.renderSuggestions`), leaving
    // readline in charge of every keystroke.

    const command = host.registry.match(key);
    if (!command) return;
    if (host.onIntercept?.(command)) return;
    if (command !== "/palette") {
      submit(host.readline, command);
      return;
    }
    run({ direction: "up" });
  };

  host.input.on("keypress", onKeypress);
  return () => host.input.off("keypress", onKeypress);
}
