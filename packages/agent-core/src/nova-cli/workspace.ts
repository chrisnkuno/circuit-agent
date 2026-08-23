import { promises as fs } from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";

/**
 * The filesystem boundary for Nova CLI.
 *
 * Every other part of the CLI reaches the disk through this module, because the CLI runs against a
 * developer's real working tree rather than a disposable sandbox. In the hosted product the E2B
 * container is the boundary — a mistake there costs a container. Here a mistake costs the user's
 * files, so path confinement is enforced in code rather than by the environment.
 *
 * Both OpenCode and Cline settled on the same rule and it is the one adopted here: resolve
 * everything to an absolute path and refuse anything that escapes the project root, including via
 * `..` or a symlink pointing outward.
 */

export type WorkspaceLimits = {
  /** Largest file the agent may read in one call. */
  maxReadBytes: number;
  /** Largest file the agent may write in one call. */
  maxWriteBytes: number;
  /** Files skipped by search and listing, by directory name. */
  ignoredDirectories: readonly string[];
  /**
   * Strips anything shaped like a credential (`*_TOKEN`, `*_SECRET`, ...) from a locally spawned
   * command's environment, not only Nova's own known provider keys. Off by default — see
   * `sanitizeCommandEnvironment` in command.ts for why a project's own env vars are the user's
   * choice to expose, not Nova's to withhold, unless they opt into the stricter posture.
   */
  strictCommandEnvironment?: boolean;
  /**
   * Runs a locally spawned command inside an unprivileged PID namespace when the OS supports one,
   * so a timeout or cancellation reaches every process it spawned — including ones it detached from
   * itself — not only the ones still in its original process group. On by default wherever the OS
   * supports it (checked once and cached; a no-op fallback everywhere else). Set to `false` only for
   * a command that is known to need to see the host's real, unnamespaced PID/mount view.
   */
  containProcessTree?: boolean;
};

export const DEFAULT_WORKSPACE_LIMITS: WorkspaceLimits = {
  maxReadBytes: 512_000,
  maxWriteBytes: 512_000,
  // Generated output, every one of them. `coverage/` alone was 2.85 MB across 92 files in this
  // repository — 30% of every byte `grep_files` read, none of it code anyone wrote. They also churn
  // as builds and test runs come and go, which is its own cost upstream in the prompt.
  ignoredDirectories: [".git", "node_modules", ".next", "dist", "build", "target", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", "vendor", ".nova", "coverage", "test-results", ".convex", ".wrangler"],
};

export class WorkspaceViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceViolation";
  }
}

/**
 * Resolves a candidate path against the workspace root, refusing anything outside it.
 *
 * Lexical resolution only — this deliberately does not touch the disk, so it can be applied to
 * paths that do not exist yet (a file the agent is about to create). `realPathWithin` handles the
 * symlink case for paths that do exist.
 */
export function resolveInWorkspace(root: string, candidate: string): string {
  if (typeof candidate !== "string" || !candidate.trim()) throw new WorkspaceViolation("path must be a non-empty string");
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, candidate);
  if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) {
    throw new WorkspaceViolation(`path escapes the workspace root: ${candidate}`);
  }
  return resolved;
}

/**
 * Confinement for paths that exist, following symlinks first.
 *
 * A symlink inside the tree pointing at `/etc/shadow` passes the lexical check above and would
 * otherwise hand its contents to the model. Non-existent paths fall back to the lexical result,
 * which is correct: nothing can be read through a link that is not there.
 */
export async function realPathWithin(root: string, candidate: string): Promise<string> {
  const resolved = resolveInWorkspace(root, candidate);
  const absoluteRoot = await fs.realpath(path.resolve(root)).catch(() => path.resolve(root));
  const real = await fs.realpath(resolved).catch(() => null);
  if (real === null) return resolved;
  if (real !== absoluteRoot && !real.startsWith(absoluteRoot + path.sep)) {
    throw new WorkspaceViolation(`path resolves outside the workspace root: ${candidate}`);
  }
  // Preserve the caller's lexical spelling after using the canonical path for confinement.
  // macOS commonly canonicalizes /var to /private/var; returning that spelling would make a
  // workspace-relative result look as though it escaped through several parent directories.
  return resolved;
}

/** Path as the user would recognise it — relative to the root, forward-slashed. */
export function displayPath(root: string, absolute: string): string {
  const relative = path.relative(path.resolve(root), absolute);
  return relative === "" ? "." : relative.split(path.sep).join("/");
}

const BINARY_SNIFF_BYTES = 4_096;

/** A NUL byte in the first few KB is how `git` and every editor decide a file is not text. */
export function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export type ReadResult = {
  path: string;
  content: string;
  /** 1-based line the returned slice starts at. */
  startLine: number;
  totalLines: number;
  truncated: boolean;
};

/**
 * Reads a text file, optionally a line window of it.
 *
 * Line windows exist because a 6,000-line file read whole is usually a context-budget mistake, not
 * a request for the whole file — but the window is opt-in, since silently returning part of a file
 * the model believes it read in full is worse than spending the tokens.
 */
export async function readTextFile(
  root: string,
  candidate: string,
  options: { offset?: number; limit?: number; limits?: WorkspaceLimits } = {},
): Promise<ReadResult> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const absolute = await realPathWithin(root, candidate);
  // A missing file must fail the same shape every backend fails it: a project-relative path in a
  // sentence, not a raw ENOENT carrying this machine's absolute filesystem layout. Node's default
  // error for a missing `stat` is exactly that leak — one more path a model reading a "file not
  // found" message across Local, E2B and Docker would otherwise see worded three different ways.
  const stat = await fs.stat(absolute).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new WorkspaceViolation(`${displayPath(root, absolute)} does not exist`);
    throw error;
  });
  if (stat.isDirectory()) throw new WorkspaceViolation(`${displayPath(root, absolute)} is a directory, not a file`);
  if (stat.size > limits.maxReadBytes) {
    throw new WorkspaceViolation(`${displayPath(root, absolute)} is ${stat.size} bytes, above the ${limits.maxReadBytes}-byte read limit`);
  }
  const buffer = await fs.readFile(absolute);
  if (looksBinary(buffer)) throw new WorkspaceViolation(`${displayPath(root, absolute)} looks like a binary file`);

  const text = buffer.toString("utf8");
  const lines = text.split("\n");
  const startLine = Math.max(1, options.offset ?? 1);
  const limit = options.limit;
  if (startLine === 1 && limit === undefined) {
    return { path: displayPath(root, absolute), content: text, startLine: 1, totalLines: lines.length, truncated: false };
  }
  const slice = lines.slice(startLine - 1, limit === undefined ? undefined : startLine - 1 + limit);
  return {
    path: displayPath(root, absolute),
    content: slice.join("\n"),
    startLine,
    totalLines: lines.length,
    truncated: startLine > 1 || (limit !== undefined && startLine - 1 + limit < lines.length),
  };
}

export async function writeTextFile(root: string, candidate: string, content: string, limits = DEFAULT_WORKSPACE_LIMITS): Promise<{ path: string; bytesWritten: number }> {
  if (typeof content !== "string") throw new WorkspaceViolation("content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > limits.maxWriteBytes) throw new WorkspaceViolation(`content is ${bytes} bytes, above the ${limits.maxWriteBytes}-byte write limit`);
  const absolute = resolveInWorkspace(root, candidate);
  // Confirm the parent is inside the tree too: creating a file through a symlinked directory would
  // otherwise write outside the workspace even though the lexical path looked fine.
  await realPathWithin(root, path.dirname(candidate));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
  return { path: displayPath(root, absolute), bytesWritten: bytes };
}

/**
 * Replaces one exact occurrence of `oldText`.
 *
 * Deliberately not a whole-file rewrite: a model that must reproduce an entire file to change one
 * line will eventually reproduce it imperfectly, and the damage is silent. Requiring the old text
 * to appear exactly once makes an ambiguous edit an error rather than a coin flip.
 */
export async function editTextFile(
  root: string,
  candidate: string,
  oldText: string,
  newText: string,
  options: { replaceAll?: boolean; limits?: WorkspaceLimits } = {},
): Promise<{ path: string; replacements: number }> {
  if (typeof oldText !== "string" || oldText === "") throw new WorkspaceViolation("oldText must be a non-empty string");
  if (typeof newText !== "string") throw new WorkspaceViolation("newText must be a string");
  if (oldText === newText) throw new WorkspaceViolation("oldText and newText are identical");

  const existing = await readTextFile(root, candidate, { limits: options.limits });
  const occurrences = existing.content.split(oldText).length - 1;
  if (occurrences === 0) throw new WorkspaceViolation(`oldText was not found in ${existing.path}`);
  if (occurrences > 1 && !options.replaceAll) {
    throw new WorkspaceViolation(`oldText appears ${occurrences} times in ${existing.path}; include more surrounding context or set replaceAll`);
  }
  const updated = options.replaceAll ? existing.content.split(oldText).join(newText) : existing.content.replace(oldText, newText);
  await writeTextFile(root, candidate, updated, options.limits ?? DEFAULT_WORKSPACE_LIMITS);
  return { path: existing.path, replacements: options.replaceAll ? occurrences : 1 };
}

export type WalkEntry = { absolute: string; relative: string; isDirectory: boolean };

/** How many directories are read at once. Enough to hide I/O latency, far below any descriptor limit. */
const WALK_CONCURRENCY = 32;

/** The same, for the file reads a content search does. */
const GREP_CONCURRENCY = 32;

/**
 * Breadth-first walk that never leaves the root and never descends into ignored directories.
 *
 * Reads a whole level of directories at once instead of one at a time. The walk is latency-bound,
 * not CPU-bound — it awaited a single `readdir` and then awaited the next — so this is close to
 * free: measured 41ms to 6ms on this repository, and 302ms to 57ms on a 3,000-directory tree. It
 * backs `glob_files`, `grep_files`, `list_files` and skill discovery, so every one of those pays it.
 *
 * Order is still deterministic, and that is deliberate rather than incidental: the level's
 * directories are read concurrently but their entries are yielded in the order the level was
 * queued, so two runs over an unchanged tree produce identical output. A parallel walk that yielded
 * in completion order would make `glob_files` return a different list on every call, which is a
 * miserable thing to debug and a needless cache invalidation upstream.
 */
export async function* walkWorkspace(root: string, limits = DEFAULT_WORKSPACE_LIMITS, maxEntries = 20_000): AsyncGenerator<WalkEntry> {
  const absoluteRoot = path.resolve(root);
  const ignored = new Set(limits.ignoredDirectories);
  let level: string[] = [absoluteRoot];
  let seen = 0;

  while (level.length > 0) {
    const next: string[] = [];
    for (let start = 0; start < level.length; start += WALK_CONCURRENCY) {
      const batch = level.slice(start, start + WALK_CONCURRENCY);
      // An unreadable directory is not a reason to abandon the whole walk, so each read resolves to
      // its own entries or to nothing.
      const reads = await Promise.all(batch.map(async (directory): Promise<{ directory: string; entries: Dirent[] }> => {
        try {
          return { directory, entries: await fs.readdir(directory, { withFileTypes: true }) };
        } catch {
          return { directory, entries: [] };
        }
      }));
      for (const { directory, entries } of reads) {
        for (const entry of entries) {
          if (seen >= maxEntries) return;
          const absolute = path.join(directory, entry.name);
          // Symlinks are reported but never followed: following them can leave the tree and can loop.
          const isDirectory = entry.isDirectory();
          if (isDirectory && ignored.has(entry.name)) continue;
          seen += 1;
          yield { absolute, relative: displayPath(absoluteRoot, absolute), isDirectory };
          if (isDirectory) next.push(absolute);
        }
      }
    }
    level = next;
  }
}

/**
 * Glob matching for the subset of syntax people actually type: `**`, `*`, `?`, and `{a,b}`.
 *
 * Implemented here rather than pulled in, because a glob library is a dependency whose only job is
 * to build a regular expression, and the CLI's dependency surface is part of its security surface.
 */
export function globToRegExp(pattern: string): RegExp {
  let expression = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        // `**/` may match nothing at all, so `**/x` also matches a top-level `x`.
        if (pattern[index + 2] === "/") {
          expression += "(?:.*/)?";
          index += 2;
        } else {
          expression += ".*";
          index += 1;
        }
      } else {
        expression += "[^/]*";
      }
      continue;
    }
    if (character === "?") { expression += "[^/]"; continue; }
    if (character === "{") {
      const close = pattern.indexOf("}", index);
      if (close > index) {
        expression += `(?:${pattern.slice(index + 1, close).split(",").map(escapeRegExp).join("|")})`;
        index = close;
        continue;
      }
    }
    expression += escapeRegExp(character);
  }
  return new RegExp(`^${expression}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export async function globWorkspace(root: string, pattern: string, limits = DEFAULT_WORKSPACE_LIMITS, maxResults = 500): Promise<string[]> {
  const matcher = globToRegExp(pattern);
  const matches: string[] = [];
  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (matcher.test(entry.relative)) matches.push(entry.relative);
    if (matches.length >= maxResults) break;
  }
  return matches.sort();
}

export type GrepMatch = { path: string; line: number; text: string };

/**
 * Content search across the workspace.
 *
 * Reads files directly rather than shelling out to ripgrep: the CLI must behave identically on a
 * machine that does not have `rg` installed, and a search that silently finds nothing because a
 * binary is missing is the worst possible failure mode for an agent deciding what to edit.
 */
export async function grepWorkspace(
  root: string,
  query: string,
  options: { include?: string; regex?: boolean; maxResults?: number; limits?: WorkspaceLimits } = {},
): Promise<GrepMatch[]> {
  if (typeof query !== "string" || query === "") throw new WorkspaceViolation("query must be a non-empty string");
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const maxResults = options.maxResults ?? 200;
  const include = options.include ? globToRegExp(options.include) : null;
  const matcher = options.regex ? new RegExp(query) : null;
  const matches: GrepMatch[] = [];
  /**
   * The literal being searched for, as bytes.
   *
   * A plain-text search can rule a file out without ever decoding it: `Buffer.indexOf` scans the
   * bytes as they were read, while `toString().split("\n")` allocates roughly three times the
   * file's size to produce a line array that is thrown away when nothing matches — and nothing
   * matches in the overwhelming majority of files. Only meaningful for a non-regex query, which is
   * the common one.
   */
  const literal = matcher ? null : Buffer.from(query, "utf8");

  /** Every match in one file, in line order. Returns an empty list for anything unreadable. */
  const scan = async (entry: WalkEntry): Promise<GrepMatch[]> => {
    let buffer: Buffer;
    try {
      const stat = await fs.stat(entry.absolute);
      if (stat.size > limits.maxReadBytes) return [];
      buffer = await fs.readFile(entry.absolute);
    } catch {
      return [];
    }
    if (looksBinary(buffer)) return [];
    if (literal && buffer.indexOf(literal) === -1) return [];
    const found: GrepMatch[] = [];
    const lines = buffer.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (matcher ? matcher.test(line) : line.includes(query)) {
        found.push({ path: entry.relative, line: index + 1, text: line.slice(0, 400) });
        if (found.length >= maxResults) break;
      }
    }
    return found;
  };

  /**
   * Files are read concurrently, and their matches are appended in walk order.
   *
   * Both halves matter. Reading one file at a time made the search latency-bound on a workload that
   * is almost entirely waiting; appending in completion order would have made two searches of an
   * unchanged tree return the same matches in a different sequence, which is a miserable thing to
   * diff and a needless cache invalidation upstream.
   */
  const batch: WalkEntry[] = [];
  const drain = async (): Promise<boolean> => {
    const scanned = await Promise.all(batch.splice(0, batch.length).map(scan));
    for (const fileMatches of scanned) {
      for (const match of fileMatches) {
        matches.push(match);
        if (matches.length >= maxResults) return true;
      }
    }
    return false;
  };

  for await (const entry of walkWorkspace(root, limits)) {
    if (entry.isDirectory) continue;
    if (include && !include.test(entry.relative)) continue;
    batch.push(entry);
    if (batch.length >= GREP_CONCURRENCY && await drain()) return matches;
  }
  await drain();
  return matches;
}
