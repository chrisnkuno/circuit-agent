import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";

/**
 * The drawing surface every chart is drawn on — Nova's answer to ntcharts' canvas.
 *
 * ntcharts is two layers, and the split is the reason it can draw four kinds of chart without four
 * plotters: a `BrailleGrid` that knows only how to light a dot at (x, y), and chart types that know
 * only which dots their data implies. `lineChart` had that grid inlined, which was fine while it
 * was the only plot and became the thing standing between Nova and a scatter or a streaming series.
 * It is a separate object now, and the charts above it are short.
 *
 * One braille rune addresses a 2-wide by 4-tall dot grid, so a cell carries eight independent
 * points. A 40x8 chart is 320 cells and 2,560 addressable positions — the difference between a
 * curve and a staircase, which is the whole reason to draw with braille rather than blocks.
 *
 * Terminals that cannot render braille get one point per cell. Worse, and still a chart; braille
 * rendered as replacement characters is not.
 */

/** Bit for the dot at [column][row] of a braille cell, in Unicode's own dot order. */
const BRAILLE_DOTS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
];
const BRAILLE_BLANK = 0x2800;

export type CanvasOptions = {
  /** Character cells across and down. The dot resolution is a multiple of these. */
  columns: number;
  rows: number;
  glyphs?: GlyphSet;
};

export class BrailleCanvas {
  readonly columns: number;
  readonly rows: number;
  /** Dot columns per character cell: 2 with braille, 1 without. */
  readonly cellColumns: number;
  readonly cellRows: number;
  private readonly bits: number[][];
  private readonly ascii: boolean;

  constructor(options: CanvasOptions) {
    this.ascii = (options.glyphs ?? UNICODE_GLYPHS) === ASCII_GLYPHS;
    this.columns = Math.max(1, Math.floor(options.columns));
    this.rows = Math.max(1, Math.floor(options.rows));
    this.cellColumns = this.ascii ? 1 : 2;
    this.cellRows = this.ascii ? 1 : 4;
    this.bits = Array.from({ length: this.rows }, () => new Array<number>(this.columns).fill(0));
  }

  /** Addressable dot positions, which is what a caller scales its data to. */
  get width(): number {
    return this.columns * this.cellColumns;
  }

  get height(): number {
    return this.rows * this.cellRows;
  }

  /** Lights one dot. Out-of-range points are dropped rather than clamped: a clamped point is a lie about the data. */
  set(x: number, y: number): void {
    const dotX = Math.round(x);
    const dotY = Math.round(y);
    if (!Number.isFinite(dotX) || !Number.isFinite(dotY)) return;
    if (dotX < 0 || dotY < 0 || dotX >= this.width || dotY >= this.height) return;
    const cellX = Math.floor(dotX / this.cellColumns);
    const cellY = Math.floor(dotY / this.cellRows);
    if (this.ascii) this.bits[cellY][cellX] = 1;
    else this.bits[cellY][cellX] |= BRAILLE_DOTS[dotX % this.cellColumns][dotY % this.cellRows];
  }

  /**
   * Lights every dot between two points, so consecutive samples read as a connected line.
   *
   * Bresenham, because the alternative — one dot per sample — leaves visible gaps the moment the
   * series climbs faster than one dot per column, which is exactly when a chart is interesting.
   */
  line(x0: number, y0: number, x1: number, y1: number): void {
    let x = Math.round(x0);
    let y = Math.round(y0);
    const endX = Math.round(x1);
    const endY = Math.round(y1);
    if (![x, y, endX, endY].every(Number.isFinite)) return;
    const deltaX = Math.abs(endX - x);
    const deltaY = -Math.abs(endY - y);
    const stepX = x < endX ? 1 : -1;
    const stepY = y < endY ? 1 : -1;
    let error = deltaX + deltaY;
    // Bounded by the surface's own size: a caller passing wild coordinates gets a clipped line
    // rather than a loop that runs for as long as the numbers are big.
    for (let guard = 0; guard <= this.width + this.height; guard += 1) {
      this.set(x, y);
      if (x === endX && y === endY) return;
      const doubled = 2 * error;
      if (doubled >= deltaY) { error += deltaY; x += stepX; }
      if (doubled <= deltaX) { error += deltaX; y += stepY; }
    }
  }

  /** The finished block: one string per character row, all of them exactly `columns` wide. */
  render(): string[] {
    return this.bits.map((row) => row.map((bits) => (this.ascii ? (bits ? "*" : " ") : String.fromCharCode(BRAILLE_BLANK + bits))).join(""));
  }
}

/**
 * Maps a value onto a dot row, top-down.
 *
 * Shared because every chart here needs it and every one of them would otherwise get the inversion
 * wrong once: row 0 is the *top* of a chart, so a high value must become a small index.
 */
export function dotRowFor(value: number, low: number, span: number, dotRows: number): number {
  const normalized = (value - low) / (span === 0 ? 1 : span);
  return Math.min(dotRows - 1, Math.max(0, Math.round((1 - normalized) * (dotRows - 1))));
}

/** Bounds of a series, with a nominal span for a flat one so it plots through the middle. */
export function seriesBounds(values: readonly number[]): { low: number; high: number; span: number } {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return { low: 0, high: 0, span: 1 };
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  return { low, high, span: high - low === 0 ? 1 : high - low };
}
