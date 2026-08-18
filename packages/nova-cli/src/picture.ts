import type { RgbaImage } from "./png";

/**
 * Images in the terminal — Nova's port of ntcharts' `picture`.
 *
 * Two renderers behind one call, because terminal image support is not a thing you can assume and
 * is not a thing you can detect reliably either:
 *
 * - **Kitty graphics.** The terminal is handed the actual image and draws real pixels. Available in
 *   Kitty, Ghostty, WezTerm and a few others.
 * - **Glyph.** Half-block characters with a foreground and a background colour, which fits two
 *   pixels into one character cell. Works in any terminal with 24-bit colour, which is nearly all
 *   of them, and degrades further to a grey ramp where it is not.
 *
 * The glyph path is the default and the fallback both, and that ordering is deliberate: an image
 * rendered as blocks is a worse picture but it is a picture, whereas a Kitty escape sequence sent
 * to a terminal that does not implement it is dumped to the screen as raw bytes and destroys the
 * display. So Kitty is used only on affirmative evidence, never on a guess.
 *
 * Everything here returns finished lines and writes to nothing, the same contract `charts.ts`
 * holds: size is an input, never an output, so the result can be printed into the transcript or
 * painted onto reserved rows without the caller knowing which renderer produced it.
 */

/**
 * How an image is mapped onto a box that is a different shape.
 *
 * The three modes are the same set CSS `object-fit` and ntcharts both settled on, for the same
 * reason — they are the only three answers to "the aspect ratios differ": keep it all and leave
 * gaps, distort it to fill, or fill it and lose the edges.
 */
export type FitMode = "contain" | "fill" | "cover";

export type PictureMode = "glyph" | "kitty";

/**
 * What we know about the terminal's Kitty support.
 *
 * Three states rather than a boolean because "we have not found out yet" is a real and common
 * state — the probe is a round trip to the terminal — and it must render as *something*. Collapsing
 * it into `false` would mean every picture drawn in the first few milliseconds of a session picked
 * the fallback permanently; collapsing it into `true` risks dumping escape bytes onto a terminal
 * that cannot read them, which is the failure this type exists to prevent.
 */
export type KittyCapability = "supported" | "unsupported" | "unknown";

/**
 * Whether the environment claims a Kitty-graphics terminal.
 *
 * Environment sniffing is evidence, not proof — `TERM` is inherited across ssh and tmux and lies
 * routinely — so this only ever *narrows* the question. A true here means "worth probing"; it is
 * never on its own a reason to emit graphics escapes.
 */
export function kittyEnvSignalled(environment: NodeJS.ProcessEnv): boolean {
  if (environment.TERM_PROGRAM === "ghostty" || environment.TERM_PROGRAM === "WezTerm") return true;
  if (environment.KITTY_WINDOW_ID !== undefined) return true;
  return (environment.TERM ?? "").includes("kitty");
}

/**
 * The target size in *pixels* for an image drawn into a box of character cells.
 *
 * The factor of two is the whole subtlety. A character cell is roughly twice as tall as it is wide,
 * and the half-block renderer puts two pixels in each cell vertically — so a box of `cols × rows`
 * cells is a canvas of `cols × rows*2` pixels, and that canvas is very nearly square-pixelled. Skip
 * the doubling and every image comes out squashed to half its height, which reads as a bug in the
 * decoder rather than in the layout arithmetic.
 */
export function fitDimensions(
  source: { width: number; height: number },
  cols: number,
  rows: number,
  mode: FitMode,
): { width: number; height: number } {
  const boxWidth = Math.max(1, Math.floor(cols));
  const boxHeight = Math.max(1, Math.floor(rows)) * 2;
  if (mode === "fill") return { width: boxWidth, height: boxHeight };
  if (source.width <= 0 || source.height <= 0) return { width: boxWidth, height: boxHeight };

  const scaleX = boxWidth / source.width;
  const scaleY = boxHeight / source.height;
  // Contain takes the smaller scale so nothing is cut off; cover takes the larger so nothing is
  // left blank. That single choice is the entire difference between the two modes.
  const scale = mode === "contain" ? Math.min(scaleX, scaleY) : Math.max(scaleX, scaleY);
  return {
    width: Math.max(1, Math.round(source.width * scale)),
    height: Math.max(1, Math.round(source.height * scale)),
  };
}

/**
 * Nearest-neighbour resample into a target pixel grid.
 *
 * Nearest rather than bilinear on purpose. The output is about to be quantised to one glyph per two
 * pixels and painted in 24-bit colour, so the smoothing a bilinear filter buys is thrown away by
 * the next stage — while its cost is a multiply-add per channel per pixel on a hot path that runs
 * on every resize. Where smoothness genuinely matters, the Kitty path hands the terminal the
 * original image and the terminal does its own scaling properly.
 */
export function resample(image: RgbaImage, width: number, height: number): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    // +0.5 samples the centre of the target pixel rather than its top-left corner, which is what
    // stops the whole image drifting up and left by half a pixel as it shrinks.
    const sourceY = Math.min(image.height - 1, Math.floor(((y + 0.5) * image.height) / height));
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(image.width - 1, Math.floor(((x + 0.5) * image.width) / width));
      const from = (sourceY * image.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      data[to] = image.data[from];
      data[to + 1] = image.data[from + 1];
      data[to + 2] = image.data[from + 2];
      data[to + 3] = image.data[from + 3];
    }
  }
  return { width, height, data };
}

/** Alpha composited onto a background, since a terminal cell has no transparency of its own. */
function flatten(data: Uint8Array, offset: number, background: readonly [number, number, number]): [number, number, number] {
  const alpha = data[offset + 3] / 255;
  return [
    Math.round(data[offset] * alpha + background[0] * (1 - alpha)),
    Math.round(data[offset + 1] * alpha + background[1] * (1 - alpha)),
    Math.round(data[offset + 2] * alpha + background[2] * (1 - alpha)),
  ];
}

/** Perceived luminance, for the no-colour ramp. Rec. 601 weights — green dominates human vision. */
function luminance(rgb: readonly [number, number, number]): number {
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
}

/** Dark to light. Reads as a picture at a glance, which a linear ASCII ramp does not. */
const GREY_RAMP = " .:-=+*#%@";

export type GlyphRenderOptions = {
  cols: number;
  rows: number;
  fit?: FitMode;
  /** What transparent pixels composite onto. Defaults to terminal-ish black. */
  background?: readonly [number, number, number];
  /** `"none"` gives the ASCII grey ramp, for terminals without 24-bit colour. */
  color?: "truecolor" | "none";
};

/**
 * Renders an image as half-block characters, two pixels per cell.
 *
 * The upper half block `▀` is the trick the whole renderer turns on: the glyph paints its top half
 * in the foreground colour and leaves its bottom half showing the background, so setting both
 * colours puts two independently-coloured pixels in one cell. That doubles vertical resolution for
 * free and is why terminal image viewers converged on it.
 *
 * Rows are padded to an even pixel count. An image with an odd number of pixel rows would otherwise
 * read one row past the end of its own buffer on the last line — as zeros, which is a black stripe
 * along the bottom edge that looks like part of the picture.
 */
export function renderGlyph(image: RgbaImage, options: GlyphRenderOptions): string[] {
  const fit = options.fit ?? "contain";
  const background = options.background ?? [0, 0, 0];
  const target = fitDimensions(image, options.cols, options.rows, fit);
  const scaled = resample(image, target.width, target.height);
  const lines: string[] = [];

  for (let y = 0; y < scaled.height; y += 2) {
    let line = "";
    for (let x = 0; x < scaled.width; x += 1) {
      const top = flatten(scaled.data, (y * scaled.width + x) * 4, background);
      // The final row of an odd-height image has no lower neighbour; repeating the upper pixel
      // renders it as a solid cell rather than as a black one.
      const lower = y + 1 < scaled.height ? (y + 1) * scaled.width + x : y * scaled.width + x;
      const bottom = flatten(scaled.data, lower * 4, background);
      if (options.color === "none") {
        line += GREY_RAMP[Math.min(GREY_RAMP.length - 1, Math.round(((luminance(top) + luminance(bottom)) / 2) * (GREY_RAMP.length - 1)))];
      } else {
        line += `\x1b[38;2;${top[0]};${top[1]};${top[2]}m\x1b[48;2;${bottom[0]};${bottom[1]};${bottom[2]}m▀`;
      }
    }
    lines.push(options.color === "none" ? line : `${line}\x1b[0m`);
  }
  return lines;
}

/** How many cell rows `renderGlyph` will produce, without rendering — for reserving space. */
export function glyphRowCount(image: { width: number; height: number }, cols: number, rows: number, fit: FitMode = "contain"): number {
  return Math.ceil(fitDimensions(image, cols, rows, fit).height / 2);
}

export type KittyOptions = {
  cols: number;
  rows: number;
  /**
   * A stable id lets a later draw *replace* this image rather than stack a second one on top of it.
   * Two panes on screen need two ids; reusing one is how a redraw leaves the old image behind.
   */
  id?: number;
};

/**
 * Wraps PNG bytes in the Kitty graphics protocol.
 *
 * Takes the encoded file rather than decoded pixels because `f=100` hands the terminal the PNG and
 * lets it decode and scale — which is both less data over the wire and better scaling than the
 * nearest-neighbour resampler above.
 *
 * The 4096-byte chunking is required by the protocol, not a buffer-size preference: payloads are
 * split into escape sequences of at most 4096 base64 characters, every chunk but the last carries
 * `m=1` for "more follows", and only the first carries the key/value header. A terminal that
 * receives one oversized sequence renders nothing at all.
 */
export function renderKitty(png: Uint8Array, options: KittyOptions): string {
  const payload = Buffer.from(png).toString("base64");
  const chunkSize = 4096;
  const header = [
    "a=T", // Transmit and display in one go.
    "f=100", // The payload is a PNG file, not raw pixels.
    `c=${Math.max(1, Math.floor(options.cols))}`,
    `r=${Math.max(1, Math.floor(options.rows))}`,
    ...(options.id === undefined ? [] : [`i=${options.id}`]),
  ].join(",");

  if (payload.length <= chunkSize) return `\x1b_G${header};${payload}\x1b\\`;

  const parts: string[] = [];
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    const chunk = payload.slice(offset, offset + chunkSize);
    const more = offset + chunkSize < payload.length ? 1 : 0;
    parts.push(offset === 0
      ? `\x1b_G${header},m=${more};${chunk}\x1b\\`
      : `\x1b_Gm=${more};${chunk}\x1b\\`);
  }
  return parts.join("");
}

/** Removes a previously-transmitted image by id, so a redraw replaces rather than accumulates. */
export function clearKitty(id: number): string {
  return `\x1b_Ga=d,d=i,i=${id}\x1b\\`;
}

/**
 * Which renderer to use, given what is actually known.
 *
 * Kitty requires an explicit request *and* affirmative capability. Both halves matter: the caller
 * asking for Kitty is not evidence the terminal can show it, and a capable terminal is no reason to
 * override a caller that asked for glyphs.
 */
export function chooseMode(requested: PictureMode, capability: KittyCapability): PictureMode {
  return requested === "kitty" && capability === "supported" ? "kitty" : "glyph";
}
