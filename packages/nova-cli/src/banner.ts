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

/** Glyphs by brightness: distant dust through to the few stars that actually shine. */
const STAR_GLYPHS = [".", "·", "✧", "✦", "✶"];

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
function starLine(width: number, density: number, next: () => number, depth: ColorDepth): string {
  let line = "";
  for (let column = 0; column < width; column += 1) {
    if (next() > density) {
      line += " ";
      continue;
    }
    const brightness = next();
    const glyph = STAR_GLYPHS[Math.min(STAR_GLYPHS.length - 1, Math.floor(brightness * STAR_GLYPHS.length))];
    const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
    line += paint(glyph, color, depth);
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
  const next = random(options.seed ?? 0x5EED);

  if (width < WORDMARK_WIDTH + 4) {
    const compact = `${paint("✦", STAR_COLORS[3], depth)} ${paint("NOVA", NIGHT_GRADIENT[4], depth)} ${paint("✦", STAR_COLORS[3], depth)}`;
    return options.subtitle ? `${compact} ${paint(options.subtitle, NIGHT_GRADIENT[0], depth)}` : compact;
  }

  const indent = Math.max(2, Math.floor((width - WORDMARK_WIDTH) / 2));
  const pad = " ".repeat(indent);
  const lines: string[] = [];

  lines.push(starLine(width - 1, 0.05, next, depth));
  lines.push(starLine(width - 1, 0.03, next, depth));

  // Lit from the top down: the wordmark brightens as it descends, like a horizon glow.
  WORDMARK.forEach((row, index) => {
    const color = NIGHT_GRADIENT[Math.min(NIGHT_GRADIENT.length - 1, index + 1)];
    lines.push(`${flank(indent, next, depth)}${pad.slice(0, Math.max(0, indent - flankWidth(indent)))}${paint(row, color, depth)}${trailing(next, depth)}`);
  });

  lines.push(starLine(width - 1, 0.035, next, depth));

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

function flank(indent: number, next: () => number, depth: ColorDepth): string {
  const reserved = flankWidth(indent);
  if (reserved === 0) return "";
  if (next() > 0.4) return " ".repeat(reserved);
  const brightness = 0.55 + next() * 0.45;
  // Drawn once and reused for both pads. Sampling the position twice made the left and right
  // padding disagree, so each row was a different width and the letterforms sheared apart.
  const position = Math.floor(next() * reserved);
  const glyph = STAR_GLYPHS[Math.min(STAR_GLYPHS.length - 1, Math.floor(brightness * STAR_GLYPHS.length))];
  const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
  return `${" ".repeat(position)}${paint(glyph, color, depth)}${" ".repeat(reserved - position - 1)}`;
}

function trailing(next: () => number, depth: ColorDepth): string {
  if (next() > 0.35) return "";
  const brightness = 0.55 + next() * 0.45;
  const glyph = STAR_GLYPHS[Math.min(STAR_GLYPHS.length - 1, Math.floor(brightness * STAR_GLYPHS.length))];
  const color = STAR_COLORS[Math.min(STAR_COLORS.length - 1, Math.floor(brightness * STAR_COLORS.length))];
  return `${" ".repeat(2 + Math.floor(next() * 4))}${paint(glyph, color, depth)}`;
}

/** The one-line hint under the banner, kept separate so callers can drop it. */
export function renderTagline(text: string, depth: ColorDepth): string {
  return paint(text, NIGHT_GRADIENT[0], depth);
}
