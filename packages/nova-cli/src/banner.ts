import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

/**
 * The starfield Nova opens with.
 *
 * A banner is the one place a terminal tool gets to say what it is, and it has exactly one chance
 * before it becomes noise — so it prints once at session start, never per turn, and it degrades
 * rather than breaking: truecolor when the terminal has it, 256 colours when it does not, plain
 * text when colour is unwanted, and a single line when the window is narrow.
 *
 * `NO_COLOR` and a non-TTY stdout both mean plain text. Piping Nova's output into a file and
 * getting escape codes back is a small betrayal that every good CLI avoids.
 */

export type ColorDepth = "truecolor" | "ansi256" | "none";

export type BannerOptions = {
  width: number;
  depth: ColorDepth;
  /** Right-hand status line: mode, workspace, version. */
  subtitle?: string;
  /** Seeded so a given session's sky is stable, and tests are deterministic. */
  seed?: number;
  /**
   * The characters this terminal can actually draw.
   *
   * Colour was never the only capability that varies: the wordmark is built from block-drawing
   * characters and the sky from dingbats, and a terminal on a non-UTF-8 code page renders both as
   * `?`. Passing an ASCII set swaps in a letterform and a star ladder made of characters every
   * terminal has had since 1963 — the banner degrades the way it already degrades for colour,
   * instead of arriving as punctuation.
   */
  glyphs?: GlyphSet;
  /**
   * How lit the sky is, 0 to 1. Defaults to fully lit — the ordinary, static banner every existing
   * caller already draws. A caller animating the opening banner passes a rising value across
   * several redraws instead; the wordmark itself is never dimmed, only the stars around it, so the
   * one thing a person needs to read first is never the part still settling in.
   */
  intensity?: number;
};

/** What the terminal can actually render, from the environment rather than from hope. */
export function detectColorDepth(environment: Record<string, string | undefined>, isTTY: boolean): ColorDepth {
  if (!isTTY || environment.NO_COLOR !== undefined || environment.TERM === "dumb") return "none";
  if (environment.COLORTERM === "truecolor" || environment.COLORTERM === "24bit") return "truecolor";
  return "ansi256";
}

type Rgb = [number, number, number];

/** Deep midnight through to starlight — the gradient the wordmark is lit with. */
const NIGHT_GRADIENT: Rgb[] = [
  [30, 58, 138],
  [37, 99, 235],
  [59, 130, 246],
  [96, 165, 250],
  [147, 197, 253],
  [191, 219, 254],
];

const STAR_COLORS: Rgb[] = [
  [30, 58, 138],
  [59, 130, 246],
  [125, 211, 252],
  [186, 230, 253],
  [224, 242, 254],
];

/**
 * A run of text swept from one colour to another across its own width — the same per-cell
 * interpolation `progressBar` fills a meter with, applied to letterforms.
 *
 * Painted character by character, but only where the colour actually changes and never on a space:
 * a blank cell shows no foreground, so an escape around one is bytes the terminal does nothing
 * with, and the wordmark is mostly blanks. That keeps a six-row banner to a few dozen sequences
 * rather than one per cell.
 */
function gradientText(text: string, from: Rgb, to: Rgb, depth: ColorDepth): string {
  if (depth === "none") return text;
  const characters = [...text];
  const last = Math.max(1, characters.length - 1);
  let out = "";
  let open: string | undefined;
  for (const [index, character] of characters.entries()) {
    if (character === " ") {
      if (open !== undefined) { out += RESET_CODE; open = undefined; }
      out += character;
      continue;
    }
    const t = index / last;
    const rgb: Rgb = [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t),
    ];
    const code = colorCode(rgb, depth);
    if (code !== open) { out += code; open = code; }
    out += character;
  }
  return open === undefined ? out : `${out}${RESET_CODE}`;
}

const RESET_CODE = "[0m";

/** The escape that selects a colour, without the reset — `paint` wraps; this one opens a run. */
function colorCode([red, green, blue]: Rgb, depth: ColorDepth): string {
  if (depth === "truecolor") return `[38;2;${red};${green};${blue}m`;
  const channel = (value: number) => Math.round((value / 255) * 5);
  return `[38;5;${16 + 36 * channel(red) + 6 * channel(green) + channel(blue)}m`;
}

/** Where a star sits before it has "come on" — near the night sky's own base, not black. */
const STAR_DIM_ANCHOR: Rgb = [10, 14, 26];

/** A star's colour partway to its final brightness — Harmonica's spring drives `intensity` from the caller. */
function dimmed(color: Rgb, intensity: number): Rgb {
  const t = Math.max(0, Math.min(1, intensity));
  return [
    Math.round(STAR_DIM_ANCHOR[0] + (color[0] - STAR_DIM_ANCHOR[0]) * t),
    Math.round(STAR_DIM_ANCHOR[1] + (color[1] - STAR_DIM_ANCHOR[1]) * t),
    Math.round(STAR_DIM_ANCHOR[2] + (color[2] - STAR_DIM_ANCHOR[2]) * t),
  ];
}

function paint(text: string, [red, green, blue]: Rgb, depth: ColorDepth): string {
  if (depth === "none") return text;
  if (depth === "truecolor") return `[38;2;${red};${green};${blue}m${text}[0m`;
  // 256-colour cube: 16 + 36r + 6g + b, each channel quantised to six levels.
  const channel = (value: number) => Math.round((value / 255) * 5);
  return `[38;5;${16 + 36 * channel(red) + 6 * channel(green) + channel(blue)}m${text}[0m`;
}

/** ANSI Shadow block lettering, which reads as solid at any terminal font size. */
const WORDMARK = [
  "███╗   ██╗ ██████╗ ██╗   ██╗ █████╗ ",
  "████╗  ██║██╔═══██╗██║   ██║██╔══██╗",
  "██╔██╗ ██║██║   ██║██║   ██║███████║",
  "██║╚██╗██║██║   ██║╚██╗ ██╔╝██╔══██║",
  "██║ ╚████║╚██████╔╝ ╚████╔╝ ██║  ██║",
  "╚═╝  ╚═══╝ ╚═════╝   ╚═══╝  ╚═╝  ╚═╝",
];

const WORDMARK_WIDTH = 36;

/**
 * The same four letters in characters no encoding can mangle.
 *
 * Not a smaller banner — a *different* one, because the block-drawing wordmark above is unreadable
 * the moment its characters are substituted, and half a letterform is worse than a plain one.
 */
const ASCII_WORDMARK = [
  " _   _  _____ __   __  ___  ",
  "| \\ | ||  _  |\\ \\ / / / _ \\ ",
  "|  \\| || | | | \\ V / | |_| |",
  "| |\\  || |_| |  \\ /  |  _  |",
  "|_| \\_||_____|   V   |_| |_|",
];

const ASCII_WORDMARK_WIDTH = 28;

/** Glyphs by brightness: distant dust through to the few stars that actually shine. */
export const STAR_GLYPHS = UNICODE_GLYPHS.starGlyphs;

/** Deterministic noise, so one session's sky does not flicker between redraws. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10_000) / 10_000;
  };
}

/**
 * A line of sky.
 *
 * Density falls off toward the wordmark so the letters stay legible — the stars are the setting,
 * not the subject.
 */
function starLine(width: number, density: number, next: () => number, depth: ColorDepth, stars: readonly string[] = STAR_GLYPHS, intensity = 1): string {
  let line = "";
  for (let column = 0; column < width; column += 1) {
    if (next() > density) {
      line += " ";
      continue;
    }
    const brightness = next();
    const glyph = stars[Math.min(stars.length - 1, Math.floor(brightness * stars.length))];
    const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
    line += paint(glyph, intensity === 1 ? color : dimmed(color, intensity), depth);
  }
  return line.trimEnd();
}

/**
 * The full banner, or a single line when there is not room for one.
 *
 * Below the wordmark's width there is no honest way to draw it, and a wrapped block letterform is
 * worse than no letterform at all.
 */
export function renderBanner(options: BannerOptions): string {
  const { width, depth } = options;
  const intensity = options.intensity ?? 1;
  const next = random(options.seed ?? 0x5EED);
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const ascii = glyphs === ASCII_GLYPHS || glyphs.boxHorizontal === ASCII_GLYPHS.boxHorizontal;
  const wordmark = ascii ? ASCII_WORDMARK : WORDMARK;
  const wordmarkWidth = ascii ? ASCII_WORDMARK_WIDTH : WORDMARK_WIDTH;
  const stars = glyphs.starGlyphs;

  if (width < wordmarkWidth + 4) {
    const starColor = intensity === 1 ? STAR_COLORS[3] : dimmed(STAR_COLORS[3], intensity);
    const compact = `${paint(glyphs.star, starColor, depth)} ${paint("NOVA", NIGHT_GRADIENT[4], depth)} ${paint(glyphs.star, starColor, depth)}`;
    return options.subtitle ? `${compact} ${paint(options.subtitle, NIGHT_GRADIENT[0], depth)}` : compact;
  }

  const indent = Math.max(2, Math.floor((width - wordmarkWidth) / 2));
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  lines.push(starLine(width - 1, 0.05, next, depth, stars, intensity));
  lines.push(starLine(width - 1, 0.03, next, depth, stars, intensity));

  // Lit from the top down *and* swept left to right: each row starts at its own step of the night
  // gradient and reaches the next one by its right edge, so the light runs diagonally across the
  // letterforms rather than banding them into six flat stripes.
  wordmark.forEach((row, index) => {
    const from = NIGHT_GRADIENT[Math.min(NIGHT_GRADIENT.length - 1, index + 1)];
    const to = NIGHT_GRADIENT[Math.min(NIGHT_GRADIENT.length - 1, index + 2)];
    lines.push(`${flank(indent, next, depth, stars, intensity)}${pad.slice(0, Math.max(0, indent - flankWidth(indent)))}${gradientText(row, from, to, depth)}${trailing(next, depth, stars, intensity, width - indent - wordmarkWidth)}`);
  });

  lines.push(starLine(width - 1, 0.035, next, depth, stars, intensity));

  if (options.subtitle) {
    const subtitleIndent = Math.max(2, Math.floor((width - options.subtitle.length) / 2));
    lines.push(`${" ".repeat(subtitleIndent)}${paint(options.subtitle, NIGHT_GRADIENT[2], depth)}`);
  }
  return lines.join("\n");
}

/**
 * The few bright stars sitting beside the letters.
 *
 * Kept sparse and to the margins: the point is that the wordmark looks like it is in a sky, and a
 * star drawn too close reads as a rendering fault rather than as depth.
 */
function flankWidth(indent: number): number {
  return indent > 8 ? 4 : 0;
}

function flank(indent: number, next: () => number, depth: ColorDepth, stars: readonly string[] = STAR_GLYPHS, intensity = 1): string {
  const reserved = flankWidth(indent);
  if (reserved === 0) return "";
  if (next() > 0.4) return " ".repeat(reserved);
  const brightness = 0.55 + next() * 0.45;
  // Drawn once and reused for both pads. Sampling the position twice made the left and right
  // padding disagree, so each row was a different width and the letterforms sheared apart.
  const position = Math.floor(next() * reserved);
  const glyph = stars[Math.min(stars.length - 1, Math.floor(brightness * stars.length))];
  const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
  return `${" ".repeat(position)}${paint(glyph, intensity === 1 ? color : dimmed(color, intensity), depth)}${" ".repeat(reserved - position - 1)}`;
}

/**
 * A star off the right edge of a wordmark row, when there is edge to spare.
 *
 * `room` is what makes it safe. The wordmark is drawn at the widest terminal it fits, and on a
 * terminal only just wide enough there is no slack at all — a decoration added without asking wraps
 * the row, and a wrapped banner row is a line the frame below it did not reserve.
 */
function trailing(next: () => number, depth: ColorDepth, stars: readonly string[] = STAR_GLYPHS, intensity = 1, room = Number.POSITIVE_INFINITY): string {
  // Two spaces of gap plus the glyph is the narrowest this can be drawn at all.
  if (room < 3) return "";
  if (next() > 0.35) return "";
  const brightness = 0.55 + next() * 0.45;
  const glyph = stars[Math.min(stars.length - 1, Math.floor(brightness * stars.length))];
  const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
  const gap = Math.min(2 + Math.floor(next() * 4), Math.max(2, room - 1));
  return `${" ".repeat(gap)}${paint(glyph, intensity === 1 ? color : dimmed(color, intensity), depth)}`;
}

/** The one-line hint under the banner, kept separate so callers can drop it. */
export function renderTagline(text: string, depth: ColorDepth): string {
  return paint(text, NIGHT_GRADIENT[0], depth);
}
