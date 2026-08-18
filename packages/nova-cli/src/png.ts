import { inflateSync } from "node:zlib";

/**
 * A PNG decoder, because the alternative was a dependency Nova cannot justify.
 *
 * Every image library in this ecosystem — sharp, jimp, canvas — is either a native addon that has
 * to be compiled per platform or several megabytes of pure JavaScript, and Nova ships as a single
 * bundled CLI whose install must not need a toolchain. PNG is the one format where writing the
 * decoder is genuinely cheaper than taking the dependency: the container is four fields and a chunk
 * loop, and the compression is DEFLATE, which Node already has in `node:zlib`. So the whole decoder
 * is the chunk walk, the five scanline filters, and a colour-type switch.
 *
 * That reasoning does *not* extend to JPEG, which needs a full DCT and Huffman implementation, so
 * this deliberately decodes one format and `decoders.ts` makes the set extensible — the same shape
 * ntcharts uses, where `pictureurl` is decoder-agnostic and the caller registers what it needs.
 */

/** Decoded pixels, always 8-bit RGBA regardless of what the file stored. */
export type RgbaImage = {
  width: number;
  height: number;
  /** `width * height * 4` bytes, row-major, non-premultiplied. */
  data: Uint8Array;
};

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** Channels per pixel for each PNG colour type; the gaps are the undefined type numbers. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && SIGNATURE.every((byte, index) => bytes[index] === byte);
}

/**
 * Paeth predictor, from the PNG specification.
 *
 * Reproduced exactly rather than simplified: it picks whichever of the left, above and upper-left
 * neighbours is closest to their linear estimate, and the tie-breaking order (a, then b, then c) is
 * normative. Getting the ties wrong produces an image that decodes without error and is subtly
 * wrong along edges, which is the worst possible failure mode because nothing reports it.
 */
function paeth(a: number, b: number, c: number): number {
  const estimate = a + b - c;
  const da = Math.abs(estimate - a);
  const db = Math.abs(estimate - b);
  const dc = Math.abs(estimate - c);
  if (da <= db && da <= dc) return a;
  return db <= dc ? b : c;
}

/**
 * Reverses the per-scanline filter each row was encoded with.
 *
 * PNG filters are *per row* and each row may use a different one, which is why this cannot be
 * hoisted out of the loop. `bpp` is the byte distance to the pixel on the left — the filters work
 * on corresponding bytes of adjacent pixels, not on adjacent bytes, so for RGBA it is 4 and the
 * "left" neighbour of the green byte is the previous pixel's green byte.
 */
function unfilter(raw: Uint8Array, width: number, height: number, bpp: number, bytesPerRow: number): Uint8Array {
  const out = new Uint8Array(height * bytesPerRow);
  let position = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = raw[position];
    position += 1;
    const start = row * bytesPerRow;
    const previous = start - bytesPerRow;
    for (let index = 0; index < bytesPerRow; index += 1) {
      const value = raw[position + index];
      const left = index >= bpp ? out[start + index - bpp] : 0;
      const above = row > 0 ? out[previous + index] : 0;
      const upperLeft = row > 0 && index >= bpp ? out[previous + index - bpp] : 0;
      let restored: number;
      switch (filter) {
        case 0: restored = value; break;
        case 1: restored = value + left; break;
        case 2: restored = value + above; break;
        case 3: restored = value + ((left + above) >> 1); break;
        case 4: restored = value + paeth(left, above, upperLeft); break;
        default: throw new Error(`PNG row ${row} uses unknown filter ${filter}`);
      }
      out[start + index] = restored & 0xff;
    }
    position += bytesPerRow;
  }
  return out;
}

/**
 * Reads one sample of `depth` bits from a packed scanline.
 *
 * Sub-byte depths pack several samples into a byte, most-significant first, and every row restarts
 * on a byte boundary — which is why the caller indexes within a row rather than across the image.
 */
function sampleAt(row: Uint8Array, index: number, depth: number): number {
  if (depth === 8) return row[index];
  if (depth === 16) return row[index * 2]; // High byte only: 16-bit precision is discarded on purpose.
  const perByte = 8 / depth;
  const byte = row[Math.floor(index / perByte)];
  const shift = 8 - depth * ((index % perByte) + 1);
  return (byte >> shift) & ((1 << depth) - 1);
}

/** Scales a sample from `depth` bits up to 8, so 1-bit black/white becomes 0 and 255, not 0 and 1. */
function scaleTo8(value: number, depth: number): number {
  if (depth === 8 || depth === 16) return value;
  return Math.round((value * 255) / ((1 << depth) - 1));
}

export function decodePng(bytes: Uint8Array): RgbaImage {
  if (!isPng(bytes)) throw new Error("Not a PNG file");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let width = 0;
  let height = 0;
  let depth = 8;
  let colorType = 6;
  let interlace = 0;
  let palette: Uint8Array | undefined;
  let transparency: Uint8Array | undefined;
  const idat: Uint8Array[] = [];

  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const start = offset + 8;
    // Truncated files are common enough (an interrupted download, a partial write) to deserve a
    // sentence rather than an out-of-bounds read on a slice nobody bounds-checked.
    if (start + length > bytes.length) throw new Error(`PNG chunk ${type} is truncated`);
    if (type === "IHDR") {
      width = view.getUint32(start);
      height = view.getUint32(start + 4);
      depth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === "PLTE") {
      palette = bytes.subarray(start, start + length);
    } else if (type === "tRNS") {
      transparency = bytes.subarray(start, start + length);
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4; // +4 skips the CRC.
  }

  if (width <= 0 || height <= 0) throw new Error("PNG has no valid IHDR");
  if (interlace !== 0) throw new Error("Interlaced (Adam7) PNGs are not supported");
  if (!(depth in { 1: 0, 2: 0, 4: 0, 8: 0, 16: 0 })) throw new Error(`Unsupported PNG bit depth ${depth}`);
  const channels = CHANNELS[colorType];
  if (channels === undefined) throw new Error(`Unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("Indexed PNG has no palette");
  if (idat.length === 0) throw new Error("PNG has no image data");

  // IDAT is one zlib stream *split across chunks* at arbitrary byte boundaries, so the parts have
  // to be joined before inflating — inflating them individually fails on everything but the first.
  const inflated = new Uint8Array(inflateSync(Buffer.concat(idat.map((part) => Buffer.from(part)))));
  const bitsPerPixel = channels * depth;
  const bytesPerRow = Math.ceil((bitsPerPixel * width) / 8);
  const bpp = Math.max(1, Math.ceil(bitsPerPixel / 8));
  if (inflated.length < height * (bytesPerRow + 1)) throw new Error("PNG image data is shorter than its header declares");
  const raw = unfilter(inflated, width, height, bpp, bytesPerRow);

  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const row = raw.subarray(y * bytesPerRow, (y + 1) * bytesPerRow);
    for (let x = 0; x < width; x += 1) {
      const out = (y * width + x) * 4;
      if (colorType === 3) {
        const index = sampleAt(row, x, depth);
        data[out] = palette![index * 3] ?? 0;
        data[out + 1] = palette![index * 3 + 1] ?? 0;
        data[out + 2] = palette![index * 3 + 2] ?? 0;
        // tRNS on an indexed image is a *palette* of alphas, and entries past its end are opaque.
        data[out + 3] = transparency?.[index] ?? 255;
      } else if (colorType === 0 || colorType === 4) {
        const grey = scaleTo8(sampleAt(row, x * channels, depth), depth);
        data[out] = grey;
        data[out + 1] = grey;
        data[out + 2] = grey;
        data[out + 3] = colorType === 4 ? scaleTo8(sampleAt(row, x * channels + 1, depth), depth) : 255;
      } else {
        data[out] = scaleTo8(sampleAt(row, x * channels, depth), depth);
        data[out + 1] = scaleTo8(sampleAt(row, x * channels + 1, depth), depth);
        data[out + 2] = scaleTo8(sampleAt(row, x * channels + 2, depth), depth);
        data[out + 3] = colorType === 6 ? scaleTo8(sampleAt(row, x * channels + 3, depth), depth) : 255;
      }
    }
  }
  return { width, height, data };
}
