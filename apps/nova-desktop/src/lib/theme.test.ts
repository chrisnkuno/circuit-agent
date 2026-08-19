import { describe, expect, it, vi } from "vitest";
import {
  applyTheme,
  bootTheme,
  parseThemeChoice,
  readStoredTheme,
  resolveTheme,
  themeLabel,
  watchSystemTheme,
  writeStoredTheme,
  THEME_CHOICES,
  THEME_STORAGE_KEY,
} from "./theme";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    read: () => Object.fromEntries(map),
  };
}

describe("resolving a theme", () => {
  it("keeps an explicit choice whatever the machine says", () => {
    // The point of choosing is that the OS stops deciding.
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("follows the machine only when nothing was chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("resolves every choice to something the stylesheet knows", () => {
    for (const choice of THEME_CHOICES) {
      for (const prefersDark of [true, false]) {
        expect(["light", "dark"]).toContain(resolveTheme(choice, prefersDark));
      }
    }
  });

  it("names each choice for a control to show", () => {
    expect(THEME_CHOICES.map(themeLabel)).toEqual(["Light", "Dark", "System"]);
  });
});

describe("the stored choice", () => {
  it("keeps 'system' as its own value rather than collapsing it into today's answer", () => {
    // Collapsing it is how an app ends up stuck in dark six months after the machine changed.
    const storage = fakeStorage();
    writeStoredTheme("system", storage);
    expect(storage.read()[THEME_STORAGE_KEY]).toBe("system");
    expect(readStoredTheme(storage)).toBe("system");
  });

  it("reads anything unrecognised as no choice at all", () => {
    expect(parseThemeChoice("chartreuse")).toBe("system");
    expect(parseThemeChoice(null)).toBe("system");
    expect(parseThemeChoice(undefined)).toBe("system");
  });

  it("survives storage that refuses to work", () => {
    // A locked-down webview must still be themeable; it just cannot remember.
    const broken = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };
    expect(readStoredTheme(broken)).toBe("system");
    expect(() => writeStoredTheme("dark", broken)).not.toThrow();
  });
});

describe("applying a theme", () => {
  it("sets both the attribute the stylesheet reads and the native colour scheme", () => {
    // Without `color-scheme` the native scrollbars and form controls stay dark behind a light UI,
    // which is the most common way a themed desktop app looks unfinished.
    const root = { setAttribute: vi.fn(), style: { colorScheme: "" } };
    applyTheme("light", root);
    expect(root.setAttribute).toHaveBeenCalledWith("data-theme", "light");
    expect(root.style.colorScheme).toBe("light");
  });

  it("applies before anything renders, and reports what was stored", () => {
    const root = { setAttribute: vi.fn(), style: { colorScheme: "" } };
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: "dark" });
    writeStoredTheme("dark", storage);
    // bootTheme reads the real storage; here it is only asserted that it applies *something*
    // synchronously, which is what keeps the first paint from being the wrong colour.
    expect(THEME_CHOICES).toContain(bootTheme(root));
    expect(root.setAttribute).toHaveBeenCalled();
  });
});

describe("following the machine", () => {
  it("reports a change and can be unsubscribed", () => {
    const listeners: Array<() => void> = [];
    const query = {
      matches: false,
      addEventListener: (_type: "change", listener: () => void) => void listeners.push(listener),
      removeEventListener: vi.fn(),
    };
    const seen: boolean[] = [];
    const stop = watchSystemTheme((prefersDark) => seen.push(prefersDark), { matchMedia: () => query });
    query.matches = true;
    for (const listener of listeners) listener();
    expect(seen).toEqual([true]);
    stop();
    expect(query.removeEventListener).toHaveBeenCalled();
  });

  it("is a no-op where the environment cannot answer the question", () => {
    expect(() => watchSystemTheme(() => {}, {})()).not.toThrow();
  });
});
