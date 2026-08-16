import type { ColorDepth } from "./banner";
import type { Palette } from "./theme";
import { BOLD, CYAN, DIM, GREEN, RED, YELLOW, paint, paintAll } from "./ansi";
import { borderGlyphsFor, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { visibleWidth } from "./markdown";

/**
 * The typographic system the transcript is built from: rules, headings, panels, gutters.
 *
 * A terminal transcript has no whitespace to spare and no font sizes to vary, so hierarchy has to
 * come from the three things it does have — a horizontal rule, a weight/colour change, and an
 * indent. Before this, every part of the CLI improvised its own: some blocks were boxed, some were
 * two-space indented, some were bare, and a long run of tool output ran into the next answer with
 * nothing between them. The result reads as one undifferentiated column of text, which is the
 * specific complaint this module answers.
 *
 * Four levels, and nothing else may invent a fifth:
 *
 * 1. `rule()`      — a full-width divider, optionally labelled. Separates *episodes*: one turn from
 *                    the next, one test suite from the next. This is the strongest break available.
 * 2. `heading()`   — a titled line at one of three weights. Separates *topics* inside an episode.
 * 3. `panel()`     — a bordered card. For content that is quoted rather than narrated: a diff, a
 *                    plan, a transcript excerpt — things with an edge, where "where does it end" is
 *                    a real question.
 * 4. `note()`      — an indented dim line. Everything subordinate: counts, hints, provenance.
 *
 * Every function is pure and takes its width, colour depth and glyph set, so the whole system is
 * checked by comparing strings.
 */

export type SectionStyle = {
  width: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
  /**
   * The colours to paint the tones in. Omitted, the tones fall back to the plain ANSI eight, which
   * is what every caller expected before themes existed and what a test wants when it is checking
   * layout rather than colour.
   */
  palette?: Palette;
};

export type Tone = "neutral" | "good" | "bad" | "warn" | "accent";

const FALLBACK_TONE_CODE: Record<Tone, string> = {
  neutral: DIM,
  good: GREEN,
  bad: RED,
  warn: YELLOW,
  accent: CYAN,
};

/**
 * The escape code for a tone.
 *
 * Tones, not colours, are what the renderers ask for — `accent` rather than cyan — which is the
 * whole reason a theme can change the look of the transcript without any of them being edited.
 * `neutral` stays DIM even under a theme: it is a *weight*, and a theme that recoloured it would
 * turn the transcript's subordinate text into another voice competing with the main one.
 */
function toneCode(tone: Tone, style: SectionStyle): string {
  if (style.depth === "none") return "";
  const palette = style.palette;
  if (!palette) return FALLBACK_TONE_CODE[tone];
  switch (tone) {
    case "neutral": return DIM;
    case "good": return palette.success || FALLBACK_TONE_CODE.good;
    case "bad": return palette.error || FALLBACK_TONE_CODE.bad;
    case "warn": return palette.warning || FALLBACK_TONE_CODE.warn;
    case "accent": return palette.primary || FALLBACK_TONE_CODE.accent;
  }
}

/** The left margin every transcript line shares, so nothing sits flush against the terminal edge. */
export const GUTTER = "  ";

function setOf(style: SectionStyle): GlyphSet {
  return style.glyphs ?? UNICODE_GLYPHS;
}

/**
 * A horizontal divider, optionally carrying a label.
 *
 * The label sits at the left rather than centred: a reader scanning a long transcript for "where
 * did the tests start" runs their eye down the left edge, and a centred label moves horizontally
 * with the length of its own text, which is precisely what makes it hard to find.
 */
export function rule(style: SectionStyle, options: { label?: string; tone?: Tone; trailing?: string } = {}): string {
  const glyphs = setOf(style);
  const tone = options.tone ?? "neutral";
  const width = Math.max(4, style.width - GUTTER.length);
  // The trailing summary gets at most half the rule: past that it stops being a summary hanging off
  // a divider and becomes a line of text with a dash in front of it.
  const trailing = options.trailing ? clip(` ${options.trailing}`, Math.max(4, Math.floor(width / 2)), glyphs) : "";
  const trailingWidth = visibleWidth(trailing);

  if (!options.label) {
    // A trailing summary is honoured with or without a label. Dropping it when the label happened
    // to be absent was silent data loss: the caller asked for text to be shown and got a bare line.
    const bare = Math.max(0, width - trailingWidth);
    return `${GUTTER}${paint(glyphs.boxHorizontal.repeat(bare), DIM, style.depth)}${trailing ? paint(trailing, DIM, style.depth) : ""}`;
  }
  const lead = glyphs.boxHorizontal.repeat(2);
  // The label is clipped to what is left after the lead and the trailing summary. A rule that grows
  // past the terminal wraps onto a second row, which turns the strongest separator in the system
  // into two ragged lines — the one failure mode a divider cannot survive.
  const label = clip(` ${options.label} `, Math.max(0, width - visibleWidth(lead) - trailingWidth), glyphs);
  const used = visibleWidth(lead) + visibleWidth(label) + trailingWidth;
  const fill = Math.max(0, width - used);
  return [
    GUTTER,
    paint(lead, DIM, style.depth),
    label ? paintAll(label, [toneCode(tone, style), BOLD], style.depth) : "",
    paint(glyphs.boxHorizontal.repeat(fill), DIM, style.depth),
    trailing ? paint(trailing, DIM, style.depth) : "",
  ].join("");
}

/**
 * A titled line at one of three weights.
 *
 * Level 1 is bold and coloured and gets a rule under it; level 2 is bold; level 3 is dim. Three is
 * the practical limit — a fourth weight in a monospace grid is indistinguishable from the third at
 * a glance, so it would be hierarchy the reader cannot actually perceive.
 */
export function heading(text: string, level: 1 | 2 | 3, style: SectionStyle, tone: Tone = "accent"): string {
  if (level === 1) {
    return [
      `${GUTTER}${paintAll(text, [toneCode(tone, style), BOLD], style.depth)}`,
      rule(style, { tone }),
    ].join("\n");
  }
  if (level === 2) return `${GUTTER}${paintAll(text, [toneCode(tone, style), BOLD], style.depth)}`;
  return `${GUTTER}${paint(text, DIM, style.depth)}`;
}

/** A subordinate line: dim, indented one step past its heading. */
export function note(text: string, style: SectionStyle, tone: Tone = "neutral"): string {
  return `${GUTTER}${GUTTER}${paint(text, toneCode(tone, style), style.depth)}`;
}

export type PanelOptions = {
  title?: string;
  /** Shown at the right of the top border — a count, a status, a shortcut. */
  badge?: string;
  tone?: Tone;
  /** Draw only the left edge instead of a full box: quieter, and never mis-wraps on narrow terminals. */
  gutterOnly?: boolean;
};

/**
 * A bordered card sized to its content, or a left gutter when `gutterOnly` is set.
 *
 * Lines are clipped rather than wrapped. A panel is for content that is already laid out — code, a
 * diff, a table — where re-wrapping is a lie about the thing being quoted; callers that hold prose
 * wrap it before it gets here.
 */
export function panel(lines: readonly string[], style: SectionStyle, options: PanelOptions = {}): string {
  const glyphs = setOf(style);
  const depth = style.depth;
  const tone = options.tone ?? "neutral";
  const available = Math.max(8, style.width - GUTTER.length - 4);
  // The theme's own border style (round/single/double), not a fixed shape — this is the one thing
  // that used to make every theme draw an identical box regardless of what it actually asked for.
  const border = borderGlyphsFor(style.palette?.borderStyle ?? "round", glyphs);

  if (options.gutterOnly) {
    const edge = paint(border.vertical, toneCode(tone, style), depth);
    const head = options.title
      ? [`${GUTTER}${paintAll(options.title, [toneCode(tone, style), BOLD], depth)}${options.badge ? paint(`  ${options.badge}`, DIM, depth) : ""}`]
      : [];
    return [...head, ...lines.map((line) => `${GUTTER}${edge} ${clip(line, available, glyphs)}`)].join("\n");
  }

  const horizontal = border.horizontal;
  // Every row is `GUTTER + corner + (contentWidth + 2 columns) + corner`, and the top border has to
  // add up to exactly that too — a title and a badge are spent out of the same budget the body has,
  // or the right-hand corners do not line up and the "box" is three lines of unrelated punctuation.
  const titleCell = options.title ? ` ${options.title} ` : "";
  const badgeCell = options.badge ? ` ${options.badge} ` : "";
  const contentWidth = Math.min(
    Math.max(visibleWidth(titleCell) + visibleWidth(badgeCell) - 1, ...lines.map((line) => visibleWidth(line)), 8),
    available,
  );
  // Clipped rather than allowed to overflow: on a narrow terminal a long path in the title is what
  // pushes the border past the edge, and a shortened path reads fine where a wrapped border does not.
  const titleShown = titleCell ? clip(titleCell, Math.max(0, contentWidth + 1 - visibleWidth(badgeCell)), glyphs) : "";
  const fill = Math.max(0, contentWidth + 1 - visibleWidth(titleShown) - visibleWidth(badgeCell));

  const top = [
    GUTTER,
    paint(border.topLeft + horizontal, DIM, depth),
    titleShown ? paintAll(titleShown, [toneCode(tone, style), BOLD], depth) : "",
    paint(horizontal.repeat(fill), DIM, depth),
    badgeCell ? paint(badgeCell, DIM, depth) : "",
    paint(border.topRight, DIM, depth),
  ].join("");

  const bottom = `${GUTTER}${paint(border.bottomLeft + horizontal.repeat(contentWidth + 2) + border.bottomRight, DIM, depth)}`;
  const edge = paint(border.vertical, DIM, depth);
  const body = lines.map((line) => {
    const clipped = clip(line, contentWidth, glyphs);
    return `${GUTTER}${edge} ${clipped}${" ".repeat(Math.max(0, contentWidth - visibleWidth(clipped)))} ${edge}`;
  });
  return [top, ...body, bottom].join("\n");
}

/** Takes as many characters as fit in a column budget, marking the cut. Escape codes survive. */
export function clip(text: string, width: number, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (visibleWidth(text) <= width) return text;
  const marker = glyphs.ellipsis;
  const budget = Math.max(0, width - visibleWidth(marker));
  let taken = "";
  let used = 0;
  // Walks escape sequences through whole rather than counting them, so a clipped coloured line
  // still carries the code that coloured it — and its reset, appended below.
  const parts = text.split(/(\x1b\[[0-9;]*m)/);
  let styled = false;
  for (const part of parts) {
    if (part.startsWith("\x1b[")) {
      taken += part;
      styled = styled || part !== "\x1b[0m";
      continue;
    }
    for (const character of part) {
      const next = visibleWidth(character);
      if (used + next > budget) return `${taken}${marker}${styled ? "\x1b[0m" : ""}`;
      taken += character;
      used += next;
    }
  }
  return `${taken}${marker}${styled ? "\x1b[0m" : ""}`;
}

/**
 * A status mark for a pass/fail/skip outcome, in the caller's glyph set.
 *
 * One function rather than three call sites picking their own character, because "what does a
 * failure look like" is the kind of decision that has to be identical everywhere or the reader
 * stops trusting the mark.
 */
export function outcomeMark(outcome: "pass" | "fail" | "skip" | "running", style: SectionStyle): string {
  const glyphs = setOf(style);
  switch (outcome) {
    case "pass": return paint(glyphs.check, GREEN, style.depth);
    case "fail": return paint(glyphs.cross, RED, style.depth);
    case "skip": return paint(glyphs.circleEmpty, DIM, style.depth);
    default: return paint(glyphs.pending, CYAN, style.depth);
  }
}

/** A left-aligned label column followed by values, for the small fact tables status views print. */
export function keyValues(rows: readonly (readonly [string, string])[], style: SectionStyle): string {
  const width = Math.max(0, ...rows.map(([key]) => visibleWidth(key)));
  return rows
    .map(([key, value]) => `${GUTTER}${paint(key.padEnd(width + 2), DIM, style.depth)}${value}`)
    .join("\n");
}
