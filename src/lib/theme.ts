/**
 * The window's appearance: what the reader chose, and what that resolves to right now.
 *
 * Three values, not two. "Light" and "dark" are choices; "system" is the *absence* of a choice, and
 * collapsing it into whichever one the OS happens to be today is how an app ends up stuck in dark
 * mode six months later when the person switched their machine to light. The distinction is kept
 * all the way to storage.
 *
 * Resolution is deliberately in JavaScript rather than in a `prefers-color-scheme` media query.
 * With the media query holding one palette and an explicit override holding another, the light
 * tokens have to be written out twice and the two copies drift — and the override has to fight the
 * cascade to win. Here the stylesheet states each palette exactly once, keyed on `data-theme`, and
 * this module is the only thing that decides which one is on the element. The OS is still followed:
 * `watchSystemTheme` re-resolves whenever it changes, which is the behaviour the media query was
 * there for in the first place.
 */

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_CHOICES: readonly ThemeChoice[] = ["light", "dark", "system"];

/** Where the choice is kept. Web storage, not the settings store: this is a property of this window, not of the agent. */
export const THEME_STORAGE_KEY = "nova.theme";

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEME_CHOICES as readonly string[]).includes(value);
}

/** Anything stored that is not one of the three is treated as no choice at all, which is "system". */
export function parseThemeChoice(stored: string | null | undefined): ThemeChoice {
  return isThemeChoice(stored) ? stored : "system";
}

/**
 * What the choice means on this machine at this moment.
 *
 * `systemPrefersDark` is passed in rather than read here so the whole function is testable without
 * a DOM, and so the caller decides how often the OS is consulted.
 */
export function resolveTheme(choice: ThemeChoice, systemPrefersDark: boolean): ResolvedTheme {
  if (choice === "light" || choice === "dark") return choice;
  return systemPrefersDark ? "dark" : "light";
}

/** The label a control shows for a choice. Sentence case, because these are options and not shouted. */
export function themeLabel(choice: ThemeChoice): string {
  return choice === "system" ? "System" : choice === "dark" ? "Dark" : "Light";
}

const MEDIA_QUERY = "(prefers-color-scheme: dark)";

export function systemPrefersDark(view: { matchMedia?: (query: string) => { matches: boolean } } = globalThis as never): boolean {
  // A window with no `matchMedia` — a test environment, an old webview — is treated as light, which
  // is the safer default: a light UI in a dark room is unpleasant, a dark UI is never unreadable.
  return view.matchMedia?.(MEDIA_QUERY).matches ?? false;
}

type MediaQueryLike = {
  matches: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
};

/**
 * Calls back whenever the OS appearance changes. Returns the unsubscribe.
 *
 * A no-op where the environment has no `matchMedia`, so a caller never has to ask whether it does —
 * the subscription simply never fires, which is exactly what a machine with no system preference
 * should do.
 */
export function watchSystemTheme(
  onChange: (prefersDark: boolean) => void,
  view: { matchMedia?: (query: string) => MediaQueryLike } = globalThis as never,
): () => void {
  const query = view.matchMedia?.(MEDIA_QUERY);
  if (!query?.addEventListener) return () => {};
  const listener = () => onChange(query.matches);
  query.addEventListener("change", listener);
  return () => query.removeEventListener?.("change", listener);
}

/** The document element, as narrowly as this module needs it — so a test can pass two fields. */
export type ThemeTarget = { setAttribute(name: string, value: string): void; style: { colorScheme: string } };

/**
 * Puts the resolved theme on the document element, where the stylesheet reads it.
 *
 * `color-scheme` is set alongside it, and is not decoration: it is what makes the *native* parts —
 * scrollbars, form controls, the window's own background during a resize — follow the app instead
 * of staying dark behind a light UI. That mismatch is the single most common way a themed desktop
 * app looks unfinished.
 */
export function applyTheme(resolved: ResolvedTheme, root: ThemeTarget): void {
  root.setAttribute("data-theme", resolved);
  root.style.colorScheme = resolved;
}

/** Reads the stored choice. Storage that throws — a locked-down webview — reads as no choice. */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | undefined = safeStorage()): ThemeChoice {
  try {
    return parseThemeChoice(storage?.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

/** Writes the choice. A failure to persist must never stop the theme from changing on screen. */
export function writeStoredTheme(choice: ThemeChoice, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // Nothing to do and nothing worth saying: the window is themed either way, and a toast about
    // local storage is noise about a problem the reader cannot act on.
  }
}

function safeStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * The whole startup act, in one call: read the choice, resolve it, put it on the element.
 *
 * Exported so it can run from the entry module *before* React renders. A theme applied in an effect
 * is a theme applied one paint late, and that paint is the flash of the wrong colour that makes a
 * desktop app feel like a web page.
 */
export function bootTheme(root: ThemeTarget | undefined = globalThis.document?.documentElement): ThemeChoice {
  const choice = readStoredTheme();
  if (root) applyTheme(resolveTheme(choice, systemPrefersDark()), root);
  return choice;
}
