/**
 * Every non-ASCII character Nova draws, in one table, with an ASCII twin for terminals that cannot
 * render it.
 *
 * The bug this exists for is specific and was reported as "it shows ? instead of stars": a glyph
 * the terminal's encoding or font cannot represent is not dropped, it is substituted — as `?` on a
 * non-UTF-8 code page, as a hollow box when the font is missing the codepoint. Escape-code colour
 * already degrades through `ColorDepth`; character *repertoire* is the same kind of capability and
 * had no such switch, so `✦`, `╭` and `☑` were written unconditionally and a Windows console on
 * cp1252 or a `TERM=linux` framebuffer got question marks where the design intended stars.
 *
 * The rule is that no module outside this file writes a literal non-ASCII glyph. A renderer takes a
 * `GlyphSet` and asks for a *meaning* — `glyphs.check`, `glyphs.boxTopLeft` — so adding a glyph
 * anywhere forces its fallback to be chosen at the same moment, which is what stops the two sets
 * drifting apart the way a fallback table maintained separately always does.
 */

export type GlyphSet = {
  /** Brightness ladder for the starfield, dim to bright. */
  starGlyphs: readonly string[];
  /** Spinner frames; every frame is the same visible width so the text beside it cannot jitter. */
  spinnerFrames: readonly string[];
  star: string;
  starDim: string;
  check: string;
  cross: string;
  pending: string;
  prompt: string;
  /** The lighter caret a query/filter line carries, kept distinct from the selection cursor. */
  caret: string;
  bullet: string;
  ellipsis: string;
  middot: string;
  /** The "result of the line above" elbow used for checkpoints and nested notes. */
  elbow: string;
  boxTopLeft: string;
  boxTopRight: string;
  boxBottomLeft: string;
  boxBottomRight: string;
  boxHorizontal: string;
  boxVertical: string;
  boxTeeLeft: string;
  boxTeeRight: string;
  boxCross: string;
  /** Todo/job status marks. */
  circleEmpty: string;
  circleHalf: string;
  circleFull: string;
  checkbox: string;
  checkboxDone: string;
  paused: string;
  cancelled: string;
  /**
   * Tree connectors, as Lip Gloss's `tree` draws them: a branch to a child, the last child's
   * corner, and the trunk that carries past a child to its siblings below.
   */
  treeBranch: string;
  treeLast: string;
  treeTrunk: string;
  /** Disclosure triangles for a collapsed or expanded block. */
  collapsed: string;
  expanded: string;
  arrowUp: string;
  arrowLeft: string;
  arrowRight: string;
  arrowDown: string;
  /** Diff gutter marks. */
  plus: string;
  minus: string;
  warning: string;
  /** Blast-radius marks on a tool line: this call writes to the workspace, or leaves it entirely. */
  effectWorkspace: string;
  effectExternal: string;
  /** Eight-level height ramp, low to high, for a one-line trend like `/cost`'s spend-per-turn. */
  sparkLevels: readonly string[];
};

export const UNICODE_GLYPHS: GlyphSet = {
  starGlyphs: [".", "·", "✧", "✦", "✶"],
  spinnerFrames: ["·   ·", "· ✧ ·", "· ✦ ·", "✧ ✶ ✧", "· ✦ ·", "· ✧ ·"],
  star: "✦",
  starDim: "✧",
  check: "✓",
  cross: "✗",
  pending: "⋯",
  prompt: "❯",
  caret: "›",
  bullet: "•",
  ellipsis: "…",
  middot: "·",
  elbow: "⎿",
  boxTopLeft: "╭",
  boxTopRight: "╮",
  boxBottomLeft: "╰",
  boxBottomRight: "╯",
  boxHorizontal: "─",
  boxVertical: "│",
  boxTeeLeft: "├",
  boxTeeRight: "┤",
  boxCross: "┼",
  circleEmpty: "○",
  circleHalf: "◐",
  circleFull: "●",
  checkbox: "☐",
  checkboxDone: "☑",
  paused: "⏸",
  cancelled: "⊘",
  treeBranch: "├─",
  treeLast: "╰─",
  treeTrunk: "│ ",
  collapsed: "▸",
  expanded: "▾",
  arrowUp: "↑",
  arrowLeft: "←",
  arrowRight: "→",
  arrowDown: "↓",
  plus: "+",
  minus: "-",
  warning: "!",
  effectWorkspace: "✎",
  effectExternal: "◎",
  sparkLevels: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"],
};

/**
 * The same meanings in characters every terminal ever shipped can draw.
 *
 * Chosen for shape rather than for name: `+`/`-`/`|` build a recognisable box, `>` reads as a
 * prompt, `[x]` reads as a checked box. Widths are allowed to differ from the Unicode set — every
 * layout calculation here goes through `visibleWidth`, so a three-column `...` standing in for a
 * one-column `…` is measured correctly rather than assumed.
 */
export const ASCII_GLYPHS: GlyphSet = {
  starGlyphs: [".", ".", "+", "*", "*"],
  spinnerFrames: ["-", "\\", "|", "/"],
  star: "*",
  starDim: "+",
  check: "+",
  cross: "x",
  pending: "~",
  prompt: ">",
  caret: ">",
  bullet: "-",
  ellipsis: "...",
  middot: "-",
  elbow: "\\",
  boxTopLeft: "+",
  boxTopRight: "+",
  boxBottomLeft: "+",
  boxBottomRight: "+",
  boxHorizontal: "-",
  boxVertical: "|",
  boxTeeLeft: "+",
  boxTeeRight: "+",
  boxCross: "+",
  circleEmpty: "o",
  circleHalf: "*",
  circleFull: "*",
  checkbox: "[ ]",
  checkboxDone: "[x]",
  paused: "=",
  cancelled: "x",
  treeBranch: "|-",
  treeLast: "`-",
  treeTrunk: "| ",
  collapsed: ">",
  expanded: "v",
  arrowUp: "^",
  arrowLeft: "<-",
  arrowRight: "->",
  arrowDown: "v",
  plus: "+",
  minus: "-",
  warning: "!",
  effectWorkspace: "w",
  effectExternal: "e",
  sparkLevels: [" ", ".", ":", "-", "=", "+", "*", "#"],
};

/**
 * The nine characters a bordered box is drawn from, as a set of its own — deliberately not part of
 * `GlyphSet`. A theme's border *style* (round, single, double) and a terminal's glyph *repertoire*
 * (Unicode vs. ASCII) are two independent axes: `GlyphSet` already covers the second, and folding
 * the first in as three more full glyph sets would triple every entry in this file for the nine
 * characters that actually vary. This stays a small, separate lookup instead.
 */
export type BorderGlyphs = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeLeft: string;
  teeRight: string;
  cross: string;
};

const ROUND_BORDER: BorderGlyphs = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤", cross: "┼" };
const SINGLE_BORDER: BorderGlyphs = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "─", vertical: "│", teeLeft: "├", teeRight: "┤", cross: "┼" };
const DOUBLE_BORDER: BorderGlyphs = { topLeft: "╔", topRight: "╗", bottomLeft: "╚", bottomRight: "╝", horizontal: "═", vertical: "║", teeLeft: "╠", teeRight: "╣", cross: "╬" };
const ASCII_BORDER: BorderGlyphs = { topLeft: "+", topRight: "+", bottomLeft: "+", bottomRight: "+", horizontal: "-", vertical: "|", teeLeft: "+", teeRight: "+", cross: "+" };

/**
 * The border a theme actually asked for, at the repertoire this terminal can draw.
 *
 * `"none"` still resolves to a real set rather than `undefined` — a caller that means "no frame at
 * all" checks that itself and skips drawing one, the same way it already skips everything else about
 * a box; this function's only job is "which four corners", not "whether to use them".
 */
export function borderGlyphsFor(style: "round" | "single" | "double" | "none", glyphs: GlyphSet): BorderGlyphs {
  if (glyphs === ASCII_GLYPHS) return ASCII_BORDER;
  if (style === "single") return SINGLE_BORDER;
  if (style === "double") return DOUBLE_BORDER;
  return ROUND_BORDER;
}

export type GlyphMode = "unicode" | "ascii";

/**
 * Whether this terminal can be trusted with the Unicode set.
 *
 * Ordered from explicit to inferred, because every heuristic below is a guess and a person who has
 * seen the wrong answer needs one switch that ends the argument — `NOVA_GLYPHS=ascii` (or `unicode`)
 * is that switch.
 *
 * The inference itself is the same shape `figures`/`is-unicode-supported` settled on, with the
 * locale check kept rather than dropped: a `LANG` that names a non-UTF-8 charset is the single most
 * reliable signal that the *encoding* — not the font — will mangle the output, and it is exactly the
 * case that produces literal `?` characters.
 */
export function detectGlyphMode(
  environment: Record<string, string | undefined>,
  platform: string = process.platform,
): GlyphMode {
  const forced = environment.NOVA_GLYPHS?.trim().toLowerCase();
  if (forced === "ascii" || forced === "unicode") return forced;
  // Long-standing convention in other tools, and the flag someone reaches for when a pipeline
  // mangles anything above 0x7f.
  if (environment.NOVA_ASCII?.trim() && environment.NOVA_ASCII !== "0") return "ascii";

  const term = environment.TERM?.trim().toLowerCase();
  // The Linux framebuffer console has a 256/512-glyph font and no fallback chain; box drawing there
  // is a lottery. `dumb` announces it renders nothing but text.
  if (term === "linux" || term === "dumb") return "ascii";

  if (platform === "win32") {
    // Windows has no locale variable to read, so capability is inferred from which console is
    // hosting the process. The legacy conhost that ships with cmd.exe is the one that shows `?`.
    return environment.WT_SESSION
      || environment.TERMINUS_SUBLIME
      || environment.ConEmuTask === "{cmd::Cmder}"
      || environment.TERM_PROGRAM === "vscode"
      || environment.TERM_PROGRAM === "Terminus-Sublime"
      || term === "xterm-256color"
      || term === "alacritty"
      ? "unicode"
      : "ascii";
  }

  const locale = environment.LC_ALL || environment.LC_CTYPE || environment.LANG;
  // No locale configured at all is the common case inside containers and CI, where stdout is
  // usually UTF-8 anyway — an unset variable is an absence of evidence, not evidence of cp437.
  if (!locale?.trim()) return "unicode";
  return /utf-?8/i.test(locale) ? "unicode" : "ascii";
}

export function glyphsFor(mode: GlyphMode): GlyphSet {
  return mode === "ascii" ? ASCII_GLYPHS : UNICODE_GLYPHS;
}

/** The set this environment should use, detection included — the one call most callers want. */
export function resolveGlyphs(
  environment: Record<string, string | undefined>,
  platform: string = process.platform,
): GlyphSet {
  return glyphsFor(detectGlyphMode(environment, platform));
}
