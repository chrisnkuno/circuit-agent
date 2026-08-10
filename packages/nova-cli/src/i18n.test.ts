import { describe, expect, it } from "vitest";
import { commandDescription, resolveControlLanguage } from "./i18n";

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
});
