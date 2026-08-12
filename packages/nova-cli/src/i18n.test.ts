import { describe, expect, it } from "vitest";
import { TRANSLATED_KEYBOARD_IDS, commandDescription, keyboardDescription, resolveControlLanguage } from "./i18n";
import { KEYBOARD_SHORTCUTS } from "./commands";

describe("localized controls", () => {
  it("accepts locale variants and falls back safely", () => {
    expect(resolveControlLanguage("zh-CN")).toBe("zh");
    expect(resolveControlLanguage("ar_EG")).toBe("ar");
    expect(resolveControlLanguage("unknown")).toBe("en");
  });

  it("translates control descriptions while command names stay stable", () => {
    expect(commandDescription("es", "/voice", "fallback")).toContain("Grabar");
    expect(commandDescription("en", "/voice", "fallback")).toBe("fallback");
  });

  it("looks keyboard help up by id, so reordering the list cannot mistranslate it", () => {
    // The bug this closes: the table was positional, so inserting a shortcut at the top moved every
    // translation one row down in nine languages at once, and nothing in English would have shown
    // it. Ctrl-C's description must follow Ctrl-C, wherever Ctrl-C sits in the list.
    expect(keyboardDescription("es", "interrupt", "fallback")).toContain("Interrumpir");
    expect(keyboardDescription("zh", "complete-command", "fallback")).toBe("补全斜杠命令");
  });

  it("falls back to English for a shortcut no language has translated yet", () => {
    // Untranslated is the honest outcome for a new row; mislabelled is not.
    expect(keyboardDescription("es", "menu-move", "Move through any menu")).toBe("Move through any menu");
  });

  it("keeps every translated id pointing at a shortcut that still exists", () => {
    // A renamed or removed shortcut leaves an orphan translation that silently never renders.
    const ids = new Set(KEYBOARD_SHORTCUTS.map(([id]) => id));
    for (const language of ["zh", "es", "fr", "ar", "bn", "pt", "ru", "ur", "hi"] as const) {
      for (const id of Object.keys(TRANSLATED_KEYBOARD_IDS[language] ?? {})) {
        expect(ids, `${language} translates unknown shortcut "${id}"`).toContain(id);
      }
    }
  });
});
