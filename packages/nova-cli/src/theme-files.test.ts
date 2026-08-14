import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverThemes, findTheme, themeDirectory } from "./theme-files";

let root: string;
let home: string;
let environment: Record<string, string | undefined>;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-theme-project-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nova-theme-home-"));
  environment = { NOVA_CONFIG_DIR: home, HOME: home, XDG_CONFIG_HOME: home };
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

async function writeTheme(scope: "project" | "user", name: string, contents: string): Promise<string> {
  const directory = themeDirectory(scope, root, environment);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.tss`);
  await fs.writeFile(file, contents);
  return file;
}

describe("finding themes on disk", () => {
  it("offers the built-ins when there is nothing on disk at all", async () => {
    const themes = await discoverThemes(root, environment);
    expect(themes.map((theme) => theme.name)).toContain("starry-night");
    expect(themes.every((theme) => theme.source === "builtin")).toBe(true);
  });

  it("reads a .tss file the user wrote, and says where it came from", async () => {
    const file = await writeTheme("user", "mine", "@theme mine { --primary: #ff0000; }");
    const found = await findTheme("mine", root, environment);
    expect(found).toMatchObject({ name: "mine", source: "user", file });
    expect(found?.tokens.primary).toBe("#ff0000");
  });

  it("lets the repository's theme win, the way the repository wins everywhere else", async () => {
    await writeTheme("user", "shared", "@theme shared { --primary: #111111; }");
    await writeTheme("project", "shared", "@theme shared { --primary: #222222; }");
    const found = await findTheme("shared", root, environment);
    expect(found).toMatchObject({ source: "project" });
    expect(found?.tokens.primary).toBe("#222222");
  });

  it("lets a project override a built-in by name, without losing the rest of them", async () => {
    await writeTheme("project", "starry-night", "@theme starry-night { --primary: #abcdef; }");
    const themes = await discoverThemes(root, environment);
    expect(themes.filter((theme) => theme.name === "starry-night")).toHaveLength(1);
    expect((await findTheme("starry-night", root, environment))?.tokens.primary).toBe("#abcdef");
    expect(themes.map((theme) => theme.name)).toContain("nebula");
  });

  it("skips a file it cannot parse rather than costing the user every other theme", async () => {
    await writeTheme("user", "broken", "this is not a theme at all {{{");
    await writeTheme("user", "good", "@theme good { --primary: #00ff00; }");
    const themes = await discoverThemes(root, environment);
    expect(themes.map((theme) => theme.name)).toContain("good");
    expect(themes.map((theme) => theme.name)).not.toContain("broken");
  });

  it("ignores files that are not themes", async () => {
    const directory = themeDirectory("user", root, environment);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "notes.md"), "@theme sneaky { --primary: red; }");
    expect((await discoverThemes(root, environment)).map((theme) => theme.name)).not.toContain("sneaky");
  });

  it("matches a name regardless of case, since nobody remembers which it was", async () => {
    await writeTheme("user", "Dusk", "@theme Dusk { --primary: #123456; }");
    expect(await findTheme("dusk", root, environment)).toBeDefined();
    expect(await findTheme("nothing-like-this", root, environment)).toBeUndefined();
  });

  it("keeps the two scopes in separate directories", () => {
    expect(themeDirectory("project", root, environment)).toBe(path.join(root, ".nova", "themes"));
    expect(themeDirectory("user", root, environment)).not.toContain(root);
  });
});
