/**
 * Keyboard shortcuts for the window.
 *
 * The app had exactly one: Ctrl+Enter to send. Everything else — switching mode, seeing the diff,
 * undoing, stopping a turn — was mouse-only, which for a tool people sit in all day is the
 * difference between using it and operating it.
 *
 * The bindings mirror the CLI's where the CLI has one, so the two surfaces do not teach different
 * habits for the same action.
 */

export type ShortcutAction =
  | "send"
  | "stop"
  | "undo"
  | "diff"
  | "settings"
  | "models"
  | "files"
  | "guide"
  | "palette"
  | "plan"
  | "build"
  | "auto"
  | "defender"
  | "focus-composer"
  | "tab-new"
  | "tab-close"
  | "tab-next"
  | "tab-previous"
  /** Carries the 1-based position with it — Ctrl+1 … Ctrl+9 pick a tab directly. */
  | `tab-select-${number}`;

export type ShortcutEvent = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  /** True when focus is in a text field, where plain letters must stay plain letters. */
  typing?: boolean;
};

export type ShortcutBinding = { action: ShortcutAction; label: string; keys: string };

/** What `/keys` would show, and what the help panel renders. Order is presentation order. */
export const SHORTCUTS: readonly ShortcutBinding[] = [
  { action: "send", label: "Send the message", keys: "Ctrl ↵" },
  { action: "stop", label: "Stop the turn in progress", keys: "Esc" },
  { action: "focus-composer", label: "Jump to the message box", keys: "Ctrl /" },
  { action: "models", label: "Switch model", keys: "Ctrl M" },
  { action: "diff", label: "See what changed", keys: "Ctrl D" },
  { action: "files", label: "Browse and read the project's files", keys: "Ctrl P" },
  { action: "undo", label: "Undo the last turn", keys: "Ctrl Z" },
  { action: "settings", label: "Open settings", keys: "Ctrl ," },
  { action: "guide", label: "Open the guide", keys: "F1" },
  { action: "palette", label: "Search every desktop command", keys: "Ctrl G" },
  { action: "tab-new", label: "New tab — a second piece of work, running at the same time", keys: "Ctrl T" },
  { action: "tab-close", label: "Close this tab", keys: "Ctrl W" },
  { action: "tab-next", label: "Next tab", keys: "Ctrl ⇥" },
  { action: "tab-previous", label: "Previous tab", keys: "Ctrl ⇧ ⇥" },
  { action: "tab-select-1", label: "Jump to a tab by position", keys: "Ctrl 1…9" },
  { action: "plan", label: "Plan mode", keys: "Alt 1" },
  { action: "build", label: "Build mode", keys: "Alt 2" },
  { action: "auto", label: "Auto mode", keys: "Alt 3" },
  { action: "defender", label: "Defender mode", keys: "Alt 4" },
];

/**
 * Resolves a keypress to an action, or nothing.
 *
 * Two rules do most of the work here:
 *
 * - **Every shortcut carries a modifier.** A bare letter has to remain a letter: the composer is
 *   the main thing on screen and people type prose into it. The CLI learned the same lesson when
 *   its mnemonics moved onto Alt.
 * - **Escape is the exception, and only when not typing.** Stopping a runaway turn is the one
 *   action that must not require aiming, and Escape is where every user's hand already goes.
 */
export function matchShortcut(event: ShortcutEvent): ShortcutAction | undefined {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  // F1 needs no modifier and is claimed even while typing: it is not a character on any layout,
  // and "how does this work" is a question people have precisely while mid-sentence.
  if (key === "f1") return "guide";
  if (key === "escape") return event.typing ? undefined : "stop";
  if (key === "enter" && mod) return "send";

  /**
   * Tabs, on the chords every tabbed application already uses.
   *
   * These are claimed even while typing, unlike the letter shortcuts below: Ctrl+T in a text field
   * is not a character, and a person mid-sentence in one tab is exactly who wants to start another.
   * Ctrl+Tab is checked before the modifier gate because Tab with a modifier is never text either.
   */
  if (mod && !event.altKey) {
    if (key === "tab") return event.shiftKey ? "tab-previous" : "tab-next";
    if (key === "t") return "tab-new";
    if (key === "w") return "tab-close";
    // Digits pick a tab by position. Shift is excluded so that punctuation typed with Ctrl held —
    // which some layouts produce from the number row — cannot select a tab by accident.
    if (!event.shiftKey && /^[1-9]$/.test(key)) return `tab-select-${Number(key)}` as ShortcutAction;
  }

  if (event.altKey && !mod) {
    if (key === "1") return "plan";
    if (key === "2") return "build";
    if (key === "3") return "auto";
    if (key === "4") return "defender";
    return undefined;
  }

  if (!mod || event.altKey) return undefined;
  switch (key) {
    case "/": return "focus-composer";
    case "g": return "palette";
    case "m": return "models";
    case "d": return "diff";
    // The chord every editor uses for "open a file", so the explorer is where the hand already
    // goes rather than somewhere new to learn.
    case "p": return "files";
    case "z": return "undo";
    case ",": return "settings";
    default: return undefined;
  }
}

/**
 * Whether a keypress originated in something the user is typing into.
 *
 * Taken from the event target rather than tracked separately, because focus can move for reasons
 * this module never sees — clicking, a dialog opening, the platform restoring it.
 */
export function isTypingTarget(target: unknown): boolean {
  // `unknown` rather than `EventTarget`, because this only ever reads two optional properties and
  // saying so lets a caller — or a test — pass the shape it actually has without a cast.
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element?.tagName) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select" || element.isContentEditable === true;
}
