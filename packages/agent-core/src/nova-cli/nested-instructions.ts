import { promises as fs } from "node:fs";
import path from "node:path";
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

  constructor(private readonly root: string) {}

  /** Root-relative paths already surfaced, for inspection — a session log or a test, not the runtime. */
  get discovered(): string[] {
    return [...this.seenDirectories].map((dir) => this.toRelative(dir)).sort();
  }

  private toRelative(absoluteDir: string): string {
    const relative = path.relative(path.resolve(this.root), absoluteDir);
    return relative === "" ? "." : relative.split(path.sep).join("/");
  }

  /**
   * Checks the directories between the root and `relativePath`'s own directory, newest-reached
   * last (broad to specific, matching the static chain's own ordering), and returns whichever of
   * them have an instruction file not already shown this session.
   */
  async discover(relativePath: string): Promise<NestedInstruction[]> {
    const rootAbsolute = path.resolve(this.root);
    const targetAbsolute = path.resolve(rootAbsolute, relativePath);
    // list/glob/grep may name a directory directly; read/write/edit always name a file. Either
    // way, what matters is the directory whose rules would govern working in it.
    const directory = await fs.stat(targetAbsolute).then((stat) => (stat.isDirectory() ? targetAbsolute : path.dirname(targetAbsolute))).catch(() => path.dirname(targetAbsolute));
    if (directory !== rootAbsolute && !directory.startsWith(`${rootAbsolute}${path.sep}`)) return [];

    const chain: string[] = [];
    for (let current = directory; current !== rootAbsolute; current = path.dirname(current)) {
      chain.unshift(current);
      if (path.dirname(current) === current) break; // filesystem root reached without finding workspace root — malformed input, stop rather than loop
    }

    const found: NestedInstruction[] = [];
    for (const dir of chain) {
      if (this.seenDirectories.has(dir)) continue;
      this.seenDirectories.add(dir);
      for (const candidate of INSTRUCTION_FILES) {
        const content = await fs.readFile(path.join(dir, candidate), "utf8").catch(() => null);
        if (content === null) continue;
        found.push({ path: `${this.toRelative(dir)}/${candidate}`, content });
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
