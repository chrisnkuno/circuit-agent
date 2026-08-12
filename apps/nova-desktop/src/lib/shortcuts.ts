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
  | "plan"
  | "build"
  | "auto"
  | "focus-composer";

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
  { action: "undo", label: "Undo the last turn", keys: "Ctrl Z" },
  { action: "settings", label: "Open settings", keys: "Ctrl ," },
  { action: "plan", label: "Plan mode", keys: "Alt 1" },
  { action: "build", label: "Build mode", keys: "Alt 2" },
  { action: "auto", label: "Auto mode", keys: "Alt 3" },
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

  if (key === "escape") return event.typing ? undefined : "stop";
  if (key === "enter" && mod) return "send";

  if (event.altKey && !mod) {
    if (key === "1") return "plan";
    if (key === "2") return "build";
    if (key === "3") return "auto";
    return undefined;
  }

  if (!mod || event.altKey) return undefined;
  switch (key) {
    case "/": return "focus-composer";
    case "m": return "models";
    case "d": return "diff";
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
