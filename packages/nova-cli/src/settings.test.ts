import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadSettings, maskSetting, mergedEnvironment, runSettingsMenu, saveSettings, settingsDirectory, validateSetting } from "./settings";

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

  it("edits and clears values through the numbered menu without echoing secrets", async () => {
    const answers = ["5", "secret-value", "6", "https://api.example.com/v1", "5", "-", "q"];
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
