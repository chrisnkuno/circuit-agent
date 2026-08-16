import type { ColorDepth } from "./banner";
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { visibleWidth } from "./markdown";
import { padToWidth, progressBar, sliceToWidth } from "./tui";
import type { Rgb } from "./theme";

/**
 * Charts, in the terminal — Nova's answer to ntcharts.
 *
 * Everything here returns an array of finished lines and writes to nothing, the same contract the
 * full-screen surfaces are built on: a chart is a fixed-size block of text, so it can be printed
 * into the transcript, dropped into a `box()`, or painted onto reserved rows without any of those
 * callers knowing how it was drawn.
 *
 * The size is always an *input*. Nothing here grows a chart to fit its data — it fits the data to
 * the space it was given, because a block whose height depends on its contents is exactly the thing
 * that cannot be safely redrawn in place.
 */

/** One labelled measurement in a bar chart. */
export type BarDatum = { label: string; value: number };

export type BarChartOptions = {
  /** Total columns the chart may occupy, labels and value column included. */
  width: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
  /** How a value is written beside its bar. Defaults to a rounded number. */
  format?: (value: number) => string;
  /** Gradient ends for the bars, as `progressBar` takes them. */
  from?: Rgb;
  to?: Rgb;
  /** Ceiling for the bars. Defaults to the largest value present. */
  max?: number;
};

/**
 * A horizontal bar per row: label, bar, value.
 *
 * Horizontal rather than vertical because the labels are words. A vertical chart has one column per
 * bar and nowhere to write "read_file" except sideways, which is why every terminal tool that
 * charts named things — `du`, `duf`, GitHub's language bars — draws them lying down.
 *
 * Bars are drawn by `progressBar`, so they inherit its gradient, its eighth-of-a-cell precision and
 * its ASCII fallback rather than growing a second, worse implementation of all three.
 */
export function barChart(data: readonly BarDatum[], options: BarChartOptions): string[] {
  if (data.length === 0) return [];
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const format = options.format ?? ((value: number) => `${Math.round(value)}`);
  const width = Math.max(20, Math.floor(options.width));

  const labels = data.map((datum) => datum.label);
  const values = data.map((datum) => format(datum.value));
  // Both side columns are sized to their own widest entry, then the bar takes whatever is left —
  // the same "clip the thing with room to lose" rule `table()` follows.
  const labelWidth = Math.min(Math.max(...labels.map(visibleWidth)), Math.floor(width * 0.35));
  const valueWidth = Math.min(Math.max(...values.map(visibleWidth)), Math.floor(width * 0.2));
  // Two single-space separators, one either side of the bar — so the row comes to exactly
  // `labelWidth + 1 + barWidth + 1 + valueWidth`.
  const barWidth = Math.max(1, width - labelWidth - valueWidth - 2);

  const ceiling = options.max ?? Math.max(...data.map((datum) => datum.value));
  return data.map((datum, index) => {
    // A ceiling of zero means every value is zero; an empty track is the honest picture, and it
    // also keeps the division below defined.
    const fraction = ceiling > 0 ? datum.value / ceiling : 0;
    const bar = progressBar(fraction, barWidth, {
      depth: options.depth,
      glyphs,
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
    });
    return `${padToWidth(sliceToWidth(labels[index], labelWidth), labelWidth)} ${bar} ${padToWidth(values[index], valueWidth)}`;
  });
}

/**
 * Braille dot bits, by column then row — the 2x4 grid one braille cell addresses.
 *
 * The ordering is not sequential and cannot be computed: Unicode numbered dots 1-6 first, for the
 * original six-dot alphabet, then bolted 7 and 8 onto the bottom row when eight-dot braille arrived.
 * So the low bits run down the first three rows and the fourth row lives up at 0x40/0x80.
 */
const BRAILLE_DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];
const BRAILLE_BLANK = 0x2800;

export type LineChartOptions = {
  width: number;
  height: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
  /** Written at the top and bottom of the y axis. Defaults to the rounded bounds of the series. */
  format?: (value: number) => string;
  /** Drop the y-axis labels and gutter, for a caller that has its own. */
  bare?: boolean;
};

/**
 * An XY line plot, drawn with braille so one character cell carries a 2x4 grid of points.
 *
 * That resolution is the whole reason to use braille: a block-character plot has one point per
 * cell, so a 40x8 chart holds 320 positions, where the same cells in braille hold 2,560 — enough
 * that a latency series reads as a *curve* rather than as a staircase. ntcharts reaches for the
 * same trick — its `BrailleGrid` (canvas/graph) scales a plot to the "4 high and 2 wide" dot grid
 * a braille rune addresses, then draws the finished patterns onto its ordinary one-rune-per-cell
 * canvas, which is exactly the two-layer arrangement below.
 *
 * A terminal that cannot draw braille gets a coarse one-point-per-cell plot instead, which is worse
 * but is a chart; braille rendered as question marks is not.
 */
export function lineChart(values: readonly number[], options: LineChartOptions): string[] {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const height = Math.max(1, Math.floor(options.height));
  const format = options.format ?? ((value: number) => `${Math.round(value)}`);
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Array.from({ length: height }, () => "");

  const low = Math.min(...finite);
  const high = Math.max(...finite);
  // A flat series has no range to scale against. Giving it a nominal one puts the line through the
  // middle of the chart rather than dividing by zero or pinning it to an edge.
  const span = high - low === 0 ? 1 : high - low;

  const gutter = options.bare ? 0 : Math.max(visibleWidth(format(high)), visibleWidth(format(low))) + 1;
  const plotWidth = Math.max(1, Math.floor(options.width) - gutter);
  const ascii = glyphs === ASCII_GLYPHS;
  const [cellColumns, cellRows] = ascii ? [1, 1] : [2, 4];
  const dotColumns = plotWidth * cellColumns;
  const dotRows = height * cellRows;

  // Column x samples the series at the position it represents, so a series longer than the chart is
  // decimated and one shorter is held — either way the plot spans the full width instead of
  // stopping short or running off the end.
  const grid: number[][] = Array.from({ length: height }, () => Array.from({ length: plotWidth }, () => 0));
  for (let x = 0; x < dotColumns; x += 1) {
    const position = dotColumns === 1 ? 0 : (x / (dotColumns - 1)) * (finite.length - 1);
    const left = Math.floor(position);
    const right = Math.min(finite.length - 1, left + 1);
    const value = finite[left] + (finite[right] - finite[left]) * (position - left);
    const normalized = (value - low) / span;
    // Row 0 is the top of the chart, so a high value has to become a *small* index.
    const y = Math.min(dotRows - 1, Math.max(0, Math.round((1 - normalized) * (dotRows - 1))));
    const cellX = Math.floor(x / cellColumns);
    const cellY = Math.floor(y / cellRows);
    if (ascii) grid[cellY][cellX] = 1;
    else grid[cellY][cellX] |= BRAILLE_DOTS[x % cellColumns][y % cellRows];
  }

  return grid.map((row, index) => {
    const drawn = row.map((bits) => (ascii ? (bits ? "*" : " ") : String.fromCharCode(BRAILLE_BLANK + bits))).join("");
    if (options.bare) return drawn;
    // Only the bounds are labelled. A terminal chart this small has no room for a tick every row,
    // and the two numbers that answer "how big does this get" are the top and the bottom.
    const label = index === 0 ? format(high) : index === grid.length - 1 ? format(low) : "";
    return `${padToWidth(label, gutter - 1)} ${drawn}`;
  });
}

/**
 * A one-line-per-bucket heat strip: the label, then a run of cells shaded by magnitude.
 *
 * Distinct from `barChart` in what it is for. A bar answers "how much", read against its neighbours
 * by length; a heat strip answers "where in this range did it land", read by intensity, which is
 * what makes it right for scores and severities where every row has the same length and only the
 * colour differs.
 */
export function heatStrip(
  data: readonly BarDatum[],
  options: { width: number; depth: ColorDepth; glyphs?: GlyphSet; max?: number },
): string[] {
  if (data.length === 0) return [];
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const levels = glyphs.sparkLevels;
  const width = Math.max(10, Math.floor(options.width));
  const labelWidth = Math.min(Math.max(...data.map((datum) => visibleWidth(datum.label))), Math.floor(width * 0.4));
  const cells = Math.max(1, width - labelWidth - 1);
  const ceiling = options.max ?? Math.max(...data.map((datum) => datum.value));

  return data.map((datum) => {
    const fraction = ceiling > 0 ? Math.max(0, Math.min(1, datum.value / ceiling)) : 0;
    const level = levels[Math.min(levels.length - 1, Math.floor(fraction * levels.length))];
    return `${padToWidth(sliceToWidth(datum.label, labelWidth), labelWidth)} ${level.repeat(cells)}`;
  });
}
