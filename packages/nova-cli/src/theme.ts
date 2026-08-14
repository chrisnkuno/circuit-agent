import type { ColorDepth } from "./banner";

/**
 * Colour, as a set of named roles rather than a set of escape codes.
 *
 * Nova's renderers each reached for a literal — `\x1b[36m` for anything important, `\x1b[2m` for
 * anything subordinate — which is why "make it look different" had no answer short of editing every
 * file. A theme names the *roles* instead (what is primary, what is subordinate, what is wrong) and
 * resolves them to codes once, at the depth the terminal actually supports.
 *
 * The vocabulary and the file format are deliberately TermUI's Terminal Style Sheets
 * (https://www.termui.io — `@theme name { --primary: … }`), not a private invention. Two reasons:
 * a theme someone already wrote for a TSS app loads here unchanged, and when a full-screen Nova
 * workspace is eventually built on that framework, the themes written today travel to it without a
 * migration. Nova adds no keys of its own to the core set for exactly that reason.
 *
 * One deliberate omission in *this* renderer: `--bg` and `--surface` are parsed, kept and exposed,
 * but nothing here paints them. Nova prints into the terminal's own scrollback, where painting a
 * background means fighting the user's chosen one and leaving coloured bands behind on every line
 * that scrolls. They are carried because they are part of the format and because a screen-buffer
 * renderer, which owns every cell it draws, will need them.
 */

/** The token set, one name per role. Matches TSS's `--kebab-case` variables one for one. */
export type ThemeTokens = {
  primary: string;
  secondary: string;
  accent: string;
  bg: string;
  surface: string;
  text: string;
  textMuted: string;
  success: string;
  warning: string;
  error: string;
  border: string;
  borderColor: string;
  borderFocus: string;
};

export type Theme = {
  name: string;
  /** Shown by `/theme list`; not part of the TSS format, read from a `/* … *\/` comment above the block. */
  description: string;
  tokens: ThemeTokens;
};

/**
 * Nova's own.
 *
 * A night sky rather than a colour scheme: a deep blue-black ground, starlight for ordinary text,
 * and the two things a star actually looks like — cold blue-white for what is live, warm gold for
 * what deserves attention. Status colours are pulled toward that sky (a desaturated dawn red rather
 * than a terminal red) so a failure reads as part of the same picture instead of an alarm pasted
 * onto it.
 */
export const STARRY_NIGHT = `
/* Deep space, starlight and a warm gold accent — Nova's own. */
@theme starry-night {
    --primary: #8ab4f8;
    --secondary: #c7a6ff;
    --accent: #ffd98a;
    --bg: #0b1020;
    --surface: #141b33;
    --text: #e6ecff;
    --text-muted: #6b7ba8;
    --success: #7ee0a8;
    --warning: #ffc98a;
    --error: #ff8a9b;
    --border: round;
    --border-color: #2a3556;
    --border-focus: #8ab4f8;
}
`;

const STARRY_DAWN = `
/* The same sky an hour before sunrise, for a light terminal. */
@theme starry-dawn {
    --primary: #2f5fbf;
    --secondary: #6b3fbf;
    --accent: #a86a00;
    --bg: #f7f8fc;
    --surface: #eceff8;
    --text: #131726;
    --text-muted: #5d6684;
    --success: #17694a;
    --warning: #8a5300;
    --error: #b3243b;
    --border: round;
    --border-color: #c8cfe3;
    --border-focus: #2f5fbf;
}
`;

const NEBULA = `
/* Louder: magenta and cyan, for terminals with a lot of contrast to spare. */
@theme nebula {
    --primary: #66e0ff;
    --secondary: #ff6ad5;
    --accent: #ffe066;
    --bg: #0a0a2e;
    --surface: #1a1a4e;
    --text: #eaf6ff;
    --text-muted: #7a7ab5;
    --success: #55f2a0;
    --warning: #ffb454;
    --error: #ff5c7a;
    --border: single;
    --border-color: #3a3a7e;
    --border-focus: #ff6ad5;
}
`;

const HIGH_CONTRAST = `
/* Maximum separation, named colours only — for low vision and for terminals with a fixed palette. */
@theme high-contrast {
    --primary: brightCyan;
    --secondary: brightMagenta;
    --accent: brightYellow;
    --bg: black;
    --surface: black;
    --text: brightWhite;
    --text-muted: white;
    --success: brightGreen;
    --warning: brightYellow;
    --error: brightRed;
    --border: single;
    --border-color: white;
    --border-focus: brightCyan;
}
`;

export const BUILTIN_THEME_SOURCES: Record<string, string> = {
  "starry-night": STARRY_NIGHT,
  "starry-dawn": STARRY_DAWN,
  nebula: NEBULA,
  "high-contrast": HIGH_CONTRAST,
};

export const DEFAULT_THEME_NAME = "starry-night";

/** The 16 names ANSI defines, in the order the codes run. */
const NAMED_COLORS: Record<string, number> = {
  black: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6, white: 7,
  brightblack: 8, brightred: 9, brightgreen: 10, brightyellow: 11,
  brightblue: 12, brightmagenta: 13, brightcyan: 14, brightwhite: 15,
  // TSS spells the eighth colour `gray`/`grey` as often as `brightBlack`.
  gray: 8, grey: 8,
};

export type Rgb = { r: number; g: number; b: number };

/** `#rgb`, `#rrggbb`, or one of the 16 names. Returns undefined for anything else, including `round`. */
export function parseColor(value: string): Rgb | number | undefined {
  const text = value.trim();
  const named = NAMED_COLORS[text.toLowerCase().replace(/[\s_-]/g, "")];
  if (named !== undefined) return named;

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (!hex) return undefined;
  const digits = hex[1];
  const full = digits.length === 3 ? digits.split("").map((digit) => digit + digit).join("") : digits;
  return {
    r: Number.parseInt(full.slice(0, 2), 16),
    g: Number.parseInt(full.slice(2, 4), 16),
    b: Number.parseInt(full.slice(4, 6), 16),
  };
}

/**
 * Nearest xterm-256 index for a colour.
 *
 * The palette is a 6×6×6 cube plus a 24-step greyscale ramp, and the two overlap badly near grey —
 * a near-grey colour quantised into the cube lands on a visibly tinted swatch when the ramp had a
 * closer one. Both candidates are computed and the closer wins, which is what keeps `--text-muted`
 * from turning faintly purple on a 256-colour terminal.
 */
export function rgbTo256({ r, g, b }: Rgb): number {
  const level = (value: number): number => {
    if (value < 48) return 0;
    if (value < 115) return 1;
    return Math.min(5, Math.round((value - 35) / 40));
  };
  const cubeIndex = 16 + 36 * level(r) + 6 * level(g) + level(b);
  const cubeValue = (step: number) => (step === 0 ? 0 : 55 + step * 40);
  const cube = { r: cubeValue(level(r)), g: cubeValue(level(g)), b: cubeValue(level(b)) };

  const greyAverage = (r + g + b) / 3;
  const greyStep = Math.max(0, Math.min(23, Math.round((greyAverage - 8) / 10)));
  const greyValue = 8 + greyStep * 10;
  const grey = { r: greyValue, g: greyValue, b: greyValue };

  return distance({ r, g, b }, grey) < distance({ r, g, b }, cube) ? 232 + greyStep : cubeIndex;
}

function distance(a: Rgb, b: Rgb): number {
  return (a.r - b.r) ** 2 + (a.g - b.g) ** 2 + (a.b - b.b) ** 2;
}

/**
 * The escape code for a colour at a given depth.
 *
 * Depth is honoured rather than assumed: a truecolor sequence sent to a 256-colour terminal is not
 * gracefully ignored, it is *printed*, and the transcript fills with `38;2;138;180;248m`.
 */
export function colorCode(value: string, depth: ColorDepth): string {
  if (depth === "none") return "";
  const parsed = parseColor(value);
  if (parsed === undefined) return "";
  if (typeof parsed === "number") return parsed < 8 ? `\x1b[${30 + parsed}m` : `\x1b[${90 + parsed - 8}m`;
  return depth === "truecolor"
    ? `\x1b[38;2;${parsed.r};${parsed.g};${parsed.b}m`
    : `\x1b[38;5;${rgbTo256(parsed)}m`;
}

const DEFAULT_TOKENS: ThemeTokens = {
  primary: "cyan",
  secondary: "blue",
  accent: "yellow",
  bg: "black",
  surface: "black",
  text: "white",
  textMuted: "brightBlack",
  success: "green",
  warning: "yellow",
  error: "red",
  border: "round",
  borderColor: "brightBlack",
  borderFocus: "cyan",
};

const TOKEN_NAMES: Record<string, keyof ThemeTokens> = {
  primary: "primary",
  secondary: "secondary",
  accent: "accent",
  bg: "bg",
  background: "bg",
  surface: "surface",
  text: "text",
  fg: "text",
  "text-muted": "textMuted",
  muted: "textMuted",
  success: "success",
  warning: "warning",
  error: "error",
  border: "border",
  "border-color": "borderColor",
  "border-focus": "borderFocus",
  highlight: "secondary",
};

/**
 * Reads `@theme name { … }` blocks out of a TSS document.
 *
 * Only the variable blocks are read. A real TSS file also carries widget rules (`Gauge { … }`,
 * `Box:focused { … }`) that mean nothing to a renderer with no widgets; those are skipped rather
 * than rejected, so a theme written for a TermUI app is a valid Nova theme rather than an error
 * about a selector Nova has never heard of.
 */
export function parseThemeSource(source: string): Theme[] {
  const themes: Theme[] = [];
  const withoutLineComments = source.replace(/(^|\s)\/\/[^\n]*/g, "$1");
  const blockPattern = /(?:\/\*([\s\S]*?)\*\/\s*)?@theme\s+([A-Za-z0-9_-]+)\s*\{([^}]*)\}/g;

  for (const match of withoutLineComments.matchAll(blockPattern)) {
    const description = (match[1] ?? "").replace(/\s+/g, " ").trim();
    const tokens: ThemeTokens = { ...DEFAULT_TOKENS };
    // Both spellings are in the wild: TermUI's built-in themes use `--name`, its README's examples
    // use `$name`. Accepting both costs one alternation and avoids a class of silent no-op theme.
    for (const declaration of match[3].matchAll(/(?:--|\$)([a-z0-9-]+)\s*:\s*([^;}]+)[;]?/gi)) {
      const key = TOKEN_NAMES[declaration[1].toLowerCase()];
      if (key) tokens[key] = declaration[2].trim();
    }
    themes.push({ name: match[2], description, tokens });
  }
  return themes;
}

/** Every built-in theme, in the order `/theme list` shows them. */
export function builtinThemes(): Theme[] {
  return Object.values(BUILTIN_THEME_SOURCES).flatMap((source) => parseThemeSource(source));
}

export function findBuiltinTheme(name: string): Theme | undefined {
  return builtinThemes().find((theme) => theme.name.toLowerCase() === name.trim().toLowerCase());
}

/**
 * The escape codes a renderer actually paints with.
 *
 * Resolved once per session rather than per call: a token lookup and a hex parse on every coloured
 * word is real work in a transcript that prints thousands of them.
 */
export type Palette = {
  readonly theme: string;
  readonly depth: ColorDepth;
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  readonly text: string;
  readonly muted: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly border: string;
  readonly borderFocus: string;
  /** The border style the theme asks for, for the box-drawing set to follow. */
  readonly borderStyle: "round" | "single" | "double" | "none";
  /** Carried for a renderer that owns its cells; nothing in the transcript paints these. */
  readonly bg: string;
  readonly surface: string;
  /**
   * The theme's raw token values, beside the escape codes resolved from them.
   *
   * The transcript needs codes; a screen-buffer renderer needs the *values* — TermUI's `parseColor`
   * takes `#8ab4f8` or `cyan` and emits the escape itself, and handing it one already-escaped would
   * put literal `38;2;…` on screen. Carrying both means neither surface has to convert.
   */
  readonly tokens: ThemeTokens;
};

function borderStyleOf(value: string): Palette["borderStyle"] {
  const text = value.trim().toLowerCase();
  return text === "single" || text === "double" || text === "none" ? text : "round";
}

export function buildPalette(theme: Theme, depth: ColorDepth): Palette {
  const code = (value: string) => colorCode(value, depth);
  return {
    theme: theme.name,
    depth,
    primary: code(theme.tokens.primary),
    secondary: code(theme.tokens.secondary),
    accent: code(theme.tokens.accent),
    text: code(theme.tokens.text),
    muted: code(theme.tokens.textMuted),
    success: code(theme.tokens.success),
    warning: code(theme.tokens.warning),
    error: code(theme.tokens.error),
    border: code(theme.tokens.borderColor),
    borderFocus: code(theme.tokens.borderFocus),
    borderStyle: borderStyleOf(theme.tokens.border),
    bg: theme.tokens.bg,
    surface: theme.tokens.surface,
    tokens: theme.tokens,
  };
}

/** The palette a session falls back to before a theme is resolved, and whenever colour is off. */
export const NO_COLOR_PALETTE: Palette = buildPalette(
  findBuiltinTheme(DEFAULT_THEME_NAME) ?? { name: DEFAULT_THEME_NAME, description: "", tokens: DEFAULT_TOKENS },
  "none",
);

/**
 * Which theme a terminal should get when nobody has said.
 *
 * `COLORFGBG` is set by several terminals as `foreground;background`, where a background of 0–7 is
 * a dark palette; iTerm and others set `TERM_BACKGROUND` outright. Assumes dark otherwise, which is
 * both the common case and the safer failure: light text on an unexpectedly light background is
 * unreadable, whereas the reverse merely looks bolder than intended.
 */
export function detectPreferredTheme(environment: Record<string, string | undefined>): string {
  const explicit = environment.NOVA_THEME?.trim();
  if (explicit) return explicit;
  if (environment.TERM_BACKGROUND?.toLowerCase() === "light") return "starry-dawn";
  const fgbg = environment.COLORFGBG;
  if (fgbg) {
    const background = Number.parseInt(fgbg.split(";").pop() ?? "", 10);
    if (Number.isInteger(background) && background >= 8) return "starry-dawn";
  }
  return DEFAULT_THEME_NAME;
}

export type ThemeCommand =
  | { kind: "list" }
  | { kind: "show" }
  | { kind: "set"; name: string }
  | { kind: "where" }
  | { kind: "invalid"; reason: string };

/** Parses `/theme`, `/theme list`, `/theme <name>`, `/theme where`. */
export function parseThemeCommand(input: string): ThemeCommand | null {
  const match = /^\/theme(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim().replace(/\s+/g, " ");
  if (!rest) return { kind: "show" };

  const [verb, ...words] = rest.split(" ");
  switch (verb.toLowerCase()) {
    case "list": return { kind: "list" };
    case "show": return { kind: "show" };
    case "where": return { kind: "where" };
    default:
      // A theme name is the overwhelmingly common argument, so it needs no verb — but a name with
      // a space in it is a typo, not a theme, and saying so beats searching for it and failing.
      return words.length === 0
        ? { kind: "set", name: verb }
        : { kind: "invalid", reason: `Theme names have no spaces — did you mean /theme ${verb}?` };
  }
}
