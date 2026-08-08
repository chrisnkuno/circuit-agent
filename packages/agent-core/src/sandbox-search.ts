import type { InteractiveCodingSandboxProvider } from "./providers/contracts";

/**
 * Text search inside a sandbox, for every caller that needs it.
 *
 * Shared rather than written twice because the two callers — the hosted iterative worker and Nova
 * CLI's remote backend — had the same defect independently: both shelled out to `rg`, and E2B's
 * stock `base` image does not ship it. Probed against a live sandbox, `rg` exits 127 there, and
 * `grep` is not on the command allowlist, so content search was simply unavailable on the default
 * image. An agent that cannot search is reduced to guessing which file to open.
 *
 * So: ripgrep when the image has it, and otherwise read the candidate files back and match here.
 * The fallback is slower — every file is a round trip — but a slow search beats a dead one, and
 * results no longer depend on which image a run happens to land on.
 */

export type SandboxGrepMatch = { path: string; line: number; text: string };

export type SandboxSearchOptions = {
  sandbox: InteractiveCodingSandboxProvider;
  sandboxId: string;
  /** Absolute workspace root inside the sandbox. */
  root: string;
  query: string;
  /** Glob limiting which files are searched, matched against workspace-relative paths. */
  includeMatcher?: RegExp;
  regex?: boolean;
  maxMatches?: number;
  /** Cap on files read in the fallback path, since each one is a round trip. */
  maxFilesRead?: number;
  ignoredDirectories?: readonly string[];
};

export const DEFAULT_IGNORED_DIRECTORIES = [".git", "node_modules", ".next", "dist", "build", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", "vendor", ".nova"] as const;

/** Every file under the sandbox workspace root, as absolute paths. */
export async function listSandboxFiles(
  sandbox: InteractiveCodingSandboxProvider,
  sandboxId: string,
  root: string,
  ignoredDirectories: readonly string[] = DEFAULT_IGNORED_DIRECTORIES,
): Promise<string[]> {
  const result = await sandbox.runCommand(sandboxId, {
    program: "find",
    args: [root, "-type", "f", ...ignoredDirectories.flatMap((directory) => ["-not", "-path", `*/${directory}/*`])],
    cwd: root,
    timeoutMs: 30_000,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** `rg` exits 0 with matches, 1 with none, 2 on error, and 127 when the image lacks it. */
const RIPGREP_MISSING = 127;

export async function searchSandboxText(options: SandboxSearchOptions): Promise<SandboxGrepMatch[]> {
  const { sandbox, sandboxId, root, query } = options;
  const maxMatches = options.maxMatches ?? 200;

  const args = ["--line-number", "--no-heading", "--color=never"];
  if (!options.regex) args.push("--fixed-strings");
  args.push(query, root);

  const result = await sandbox.runCommand(sandboxId, { program: "rg", args, cwd: root, timeoutMs: 30_000 });
  if (result.exitCode === RIPGREP_MISSING) return searchByReading(options);
  if (result.exitCode > 1) throw new Error(result.stderr.trim() || "Search failed.");

  const matches: SandboxGrepMatch[] = [];
  for (const line of result.stdout.split("\n")) {
    const parsed = line.match(/^(.+?):(\d+):(.*)$/);
    if (!parsed) continue;
    const relative = relativeTo(root, parsed[1]);
    if (options.includeMatcher && !options.includeMatcher.test(relative)) continue;
    matches.push({ path: relative, line: Number(parsed[2]), text: parsed[3].slice(0, 400) });
    if (matches.length >= maxMatches) break;
  }
  return matches;
}

/**
 * The no-ripgrep path: same query semantics, same include filter, matched locally.
 *
 * Keeping the semantics identical is the whole point — a project must not get different search
 * results because of which image it runs on.
 */
async function searchByReading(options: SandboxSearchOptions): Promise<SandboxGrepMatch[]> {
  const { sandbox, sandboxId, root, query } = options;
  const maxMatches = options.maxMatches ?? 200;
  const matcher = options.regex ? new RegExp(query) : null;
  const matches: SandboxGrepMatch[] = [];

  const files = await listSandboxFiles(sandbox, sandboxId, root, options.ignoredDirectories);
  for (const file of files.slice(0, options.maxFilesRead ?? 300)) {
    const relative = relativeTo(root, file);
    if (options.includeMatcher && !options.includeMatcher.test(relative)) continue;
    let content: string;
    try {
      content = await sandbox.readFile(sandboxId, file);
    } catch {
      continue; // Binary or unreadable files are skipped, exactly as ripgrep would skip them.
    }
    const lines = content.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (matcher ? matcher.test(lines[index]) : lines[index].includes(query)) {
        matches.push({ path: relative, line: index + 1, text: lines[index].slice(0, 400) });
        if (matches.length >= maxMatches) return matches;
      }
    }
  }
  return matches;
}

function relativeTo(root: string, absolute: string): string {
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : absolute;
}
