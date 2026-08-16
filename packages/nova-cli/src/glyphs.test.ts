import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS, borderGlyphsFor, detectGlyphMode, glyphsFor, resolveGlyphs, type GlyphSet } from "./glyphs";

/**
 * The whole point of this module is that a terminal never receives a character it cannot draw, so
 * the tests are about the *relationship* between the two sets rather than about either one's
 * contents: same keys, and the fallback is genuinely ASCII.
 */

describe("glyph sets", () => {
  it("defines every meaning in both sets, so no renderer can ask for one that is missing", () => {
    expect(Object.keys(ASCII_GLYPHS).sort()).toEqual(Object.keys(UNICODE_GLYPHS).sort());
  });

  it("keeps the fallback set inside ASCII — the whole reason it exists", () => {
    for (const [name, value] of Object.entries(ASCII_GLYPHS)) {
      const characters = Array.isArray(value) ? value.join("") : String(value);
      for (const character of characters) {
        expect(character.codePointAt(0), `${name} contains a non-ASCII character`).toBeLessThan(128);
      }
    }
  });

  it("gives the ASCII spinner frames a constant width, so text beside it cannot jitter", () => {
    const widths = new Set(ASCII_GLYPHS.spinnerFrames.map((frame) => frame.length));
    expect(widths.size).toBe(1);
  });

  it("keeps the query caret distinct from the selection cursor in the Unicode set", () => {
    // They mark different things: one is where you type, the other is what Enter would take.
    expect(UNICODE_GLYPHS.caret).not.toBe(UNICODE_GLYPHS.prompt);
  });

  it("offers a brightness ladder rather than a single star, in both sets", () => {
    for (const set of [UNICODE_GLYPHS, ASCII_GLYPHS] as GlyphSet[]) {
      expect(set.starGlyphs.length).toBeGreaterThan(1);
    }
  });
});

describe("detecting what the terminal can draw", () => {
  it("obeys NOVA_GLYPHS over every heuristic, in both directions", () => {
    expect(detectGlyphMode({ NOVA_GLYPHS: "ascii", LANG: "en_US.UTF-8" }, "linux")).toBe("ascii");
    expect(detectGlyphMode({ NOVA_GLYPHS: "unicode", TERM: "linux" }, "linux")).toBe("unicode");
  });

  it("falls back for the framebuffer console and for TERM=dumb", () => {
    expect(detectGlyphMode({ TERM: "linux", LANG: "en_US.UTF-8" }, "linux")).toBe("ascii");
    expect(detectGlyphMode({ TERM: "dumb", LANG: "en_US.UTF-8" }, "linux")).toBe("ascii");
  });

  it("reads the locale's charset, which is the signal that actually produces question marks", () => {
    expect(detectGlyphMode({ LANG: "en_US.UTF-8" }, "linux")).toBe("unicode");
    expect(detectGlyphMode({ LANG: "en_US.utf8" }, "linux")).toBe("unicode");
    expect(detectGlyphMode({ LANG: "en_US.ISO-8859-1" }, "linux")).toBe("ascii");
    expect(detectGlyphMode({ LANG: "C" }, "linux")).toBe("ascii");
  });

  it("prefers LC_ALL over LC_CTYPE over LANG, the way every POSIX tool does", () => {
    expect(detectGlyphMode({ LC_ALL: "C", LC_CTYPE: "en_US.UTF-8", LANG: "en_US.UTF-8" }, "linux")).toBe("ascii");
    expect(detectGlyphMode({ LC_CTYPE: "en_US.UTF-8", LANG: "C" }, "linux")).toBe("unicode");
  });

  it("treats an unset locale as no evidence rather than as evidence of a legacy code page", () => {
    // Containers and CI images routinely ship with no locale at all and a UTF-8 stdout.
    expect(detectGlyphMode({}, "linux")).toBe("unicode");
  });

  it("infers the Windows console from which host is running it", () => {
    expect(detectGlyphMode({}, "win32")).toBe("ascii");
    expect(detectGlyphMode({ WT_SESSION: "abc" }, "win32")).toBe("unicode");
    expect(detectGlyphMode({ TERM_PROGRAM: "vscode" }, "win32")).toBe("unicode");
  });

  it("resolves straight to a usable set", () => {
    expect(resolveGlyphs({ NOVA_GLYPHS: "ascii" }, "linux")).toBe(ASCII_GLYPHS);
    expect(resolveGlyphs({ LANG: "en_GB.UTF-8" }, "linux")).toBe(UNICODE_GLYPHS);
    expect(glyphsFor("ascii")).toBe(ASCII_GLYPHS);
  });

  it("honours NOVA_ASCII, the flag people already reach for, but not when it is switched off", () => {
    expect(detectGlyphMode({ NOVA_ASCII: "1", LANG: "en_US.UTF-8" }, "linux")).toBe("ascii");
    expect(detectGlyphMode({ NOVA_ASCII: "0", LANG: "en_US.UTF-8" }, "linux")).toBe("unicode");
  });
});

describe("borderGlyphsFor", () => {
  it("draws a different corner shape for each style a theme can ask for", () => {
    expect(borderGlyphsFor("round", UNICODE_GLYPHS).topLeft).toBe("╭");
    expect(borderGlyphsFor("single", UNICODE_GLYPHS).topLeft).toBe("┌");
    expect(borderGlyphsFor("double", UNICODE_GLYPHS).topLeft).toBe("╔");
  });

  it("defaults an unrecognized or \"none\" style to round, rather than throwing", () => {
    expect(borderGlyphsFor("none", UNICODE_GLYPHS).topLeft).toBe("╭");
  });

  it("stays inside ASCII on an ASCII terminal regardless of the theme's border style", () => {
    for (const style of ["round", "single", "double", "none"] as const) {
      const border = borderGlyphsFor(style, ASCII_GLYPHS);
      for (const glyph of Object.values(border)) {
        for (const character of glyph) expect(character.codePointAt(0)).toBeLessThan(128);
      }
    }
  });

  it("keeps a double border's horizontal and vertical distinct from a single border's", () => {
    // The line characters change too, not just the corners — a double border with single-style
    // lines would look like a typo, not a deliberate style.
    expect(borderGlyphsFor("double", UNICODE_GLYPHS).horizontal).toBe("═");
    expect(borderGlyphsFor("single", UNICODE_GLYPHS).horizontal).toBe("─");
  });
});
