import path from "node:path";
import type { AgentToolResult } from "../agent-runtime";

/**
 * Making a tool result comparable to the same result produced somewhere else.
 *
 * Most of what a tool returns is already stable — a relative path, a byte count, a list of matches.
 * What is not stable is anything that mentions where the work happened. A run in
 * `/tmp/nova-a1b2c3/` and the identical run in `/home/ci/build/` differ in every line that names
 * the workspace, which is enough to make a golden comparison fail for a reason that has nothing to
 * do with the agent's behaviour.
 *
 * `run_command` is the main offender, because its output is whatever the command printed and
 * compilers, test runners and linters all print absolute paths. The root is therefore replaced
 * with a fixed token, and so is its real path: a macOS temporary directory is reached as `/var/...`
 * and reported as `/private/var/...`, and a comparison that handles only the first fails on exactly
 * the machines a contributor is most likely to be using.
 *
 * What this does *not* do is guess. Durations, process ids and random ports are equally volatile
 * and there is no general way to spot them without also mangling real output, so they are the
 * caller's business through `scrub` — a test that knows its command prints a timing can say so.
 */

export const WORKSPACE_TOKEN = "<workspace>";

export type NormalizeOptions = {
  /** Absolute workspace root, replaced wherever it appears. */
  root: string;
  /**
   * `root` as the filesystem actually reports it, when that differs — pass `fs.realpath(root)`.
   * A symlinked or `/private`-prefixed temporary directory is the common case.
   */
  realRoot?: string;
  /** Extra volatile patterns the caller knows about: timings, ports, ids. Applied in order. */
  scrub?: ReadonlyArray<readonly [RegExp, string]>;
};

/** Longest first, so replacing `/tmp/x` never eats the prefix of `/tmp/x-real` before it matches. */
function rootTokens(options: NormalizeOptions): string[] {
  const roots = new Set<string>();
  for (const value of [options.root, options.realRoot]) {
    if (!value) continue;
    // Keep producer and host spellings. A POSIX result may be compared on Windows, where resolving
    // `/tmp/x` would otherwise turn the only usable token into a drive-qualified path.
    for (const candidate of [value, path.resolve(value)]) {
      const trimmed = candidate.replace(/[\\/]+$/, "");
      roots.add(trimmed);
      roots.add(trimmed.replaceAll("\\", "/"));
      roots.add(trimmed.replaceAll("/", "\\"));
    }
  }
  return [...roots].sort((left, right) => right.length - left.length);
}

function replaceRoots(text: string, tokens: readonly string[]): string {
  let result = text;
  for (const token of tokens) {
    // `split`/`join` rather than a RegExp: a path is a literal and may contain regex metacharacters
    // (`+` and `(` are legal in directory names), and escaping them correctly is easy to get wrong.
    result = result.split(token).join(WORKSPACE_TOKEN);
  }
  return result;
}

function normalizeValue(value: unknown, tokens: readonly string[], scrub: NormalizeOptions["scrub"]): unknown {
  if (typeof value === "string") {
    let text = replaceRoots(value, tokens);
    for (const [pattern, replacement] of scrub ?? []) text = text.replace(pattern, replacement);
    return text;
  }
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item, tokens, scrub));
  if (value && typeof value === "object") {
    // Keys are sorted so two results that differ only in property order compare equal — a
    // difference no reader would call a difference.
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeValue(item, tokens, scrub)]),
    );
  }
  return value;
}

/**
 * Rewrites a result so two runs of the same work in different directories compare equal.
 *
 * Returns a new result; the original is untouched, because the value the model is shown must stay
 * exactly what the tool produced. This is for comparison, never for display.
 */
export function normalizeToolResult(result: AgentToolResult, options: NormalizeOptions): AgentToolResult {
  const tokens = rootTokens(options);
  const normalized: AgentToolResult = {
    ...result,
    content: normalizeValue(result.content, tokens, options.scrub) as string,
  };
  if (result.data) normalized.data = normalizeValue(result.data, tokens, options.scrub) as Record<string, unknown>;
  if (result.verification) {
    normalized.verification = { ...result.verification, summary: normalizeValue(result.verification.summary, tokens, options.scrub) as string };
  }
  return normalized;
}

/**
 * A stable string for one result, for golden files and equality assertions.
 *
 * Sorted keys and a fixed field order, so the serialization of two equal results is byte-identical.
 */
export function serializeToolResult(result: AgentToolResult, options: NormalizeOptions): string {
  const normalized = normalizeToolResult(result, options);
  return JSON.stringify({
    content: normalized.content,
    isError: normalized.isError ?? false,
    effect: normalized.effect,
    data: normalized.data,
    verification: normalized.verification,
  });
}
