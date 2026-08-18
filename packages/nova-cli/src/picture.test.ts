import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decodePng, isPng, type RgbaImage } from "./png";
import { chooseMode, clearKitty, fitDimensions, glyphRowCount, kittyEnvSignalled, renderGlyph, renderKitty, resample } from "./picture";

/**
 * PNGs are built here rather than committed as fixtures, so a test can state the exact colour type,
 * bit depth and filter it is about. A binary fixture can only be trusted to be what its filename
 * claims, which is how a decoder test ends up asserting against a file nobody can read.
 */
function buildPng(width: number, height: number, colorType: number, depth: number, rows: Uint8Array[], extra: Array<{ type: string; data: number[] }> = []): Uint8Array {
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
    out.set(data, 8);
    // The CRC is left zero: the decoder deliberately does not verify it, because a corrupt chunk
    // that inflates cleanly is vanishingly rare next to the cost of CRC-ing every byte on resize.
    return out;
  };

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = depth;
  header[9] = colorType;
  const raw = Buffer.concat(rows.map((row) => Buffer.from(row)));
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra.map((entry) => chunk(entry.type, new Uint8Array(entry.data))),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  return new Uint8Array(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

/** One unfiltered RGBA scanline: a leading filter byte of 0, then the pixels. */
const rgbaRow = (pixels: number[][]) => new Uint8Array([0, ...pixels.flat()]);

const solid = (width: number, height: number, rgba: number[]): RgbaImage => ({
  width,
  height,
  data: new Uint8Array(Array.from({ length: width * height }, () => rgba).flat()),
});

describe("PNG decoding", () => {
  it("recognises its own signature and rejects everything else", () => {
    expect(isPng(buildPng(1, 1, 6, 8, [rgbaRow([[1, 2, 3, 4]])]))).toBe(true);
    expect(isPng(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false); // JPEG
    expect(isPng(new Uint8Array([]))).toBe(false);
    expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow("Not a PNG");
  });

  it("decodes truecolour with alpha, preserving every channel", () => {
    const png = buildPng(2, 1, 6, 8, [rgbaRow([[255, 0, 0, 255], [0, 128, 255, 128]])]);
    const image = decodePng(png);
    expect({ width: image.width, height: image.height }).toEqual({ width: 2, height: 1 });
    expect([...image.data]).toEqual([255, 0, 0, 255, 0, 128, 255, 128]);
  });

  it("fills in the alpha channel that formats without one do not store", () => {
    // Colour type 2 is RGB. A decoder that leaves alpha at zero produces a fully transparent image
    // that composites to solid background — i.e. renders as a blank box with no error.
    const rgb = buildPng(1, 1, 2, 8, [new Uint8Array([0, 10, 20, 30])]);
    expect([...decodePng(rgb).data]).toEqual([10, 20, 30, 255]);

    const grey = buildPng(1, 1, 0, 8, [new Uint8Array([0, 77])]);
    expect([...decodePng(grey).data]).toEqual([77, 77, 77, 255]);
  });

  it("expands an indexed palette, including its transparency table", () => {
    const png = buildPng(2, 1, 3, 8, [new Uint8Array([0, 1, 0])], [
      { type: "PLTE", data: [255, 0, 0, 0, 255, 0] },
      { type: "tRNS", data: [16] }, // Only entry 0 is listed; entry 1 must read as opaque.
    ]);
    expect([...decodePng(png).data]).toEqual([0, 255, 0, 255, 255, 0, 0, 16]);
  });

  it("scales sub-byte depths to full range rather than leaving them as raw indices", () => {
    // 1-bit greyscale stores 0 and 1. Copied through unscaled, white renders as near-black.
    const png = buildPng(2, 1, 0, 1, [new Uint8Array([0, 0b01000000])]);
    expect([...decodePng(png).data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  /**
   * The five filters are where a decoder silently goes wrong: each reconstructs against the pixel
   * to the left and the row above, so an off-by-one in `bpp` yields an image that decodes without
   * error and is subtly smeared. Each is checked against a hand-computed expectation.
   */
  it("reverses every scanline filter", () => {
    const grey = (rows: Uint8Array[]) => [...decodePng(buildPng(2, 2, 0, 8, rows)).data].filter((_, index) => index % 4 === 0);
    // None, then Sub: 10, then +5 → 15.
    expect(grey([new Uint8Array([0, 10, 20]), new Uint8Array([1, 10, 5])])).toEqual([10, 20, 10, 15]);
    // Up: adds the row above, so 10+3=13 and 20+4=24.
    expect(grey([new Uint8Array([0, 10, 20]), new Uint8Array([2, 3, 4])])).toEqual([10, 20, 13, 24]);
    // Average: value + floor((left + above) / 2). First pixel has no left, so 0+floor(10/2)=5;
    // second is 0 + floor((5 + 20)/2) = 12.
    expect(grey([new Uint8Array([0, 10, 20]), new Uint8Array([3, 0, 0])])).toEqual([10, 20, 5, 12]);
    // Paeth with all-zero deltas reproduces the predictor's own choice, which for the first pixel
    // (left 0, above 10, upper-left 0) is the above value.
    expect(grey([new Uint8Array([0, 10, 20]), new Uint8Array([4, 0, 0])])).toEqual([10, 20, 10, 20]);
  });

  it("refuses what it cannot decode, by name, instead of returning a wrong image", () => {
    const interlaced = buildPng(1, 1, 6, 8, [rgbaRow([[0, 0, 0, 0]])]);
    interlaced[8 + 8 + 12] = 1; // IHDR interlace byte
    expect(() => decodePng(interlaced)).toThrow(/Interlaced/);
    expect(() => decodePng(buildPng(1, 1, 7, 8, [new Uint8Array([0, 0])]))).toThrow(/colour type/);
    expect(() => decodePng(buildPng(1, 1, 3, 8, [new Uint8Array([0, 0])]))).toThrow(/no palette/);
  });

  it("reports a truncated file rather than reading past the end of it", () => {
    const png = buildPng(4, 4, 6, 8, Array.from({ length: 4 }, () => rgbaRow([[1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4], [1, 2, 3, 4]])));
    expect(() => decodePng(png.subarray(0, png.length - 30))).toThrow(/truncated|shorter/);
  });
});

describe("fitting an image to a box of cells", () => {
  /**
   * A cell is about twice as tall as it is wide and the half-block renderer puts two pixels in
   * each, so the pixel canvas of a `cols × rows` box is `cols × rows*2`. Forget the doubling and
   * every image renders squashed to half height.
   */
  it("treats a cell as two pixels tall", () => {
    expect(fitDimensions({ width: 100, height: 100 }, 10, 10, "fill")).toEqual({ width: 10, height: 20 });
  });

  it("contains without cropping and covers without gaps", () => {
    const wide = { width: 200, height: 100 };
    // Box is 20x20 cells = 20x40 pixels. Contain picks the smaller scale (0.1) so the whole image
    // fits: 20x10, leaving vertical space. Cover picks the larger (0.4): 80x40, overflowing width.
    expect(fitDimensions(wide, 20, 20, "contain")).toEqual({ width: 20, height: 10 });
    expect(fitDimensions(wide, 20, 20, "cover")).toEqual({ width: 80, height: 40 });
  });

  it("preserves aspect ratio in contain and cover, and only distorts in fill", () => {
    const source = { width: 300, height: 200 };
    for (const mode of ["contain", "cover"] as const) {
      const fitted = fitDimensions(source, 40, 10, mode);
      expect(fitted.width / fitted.height, mode).toBeCloseTo(source.width / source.height, 1);
    }
    expect(fitDimensions(source, 40, 10, "fill")).toEqual({ width: 40, height: 20 });
  });

  it("never returns a zero or negative dimension, however hostile the box", () => {
    for (const [cols, rows] of [[0, 0], [-5, -5], [1, 1], [0.4, 0.4]] as const) {
      for (const mode of ["contain", "cover", "fill"] as const) {
        const fitted = fitDimensions({ width: 1000, height: 3 }, cols, rows, mode);
        expect(fitted.width, `${mode} ${cols}x${rows}`).toBeGreaterThanOrEqual(1);
        expect(fitted.height).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("survives a degenerate source rather than dividing by zero", () => {
    expect(fitDimensions({ width: 0, height: 0 }, 10, 5, "contain")).toEqual({ width: 10, height: 10 });
  });
});

describe("resampling", () => {
  it("returns exactly the requested grid", () => {
    const out = resample(solid(4, 4, [1, 2, 3, 4]), 7, 3);
    expect({ width: out.width, height: out.height }).toEqual({ width: 7, height: 3 });
    expect(out.data).toHaveLength(7 * 3 * 4);
  });

  it("is the identity at the same size", () => {
    const source = solid(3, 3, [9, 8, 7, 6]);
    expect([...resample(source, 3, 3).data]).toEqual([...source.data]);
  });

  it("keeps a solid colour solid at every scale, which nearest-neighbour must", () => {
    const source = solid(10, 10, [40, 50, 60, 255]);
    for (const [width, height] of [[3, 3], [25, 7], [1, 1]] as const) {
      const out = resample(source, width, height);
      expect([...new Set(out.data)], `${width}x${height}`).toEqual([40, 50, 60, 255].filter((value, index, all) => all.indexOf(value) === index));
    }
  });

  it("samples pixel centres, so a two-tone image does not shift under scaling", () => {
    // Left half black, right half white. Halving the width must keep one of each, not two of one.
    const source: RgbaImage = { width: 4, height: 1, data: new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255, 255, 255, 255]) };
    const out = resample(source, 2, 1);
    expect([out.data[0], out.data[4]]).toEqual([0, 255]);
  });
});

describe("glyph rendering", () => {
  const image = solid(8, 8, [10, 20, 30, 255]);

  it("emits one line per two pixel rows, and never more than the box allows", () => {
    const lines = renderGlyph(image, { cols: 8, rows: 4, fit: "fill" });
    expect(lines).toHaveLength(4);
    expect(glyphRowCount(image, 8, 4, "fill")).toBe(4);
  });

  it("agrees with its own row-count predictor in every fit mode", () => {
    // The predictor exists so a caller can reserve rows before rendering. If the two disagree, the
    // layout reserves the wrong number of rows and the picture overwrites whatever is below it.
    for (const mode of ["contain", "cover", "fill"] as const) {
      for (const [cols, rows] of [[20, 5], [7, 3], [40, 12], [1, 1]] as const) {
        const source = { width: 123, height: 45 };
        const pixels: RgbaImage = { ...source, data: new Uint8Array(123 * 45 * 4).fill(200) };
        expect(renderGlyph(pixels, { cols, rows, fit: mode }), `${mode} ${cols}x${rows}`)
          .toHaveLength(glyphRowCount(source, cols, rows, mode));
      }
    }
  });

  it("paints two independent pixels per cell, as a foreground and a background colour", () => {
    const twoTone: RgbaImage = { width: 1, height: 2, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
    const [line] = renderGlyph(twoTone, { cols: 1, rows: 1, fit: "fill" });
    expect(line).toContain("\x1b[38;2;255;0;0m"); // upper pixel → foreground
    expect(line).toContain("\x1b[48;2;0;0;255m"); // lower pixel → background
    expect(line).toContain("▀");
    expect(line.endsWith("\x1b[0m")).toBe(true); // never leaks colour onto the next line
  });

  it("composites transparency onto the given background instead of rendering it black", () => {
    const clear: RgbaImage = { width: 1, height: 2, data: new Uint8Array([255, 255, 255, 0, 255, 255, 255, 0]) };
    const [line] = renderGlyph(clear, { cols: 1, rows: 1, fit: "fill", background: [20, 40, 60] });
    expect(line).toContain("38;2;20;40;60");
  });

  it("falls back to a grey ramp with no escape codes at all when colour is unavailable", () => {
    const lines = renderGlyph(image, { cols: 4, rows: 2, fit: "fill", color: "none" });
    expect(lines.join("")).not.toContain("\x1b");
    expect(lines.every((line) => [...line].length === 4)).toBe(true);
  });

  it("renders an odd pixel height without a black stripe along the bottom", () => {
    // 3 pixel rows means the last cell has no lower neighbour. Reading past the buffer yields
    // zeros — a black band that looks like part of the picture rather than like a bug.
    const source = solid(2, 3, [90, 90, 90, 255]);
    const lines = renderGlyph(source, { cols: 2, rows: 2, fit: "fill" });
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("48;2;90;90;90");
    expect(lines[1]).not.toContain("48;2;0;0;0");
  });
});

describe("Kitty graphics", () => {
  const png = buildPng(1, 1, 6, 8, [rgbaRow([[1, 2, 3, 4]])]);

  it("wraps a small payload in one escape sequence carrying the cell size", () => {
    const out = renderKitty(png, { cols: 20, rows: 10, id: 42 });
    expect(out.startsWith("\x1b_G")).toBe(true);
    expect(out.endsWith("\x1b\\")).toBe(true);
    expect(out).toContain("a=T");
    expect(out).toContain("f=100"); // the payload is a PNG file, not raw pixels
    expect(out).toContain("c=20,r=10");
    expect(out).toContain("i=42");
  });

  /**
   * The protocol caps a sequence at 4096 base64 characters. A terminal handed one oversized
   * sequence renders nothing at all — and "nothing at all" is indistinguishable from an unsupported
   * terminal, so this is the bug that would send someone hunting the wrong problem.
   */
  it("splits a large payload into conforming chunks, flagged so the terminal knows more follows", () => {
    // Deliberately incompressible: a gradient deflates to well under one chunk, so a test built on
    // one would assert chunking behaviour that never actually ran. A deterministic PRNG keeps the
    // payload large and the test reproducible.
    let seed = 1;
    const noise = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed >> 16) & 0xff; };
    const big = buildPng(64, 64, 6, 8, Array.from({ length: 64 }, () => rgbaRow(Array.from({ length: 64 }, () => [noise(), noise(), noise(), 255]))));
    const out = renderKitty(big, { cols: 10, rows: 5 });
    const chunks = out.split("\x1b\\").filter(Boolean);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.slice(chunk.indexOf(";") + 1).length).toBeLessThanOrEqual(4096);
    // Only the first chunk carries the header; every chunk but the last says "more follows".
    expect(chunks[0]).toContain("f=100");
    expect(chunks.slice(1).every((chunk) => !chunk.includes("f=100"))).toBe(true);
    expect(chunks.slice(0, -1).every((chunk) => chunk.includes("m=1"))).toBe(true);
    expect(chunks.at(-1)).toContain("m=0");
  });

  it("can delete an image by id, so a redraw replaces rather than stacks", () => {
    expect(clearKitty(7)).toBe("\x1b_Ga=d,d=i,i=7\x1b\\");
  });
});

describe("choosing a renderer", () => {
  /**
   * The asymmetry here is the safety property. Glyphs in a Kitty terminal are merely uglier; Kitty
   * escapes in a terminal that cannot read them are dumped as raw bytes and wreck the display. So
   * Kitty needs an explicit request *and* affirmative capability, and "unknown" is not affirmative.
   */
  it("uses Kitty only on an explicit request and affirmative capability", () => {
    expect(chooseMode("kitty", "supported")).toBe("kitty");
    expect(chooseMode("kitty", "unknown")).toBe("glyph");
    expect(chooseMode("kitty", "unsupported")).toBe("glyph");
    expect(chooseMode("glyph", "supported")).toBe("glyph");
  });

  it("reads the environment as a hint about which terminals are worth probing", () => {
    expect(kittyEnvSignalled({ TERM: "xterm-kitty" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(kittyEnvSignalled({ KITTY_WINDOW_ID: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(kittyEnvSignalled({ TERM_PROGRAM: "ghostty" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(kittyEnvSignalled({ TERM_PROGRAM: "WezTerm" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(kittyEnvSignalled({ TERM: "xterm-256color" } as unknown as NodeJS.ProcessEnv)).toBe(false);
    expect(kittyEnvSignalled({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("decoding and rendering together", () => {
  /**
   * The functional level: a real PNG, decoded and rendered, with the colours that went in coming
   * back out. Every unit above can pass while the pipeline is wired up wrong.
   */
  it("takes PNG bytes all the way to coloured terminal lines", () => {
    const png = buildPng(2, 2, 6, 8, [
      rgbaRow([[255, 0, 0, 255], [0, 255, 0, 255]]),
      rgbaRow([[0, 0, 255, 255], [255, 255, 0, 255]]),
    ]);
    const lines = renderGlyph(decodePng(png), { cols: 2, rows: 1, fit: "fill" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("38;2;255;0;0"); // top-left as foreground
    expect(lines[0]).toContain("48;2;0;0;255"); // bottom-left as background
    expect(lines[0]).toContain("38;2;0;255;0");
    expect(lines[0]).toContain("48;2;255;255;0");
  });
});
