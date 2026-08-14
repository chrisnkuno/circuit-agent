import { promises as fs } from "node:fs";
import path from "node:path";
import { settingsDirectory } from "./settings";
import { BUILTIN_THEME_SOURCES, parseThemeSource, type Theme } from "./theme";

/**
 * Themes that came from a file rather than from this binary.
 *
 * Scoped exactly like memory (`memory.ts`): one directory belongs to the repository and can be
 * committed so a team shares a look, one follows the person across every project. A theme is a
 * `.tss` file in either — the same file a TermUI app reads, so a palette written once is not
 * written twice.
 *
 * Discovery is by directory listing rather than by a registry file. A registry is one more thing to
 * keep in sync with the filesystem, and the failure mode — a theme that is present but invisible
 * because nothing registered it — is precisely the one people cannot debug.
 */

export type ThemeSource = "builtin" | "project" | "user";

export type DiscoveredTheme = Theme & {
  source: ThemeSource;
  /** Absent for built-ins, which have no file to open. */
  file?: string;
};

export function themeDirectory(scope: "project" | "user", root: string, environment: Record<string, string | undefined>): string {
  return scope === "project"
    ? path.join(root, ".nova", "themes")
    : path.join(settingsDirectory(environment), "themes");
}

async function readThemeDirectory(directory: string, source: ThemeSource): Promise<DiscoveredTheme[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    // No theme directory is the ordinary case, not an error worth reporting.
    return [];
  }

  const themes: DiscoveredTheme[] = [];
  for (const entry of entries.filter((name) => name.endsWith(".tss")).sort()) {
    const file = path.join(directory, entry);
    try {
      const contents = await fs.readFile(file, "utf8");
      // A file with no @theme block in it contributes nothing rather than failing the listing —
      // TSS files legitimately contain only widget rules.
      for (const theme of parseThemeSource(contents)) themes.push({ ...theme, source, file });
    } catch {
      // A theme that cannot be read is skipped, not fatal: one bad file must not cost the user
      // every other theme they have, nor stop the session from starting.
    }
  }
  return themes;
}

/**
 * Every theme available, with later scopes shadowing earlier ones by name.
 *
 * Built-in first, then personal, then the project's — the same precedence memory uses, and for the
 * same reason: the repository is the most specific statement about the work at hand, so a project
 * that ships `starry-night.tss` gets its own version of it.
 */
export async function discoverThemes(root: string, environment: Record<string, string | undefined>): Promise<DiscoveredTheme[]> {
  const builtin: DiscoveredTheme[] = Object.values(BUILTIN_THEME_SOURCES)
    .flatMap((source) => parseThemeSource(source))
    .map((theme) => ({ ...theme, source: "builtin" as const }));

  const user = await readThemeDirectory(themeDirectory("user", root, environment), "user");
  const project = await readThemeDirectory(themeDirectory("project", root, environment), "project");

  const byName = new Map<string, DiscoveredTheme>();
  for (const theme of [...builtin, ...user, ...project]) byName.set(theme.name.toLowerCase(), theme);
  return [...byName.values()];
}

export async function findTheme(
  name: string,
  root: string,
  environment: Record<string, string | undefined>,
): Promise<DiscoveredTheme | undefined> {
  const wanted = name.trim().toLowerCase();
  return (await discoverThemes(root, environment)).find((theme) => theme.name.toLowerCase() === wanted);
}
