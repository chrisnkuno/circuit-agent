import type { NovaWorkspace } from "./backends";
import { INSTRUCTION_FILES } from "./prompt";

/**
 * Instructions for a directory the agent has only just reached.
 *
 * `collectProjectContext` (prompt.ts) loads one broad-to-specific chain once, at the start of a
 * turn, walking from the repository boundary down to the working root. That is everything the
 * agent knows before it reads a single file — and it is also the entire chain: a project that
 * keeps different rules in `src/api/AGENTS.md` than at its root has no way to tell the agent so
 * before the agent happens to open a file there, because the static chain never looks *below* the
 * root it started from.
 *
 * This is the dynamic half. As a tool touches a path, the directories between the root and that
 * path are checked for an instruction file the agent has not been shown yet — the same filenames,
 * the same one-per-directory precedence, `collectProjectContext` already uses, just discovered as
 * the agent goes deeper instead of gathered once up front.
 *
 * Same filename list `prompt.ts` uses, imported from there rather than duplicated — two copies of
 * "which filenames count as instructions" is exactly the kind of drift that leaves one updated and
 * the other stale.
 */

export type NestedInstruction = {
  /** Root-relative, forward-slashed — e.g. "src/api/AGENTS.md". */
  path: string;
  content: string;
};

/**
 * Tracks which directories below the workspace root have already had their instructions surfaced,
 * for one session. A directory is checked and shown at most once — the first tool call to reach it
 * pays for discovery; every call after that, whether by the same tool or another, does not repeat
 * text the agent has already seen.
 *
 * Deliberately never looks at or above the workspace root: everything from the root up through the
 * repository boundary is the static chain's territory, already in the system prompt. Re-surfacing
 * any of it here would just be the same file shown twice.
 */
export class NestedInstructionTracker {
  private readonly seenDirectories = new Set<string>();

  /**
   * Reads through the workspace rather than `node:fs`, so a repository's own `src/api/AGENTS.md` is
   * found on an E2B or Docker session exactly as it is locally — the files the agent is actually
   * working on are the ones whose rules should reach it, wherever they live.
   */
  constructor(private readonly workspace: NovaWorkspace) {}

  /** Root-relative directories already surfaced, for inspection — a session log or a test, not the runtime. */
  get discovered(): string[] {
    return [...this.seenDirectories].sort();
  }

  /**
   * Checks the directories between the root and `relativePath`'s own directory, newest-reached
   * last (broad to specific, matching the static chain's own ordering), and returns whichever of
   * them have an instruction file not already shown this session.
   *
   * A path whose last segment has no extension is treated as naming a directory itself, rather than
   * a file inside one. This replaces the `fs.stat` the local-only version used: statting through a
   * remote workspace costs a round trip on every single call, and the tools actually wired to this
   * (`PATH_TOOLS` in tools.ts) only ever pass file paths, so the probe would almost always be
   * answering a question that did not arise. The cost of the heuristic being wrong is one directory
   * checked that did not need to be — never a missed instruction file, and never an error.
   */
  async discover(relativePath: string): Promise<NestedInstruction[]> {
    const normalized = relativePath.split("\\").join("/").replace(/^\.\//, "");
    // A path escaping the root is the workspace's business to refuse, not this one's to interpret.
    if (normalized.startsWith("../") || normalized.startsWith("/")) return [];
    const segments = normalized.split("/").filter((segment) => segment && segment !== ".");
    if (segments.at(-1)?.includes(".")) segments.pop(); // a file inside the directory that matters

    const chain: string[] = [];
    for (let depth = 1; depth <= segments.length; depth += 1) chain.push(segments.slice(0, depth).join("/"));

    const found: NestedInstruction[] = [];
    for (const directory of chain) {
      if (this.seenDirectories.has(directory)) continue;
      this.seenDirectories.add(directory);
      for (const candidate of INSTRUCTION_FILES) {
        const file = await this.workspace.readFile(`${directory}/${candidate}`).catch(() => null);
        if (!file) continue;
        found.push({ path: `${directory}/${candidate}`, content: file.content });
        break; // one instruction file per directory, same precedence prompt.ts uses
      }
    }
    return found;
  }

  /** Renders discovered instructions the way a tool result appends them — empty string for none. */
  static render(instructions: readonly NestedInstruction[]): string {
    if (instructions.length === 0) return "";
    const blocks = instructions.map((item) => `[${item.path}]\n${item.content.trim()}`).join("\n\n");
    return `\n\n--- Project instructions for this directory, not shown before now ---\n${blocks}`;
  }
}
