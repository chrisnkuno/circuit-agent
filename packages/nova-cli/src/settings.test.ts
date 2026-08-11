import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SETTING_FIELDS, loadSettings, maskSetting, mergedEnvironment, runSettingsMenu, saveSettings, settingsDirectory, validateSetting, type SettingKey } from "./settings";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

describe("Nova settings", () => {
  it("uses native config locations on each desktop platform", () => {
    expect(settingsDirectory({ APPDATA: "C:\\Users\\Nova\\AppData\\Roaming" }, "win32")).toContain(path.join("Nova"));
    expect(settingsDirectory({}, "darwin")).toContain(path.join("Library", "Application Support", "Nova"));
    expect(settingsDirectory({ XDG_CONFIG_HOME: "/tmp/config" }, "linux")).toBe(path.join("/tmp/config", "nova"));
  });

  it("persists only allowed settings and lets process environment override them", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-settings-")); roots.push(root);
    const environment = { NOVA_CONFIG_DIR: root };
    await saveSettings({ OPENAI_API_KEY: "saved-key", OPENAI_BASE_URL: "https://example.com/v1" }, environment);
    const loaded = await loadSettings(environment);
    expect(loaded.OPENAI_API_KEY).toBe("saved-key");
    expect(mergedEnvironment(loaded, { OPENAI_API_KEY: "environment-key" }).OPENAI_API_KEY).toBe("environment-key");
    if (process.platform !== "win32") expect((await fs.stat(path.join(root, "settings.json"))).mode & 0o777).toBe(0o600);
  });

  it("validates URLs and masks secrets", () => {
    expect(validateSetting("OPENAI_BASE_URL", "https://api.example.com/v1/")).toBe("https://api.example.com/v1");
    expect(validateSetting("OPENAI_BASE_URL", "http://localhost:11434/v1")).toBe("http://localhost:11434/v1");
    expect(() => validateSetting("OPENAI_BASE_URL", "http://public.example.com")).toThrow("HTTPS");
    expect(maskSetting("sk-123456789")).toBe("sk-…789");
  });

  it("takes a location as a country code and normalises it", () => {
    expect(validateSetting("NOVA_COUNTRY", "rw")).toBe("RW");
    expect(validateSetting("NOVA_COUNTRY", " eg ")).toBe("EG");
  });

  it("refuses a country it cannot price in, rather than saving a setting that does nothing", () => {
    // The failure this prevents is the quiet one: the user says where they are, sees it saved, and
    // still reads dollars, with nothing on screen connecting the two.
    expect(() => validateSetting("NOVA_COUNTRY", "ZZ")).toThrow("No local currency is known");
    expect(() => validateSetting("NOVA_COUNTRY", "Rwanda")).toThrow("two-letter");
  });

  it("takes an explicit display currency, and refuses one it cannot convert to", () => {
    expect(validateSetting("NOVA_CURRENCY", "rwf")).toBe("RWF");
    expect(() => validateSetting("NOVA_CURRENCY", "XYZ")).toThrow("not a currency");
  });

  it("accepts only real providers as the remembered default, normalised to lower case", () => {
    // resolveProvider ignores an unrecognised NOVA_PROVIDER rather than failing to start, so a typo
    // entered here would otherwise be accepted and then silently do nothing.
    expect(validateSetting("NOVA_PROVIDER", "OpenAI")).toBe("openai");
    expect(validateSetting("NOVA_PROVIDER", "anthropic")).toBe("anthropic");
    expect(() => validateSetting("NOVA_PROVIDER", "gemini")).toThrow("anthropic");
  });

  it("edits and clears values through the numbered menu without echoing secrets", async () => {
    // Derived, not hardcoded: the menu numbers a field by its position in SETTING_FIELDS, so
    // adding a setting renumbers every field below it and a literal "5" quietly starts editing a
    // different setting than the one this test is about.
    const position = (key: SettingKey) => String(SETTING_FIELDS.findIndex((field) => field.key === key) + 1);
    const answers = [position("OPENAI_API_KEY"), "secret-value", position("OPENAI_BASE_URL"), "https://api.example.com/v1", position("OPENAI_API_KEY"), "-", "q"];
    const writes: string[] = [];
    const result = await runSettingsMenu({}, {
      ask: async () => answers.shift()!,
      askSecret: async () => answers.shift()!,
      write: (text) => writes.push(text),
    });
    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.OPENAI_BASE_URL).toBe("https://api.example.com/v1");
    expect(writes.join("")).not.toContain("secret-value");
  });
});

describe("the first run someone actually sees", () => {
  function scriptedPrompts(answers: string[]) {
    const written: string[] = [];
    return {
      written,
      prompts: {
        ask: async () => answers.shift() ?? "q",
        askSecret: async () => answers.shift() ?? "q",
        write: (text: string) => { written.push(text); },
      },
    };
  }

  it("asks only which provider key you have, not all twenty-four settings", async () => {
    // The obstacle this removes: someone installing Nova to use Claude was shown a 24-item list
    // with "Anthropic API key" at position 2, between a language selector and a relay secret.
    const { written, prompts } = scriptedPrompts(["q"]);
    await runSettingsMenu({}, prompts, { focus: "providers" });
    const screen = written.join("");
    expect(screen).toContain("Anthropic API key");
    expect(screen).toContain("OpenAI API key");
    expect(screen).toContain("CircuitNotion API key");
    // None of the things a first run has no opinion about.
    expect(screen).not.toContain("Cached input price");
    expect(screen).not.toContain("Microphone device");
    expect(screen).not.toContain("E2B template");
    expect(screen).not.toContain("Key bindings");
  });

  it("still offers everything else, one keystroke away", async () => {
    const { written, prompts } = scriptedPrompts(["a", "q"]);
    await runSettingsMenu({}, prompts, { focus: "providers" });
    const screen = written.join("");
    expect(screen).toContain("everything else");
    expect(screen).toContain("Microphone device override"); // revealed after "a"
  });

  it("saves the key against the right setting even though the menu is renumbered", async () => {
    // The focused list has its own numbering; "2" here is OpenAI, not the second global field.
    const { prompts } = scriptedPrompts(["2", "sk-openai-typed-by-user", "q"]);
    const settings = await runSettingsMenu({}, prompts, { focus: "providers" });
    expect(settings.OPENAI_API_KEY).toBe("sk-openai-typed-by-user");
    expect(settings.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("shows the full list by default, so /settings is unchanged", async () => {
    const { written, prompts } = scriptedPrompts(["q"]);
    await runSettingsMenu({}, prompts);
    expect(written.join("")).toContain("Microphone device override");
  });
});
