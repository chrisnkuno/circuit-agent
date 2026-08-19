import { describe, expect, it } from "vitest";
import { galleryVariants, renderGallery } from "./gallery";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { clipTo } from "./chooser";
import { visibleWidth } from "./markdown";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * The properties a rendered screen has to have whatever it contains.
 *
 * These are the failures the per-component tests cannot see, because each one asserts what its own
 * component *contains* rather than what the finished screen *looks like*: a row two columns too
 * wide, a glyph the terminal was told it could not draw, an escape code on a monochrome terminal.
 * Every one of those has to be found by rendering everything at once and measuring it — which is
 * what the gallery is for, and why it is worth a test as well as a command.
 */
describe("the whole component gallery", () => {
  it("never emits a non-ASCII character when the ASCII glyph set is in use", () => {
    for (const width of [100, 80, 60, 40, 24]) {
      const rendered = renderGallery({ width, depth: "none", glyphs: ASCII_GLYPHS });
      const offenders = rendered.split("\n").filter((line) => /[^\x00-\x7F]/.test(line));
      expect(offenders, `at width ${width}`).toEqual([]);
    }
  });

  it("emits no escape codes at all when the terminal has no colour", () => {
    expect(renderGallery({ width: 80, depth: "none", glyphs: UNICODE_GLYPHS })).not.toMatch(/\x1b\[/);
  });

  it("keeps every framed row inside the terminal, at every width", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      for (const width of [100, 80, 60, 40, 30]) {
        const lines = plain(renderGallery({ width, depth: "none", glyphs })).split("\n");
        // Code inside a fence is deliberately never re-wrapped — a broken line of code misstates
        // the file — so it is the one thing allowed past the edge. Everything that draws a frame
        // must fit inside one.
        const framed = lines.filter((line) => /[│|╭╰┌└+]/.test(line) && !/^\s*[│|] /.test(line));
        for (const line of framed) expect(visibleWidth(line), `${visibleWidth(line)} > ${width}: ${line}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("renders every variant without throwing, however narrow", () => {
    for (const variant of galleryVariants(80)) expect(renderGallery(variant.options).length).toBeGreaterThan(0);
    for (const width of [1, 4, 12, 24]) expect(() => renderGallery({ width, depth: "none" })).not.toThrow();
  });
});

describe("clipping", () => {
  it("reserves room for the mark the terminal will actually draw", () => {
    for (const glyphs of [UNICODE_GLYPHS, ASCII_GLYPHS]) {
      for (const width of [1, 2, 3, 4, 8, 20, 40]) {
        const clipped = clipTo("a very long label that will not fit in any of these widths", width, glyphs);
        expect(visibleWidth(clipped), `${glyphs === ASCII_GLYPHS ? "ascii" : "unicode"} at ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("drops the mark rather than the text when there is no room for both", () => {
    expect(clipTo("abcdef", 2, ASCII_GLYPHS)).toBe("ab");
    expect(clipTo("abcdef", 3, ASCII_GLYPHS)).toBe("abc");
    expect(clipTo("abcdef", 4, ASCII_GLYPHS)).toBe("a...");
  });

  it("leaves text that already fits exactly alone", () => {
    expect(clipTo("abcd", 4)).toBe("abcd");
    expect(clipTo("abcd", 40)).toBe("abcd");
  });
});
