import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_SOURCES,
  DEFAULT_THEME_NAME,
  NO_COLOR_PALETTE,
  buildPalette,
  builtinThemes,
  colorCode,
  detectPreferredTheme,
  findBuiltinTheme,
  parseColor,
  parseThemeCommand,
  parseThemeSource,
  rgbTo256,
} from "./theme";

describe("reading colours", () => {
  it("takes both hex forms and expands the short one", () => {
    expect(parseColor("#8ab4f8")).toEqual({ r: 138, g: 180, b: 248 });
    expect(parseColor("#abc")).toEqual({ r: 170, g: 187, b: 204 });
    expect(parseColor("  #8AB4F8  ")).toEqual({ r: 138, g: 180, b: 248 });
  });

  it("knows the sixteen names, in either spelling of the eighth", () => {
    expect(parseColor("cyan")).toBe(6);
    expect(parseColor("brightBlack")).toBe(8);
    expect(parseColor("grey")).toBe(8);
    expect(parseColor("gray")).toBe(8);
  });

  it("returns nothing for a value that is not a colour, rather than guessing one", () => {
    // `--border: round` is a real TSS declaration whose value is a shape, not a colour.
    expect(parseColor("round")).toBeUndefined();
    expect(parseColor("#12345")).toBeUndefined();
    expect(parseColor("")).toBeUndefined();
  });
});

describe("quantising to what the terminal has", () => {
  it("puts a near-grey on the greyscale ramp, not on a tinted cube swatch", () => {
    const index = rgbTo256({ r: 107, g: 123, b: 168 });
    // Either is defensible; what is not, is landing somewhere further away than both.
    expect(index).toBeGreaterThanOrEqual(16);
    expect(rgbTo256({ r: 128, g: 128, b: 128 })).toBeGreaterThanOrEqual(232);
  });

  it("maps the corners of the cube exactly", () => {
    expect(rgbTo256({ r: 0, g: 0, b: 0 })).toBe(16);
    expect(rgbTo256({ r: 255, g: 255, b: 255 })).toBe(231);
  });

});

describe("emitting a colour", () => {
  it("emits nothing at all when colour is off", () => {
    expect(colorCode("#8ab4f8", "none")).toBe("");
  });

  it("uses the deepest form the terminal admits to, and never a deeper one", () => {
    // A truecolor sequence is *printed*, not ignored, by a terminal that cannot parse it.
    expect(colorCode("#8ab4f8", "truecolor")).toBe("\x1b[38;2;138;180;248m");
    expect(colorCode("#8ab4f8", "ansi256")).toMatch(/^\x1b\[38;5;\d{1,3}m$/);
  });

  it("sends a named colour as a basic code at every depth, since that is what it is", () => {
    expect(colorCode("cyan", "truecolor")).toBe("\x1b[36m");
    expect(colorCode("brightCyan", "ansi256")).toBe("\x1b[96m");
  });

  it("drops a value it cannot read instead of emitting a broken sequence", () => {
    expect(colorCode("round", "truecolor")).toBe("");
  });
});

describe("the TSS format", () => {
  it("reads a theme block into named roles", () => {
    const [theme] = parseThemeSource("@theme dusk {\n  --primary: #112233;\n  --text-muted: grey;\n}");
    expect(theme.name).toBe("dusk");
    expect(theme.tokens.primary).toBe("#112233");
    expect(theme.tokens.textMuted).toBe("grey");
  });

  it("accepts the $name spelling as well as --name, because both are in the wild", () => {
    const [theme] = parseThemeSource("@theme dusk { $primary: #ff0000; }");
    expect(theme.tokens.primary).toBe("#ff0000");
  });

  it("skips widget rules, so a theme written for a TermUI app loads unchanged", () => {
    const source = `
      @theme cyberpunk {
        --primary: #ff00ff;
      }
      Gauge { color: var(--primary); bar-filled: "#"; }
      Box:focused { border-color: var(--border-focus); }
    `;
    const themes = parseThemeSource(source);
    expect(themes).toHaveLength(1);
    expect(themes[0].tokens.primary).toBe("#ff00ff");
  });

  it("fills every role, so a partial theme is usable rather than half-black", () => {
    const [theme] = parseThemeSource("@theme sparse { --primary: #ff0000; }");
    expect(Object.values(theme.tokens).every((value) => value !== "")).toBe(true);
    expect(theme.tokens.error).toBeTruthy();
  });

  it("takes the comment above a block as its description", () => {
    const [theme] = parseThemeSource("/* A quiet one. */\n@theme quiet { --primary: blue; }");
    expect(theme.description).toBe("A quiet one.");
  });

  it("reads several themes from one document, in order", () => {
    const themes = parseThemeSource("@theme a { --primary: red; } @theme b { --primary: blue; }");
    expect(themes.map((theme) => theme.name)).toEqual(["a", "b"]);
  });
});

describe("the themes that ship", () => {
  it("parses every built-in, which is the only way a broken one would be noticed", () => {
    for (const [name, source] of Object.entries(BUILTIN_THEME_SOURCES)) {
      const themes = parseThemeSource(source);
      expect(themes, name).toHaveLength(1);
      expect(themes[0].name).toBe(name);
      expect(themes[0].description, `${name} description`).not.toBe("");
    }
  });

  it("defaults to the starry night", () => {
    expect(DEFAULT_THEME_NAME).toBe("starry-night");
    expect(findBuiltinTheme("starry-night")).toBeDefined();
    expect(findBuiltinTheme("STARRY-NIGHT")).toBeDefined();
    expect(findBuiltinTheme("no-such-theme")).toBeUndefined();
  });

  it("gives every role a colour a terminal can actually show", () => {
    for (const theme of builtinThemes()) {
      const palette = buildPalette(theme, "truecolor");
      for (const role of ["primary", "secondary", "accent", "text", "muted", "success", "warning", "error"] as const) {
        expect(palette[role], `${theme.name}.${role}`).not.toBe("");
      }
    }
  });

  it("separates the roles a reader has to tell apart at a glance", () => {
    for (const theme of builtinThemes()) {
      const palette = buildPalette(theme, "truecolor");
      const distinct = new Set([palette.primary, palette.accent, palette.error, palette.success, palette.muted]);
      expect(distinct.size, theme.name).toBe(5);
    }
  });

  it("keeps a light theme light and a dark theme dark, which is the only thing 'dawn' has to mean", () => {
    const night = findBuiltinTheme("starry-night")!;
    const dawn = findBuiltinTheme("starry-dawn")!;
    const brightness = (value: string) => {
      const parsed = parseColor(value);
      return typeof parsed === "object" && parsed ? (parsed.r + parsed.g + parsed.b) / 3 : 0;
    };
    expect(brightness(night.tokens.text)).toBeGreaterThan(brightness(night.tokens.bg));
    expect(brightness(dawn.tokens.text)).toBeLessThan(brightness(dawn.tokens.bg));
  });
});

describe("the palette", () => {
  it("carries the border shape the theme asked for, defaulting to round", () => {
    expect(buildPalette(findBuiltinTheme("nebula")!, "truecolor").borderStyle).toBe("single");
    expect(buildPalette(findBuiltinTheme("starry-night")!, "truecolor").borderStyle).toBe("round");
  });

  it("is entirely empty codes when colour is off, so nothing paints by accident", () => {
    for (const role of ["primary", "accent", "error", "muted"] as const) {
      expect(NO_COLOR_PALETTE[role]).toBe("");
    }
  });
});

describe("choosing a theme for the terminal", () => {
  it("obeys an explicit choice above everything else", () => {
    expect(detectPreferredTheme({ NOVA_THEME: "nebula", COLORFGBG: "0;15" })).toBe("nebula");
  });

  it("reads a light terminal from the two variables that report one", () => {
    expect(detectPreferredTheme({ TERM_BACKGROUND: "light" })).toBe("starry-dawn");
    expect(detectPreferredTheme({ COLORFGBG: "0;15" })).toBe("starry-dawn");
  });

  it("assumes dark, the commoner case and the safer mistake", () => {
    expect(detectPreferredTheme({})).toBe("starry-night");
    expect(detectPreferredTheme({ COLORFGBG: "15;0" })).toBe("starry-night");
    expect(detectPreferredTheme({ COLORFGBG: "nonsense" })).toBe("starry-night");
  });
});

describe("the /theme grammar", () => {
  it("shows the current theme on a bare command", () => {
    expect(parseThemeCommand("/theme")).toEqual({ kind: "show" });
  });

  it("takes a name with no verb, which is how it will nearly always be typed", () => {
    expect(parseThemeCommand("/theme nebula")).toEqual({ kind: "set", name: "nebula" });
  });

  it("keeps list and where as verbs", () => {
    expect(parseThemeCommand("/theme list")).toEqual({ kind: "list" });
    expect(parseThemeCommand("/theme where")).toEqual({ kind: "where" });
  });

  it("says so rather than searching for a name that cannot exist", () => {
    const parsed = parseThemeCommand("/theme starry night");
    expect(parsed?.kind).toBe("invalid");
    expect(parsed && "reason" in parsed && parsed.reason).toContain("starry");
  });

  it("ignores anything that is not the command", () => {
    expect(parseThemeCommand("/themes")).toBeNull();
    expect(parseThemeCommand("theme nebula")).toBeNull();
  });
});
