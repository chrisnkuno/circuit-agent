import type { Interface } from "node:readline/promises";
import { KeyBindingRegistry, type KeypressEvent } from "./keybindings";
import { paletteEntries, runCommandPalette, type PaletteKey, type RunPaletteOptions } from "./palette";
import { runModelPicker, type PickerResult, type RunModelPickerOptions } from "./model-picker";
import { runChooser, type ChooserItem, type ChooserPaint, type RunChooserOptions } from "./chooser";
import { runTable, type RunTableOptions, type TableRow } from "./table";
import { rowsOccupied } from "./tui";
import type { OutputStream } from "./output";

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

/**
 * Replaces whatever is on the line, so a chosen command works mid-typing without appending to it.
 *
 * Shared with the suggestion dropup, which has exactly the same problem from the other direction:
 * its rows are whole lines ("/auto"), and writing one onto the "/a" that opened the list submits
 * "/a/auto".
 *
 * The Ctrl+E is not redundant. Ctrl+U deletes from the cursor to the *start* of the line, so on its
 * own it clears nothing at all when the cursor is already at column zero, and leaves the tail intact
 * whenever the cursor is mid-line — the command was then prepended to surviving text and submitted
 * as one nonsense line. Moving to the end first makes "replace the line" true from every cursor
 * position, which is what a shortcut pressed mid-typing needs.
 *
 * This became load-bearing rather than merely correct when Ctrl+A joined the Ctrl layer: readline
 * still sees that keypress and still moves the cursor to column zero before this runs, which is
 * precisely the position Ctrl+U alone is a no-op from. Undoing readline's edit is cheaper and far
 * more predictable than trying to stop it from happening — there is no way to cancel an event
 * another listener has already handled, and every survivable interception scheme would have to
 * reimplement the editing it suppressed.
 */
export function replaceLine(readline: Interface, text: string): void {
  readline.write(null, { ctrl: true, name: "e" });
  readline.write(null, { ctrl: true, name: "u" });
  readline.write(text);
}

function submit(readline: Interface, command: string): void {
  replaceLine(readline, command);
  if (!command.endsWith(" ")) readline.write(null, { name: "return" });
}

/**
 * Draws a menu frame in place, and takes it away again.
 *
 * Two things here were wrong for as long as menus have existed, and both showed up as the same
 * symptom — a settings menu still sitting on screen after it had been answered:
 *
 * - **Rows, not lines.** The erase counted `\n`s, but a row longer than the terminal wraps onto
 *   two or more of them. Every wrapped description left one line behind on each repaint, which is
 *   why a wide menu on a narrow window smeared and a narrow one looked fine.
 * - **Nothing erased the last frame.** Each repaint cleared its predecessor, so the final frame —
 *   the one on screen when the user pressed Enter — was never anyone's predecessor and simply
 *   stayed. `erase()` is what the borrowing code calls on the way out.
 */
function painter(output: OutputStream): { paint: (frame: string) => void; erase: () => void } {
  let rows = 0;
  const erase = () => {
    for (let row = 0; row < rows; row += 1) output.write("\x1b[1A\x1b[2K");
    if (rows > 0) output.write("\r");
    rows = 0;
  };
  return {
    erase,
    paint: (frame) => {
      erase();
      output.write(`${frame}\n`);
      const columns = output.columns ?? 80;
      rows = frame.split("\n").reduce((total, line) => total + rowsOccupied(line, columns), 0);
    },
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
  /**
   * Where frames land. Defaults to a free-floating overlay printed at the cursor (what the
   * full-screen palette, model picker and settings menu all want) — but a caller already holding
   * reserved rows of its own (the inline suggestion dropdown, drawn into the pinned footer's
   * scroll-region reservation) needs to paint *there* instead, or the borrowed chooser would draw
   * a second, competing menu under the first.
   */
  surface: { paint: (frame: string) => void; erase: () => void } = painter(host.output),
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
    return await body(keys(), surface.paint);
  } finally {
    // The menu comes down with the keyboard. Leaving the last frame on screen is what made an
    // answered menu look like it was still asking.
    surface.erase();
    host.input.off("keypress", collect);
    for (const listener of borrowed) host.input.on("keypress", listener as never);
  }
}

export async function openPalette(host: ShortcutHost, self?: unknown, options: RunPaletteOptions = {}): Promise<string | undefined> {
  const chords = Object.fromEntries(host.registry.bindings.map((binding) => [binding.command, formatBinding(binding.chord)]));
  // The live terminal width, so rows are clipped rather than wrapped. Defaulted here rather than in
  // the renderer: the renderer is pure and has no business asking the process how wide it is.
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: host.output.columns ?? 80, height: Math.max(1, (host.output.rows ?? 24) - 3) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runCommandPalette(keys, paletteEntries(chords), paint, sized));
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
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: host.output.columns ?? 80, height: Math.max(1, (host.output.rows ?? 24) - 4) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runChooser(keys, items, paint, sized));
}

/**
 * A table over the same borrowed keyboard, returning the row the user chose.
 *
 * The height it hands the table is the terminal minus a few rows, same as every other surface here:
 * a frame sized to the whole window scrolls its own top border off the screen, and the table cannot
 * work that out for itself because a pure renderer has no business asking the process how tall it is.
 */
export async function openTable(host: KeyboardHost, options: RunTableOptions, self?: unknown): Promise<TableRow | undefined> {
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: host.output.columns ?? 80, height: Math.max(1, (host.output.rows ?? 24) - 2) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runTable(keys, paint, sized));
}

/** The model chooser, over the same borrowed keyboard the palette uses. */
export async function openModelPicker(host: KeyboardHost, options: RunModelPickerOptions, self?: unknown): Promise<PickerResult | undefined> {
  const sized = {
    width: host.output.columns ?? 80,
    ...options,
    getSize: options.getSize ?? (() => ({ width: host.output.columns ?? 80, height: Math.max(1, (host.output.rows ?? 24) - 4) })),
  };
  return withBorrowedKeyboard(host, self, (keys, paint) => runModelPicker(keys, paint, sized));
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
    // history, line editing and @-completion are dead for the whole time it is open. Suggestions are
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
