import { promises as fs } from "node:fs";
import path from "node:path";
import type { NovaWorkspace } from "./backends";
import type { NovaMode } from "./permissions";

/**
 * What Nova knows before it reads a single file.
 *
 * The IDE agents have an advantage a CLI cannot copy — Cline can ask the editor for the project's
 * symbol index and open tabs. A terminal agent has to earn the same context by looking, so the
 * prompt front-loads the cheap signals (project layout, package scripts, git branch, an
 * instructions file) and then tells the model to go find the rest rather than guess.
 */

export type ProjectContext = {
  root: string;
  /** Contents of NOVA.md / AGENTS.md / CLAUDE.md, whichever the project actually has. */
  instructions: string | null;
  instructionsFile: string | null;
  /** Top-level entries, so the model does not spend its first turn listing the root. */
  layout: string[];
  packageScripts: string[];
  gitBranch: string | null;
};

const INSTRUCTION_FILES = ["NOVA.md", "AGENTS.md", "CLAUDE.md", ".novarules"];

export async function collectProjectContext(root: string, maxInstructionChars = 8_000): Promise<ProjectContext> {
  const context: ProjectContext = { root, instructions: null, instructionsFile: null, layout: [], packageScripts: [], gitBranch: null };

  for (const candidate of INSTRUCTION_FILES) {
    try {
      const text = await fs.readFile(path.join(root, candidate), "utf8");
      context.instructions = text.slice(0, maxInstructionChars);
      context.instructionsFile = candidate;
      break;
    } catch {
      // Absent is the normal case, not an error.
    }
  }

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    context.layout = entries
      .filter((entry) => !entry.name.startsWith(".") || entry.name === ".github")
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .slice(0, 60);
  } catch {
    // An unreadable root is reported by the first tool call, not by a missing prompt section.
  }

  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    context.packageScripts = Object.keys(manifest.scripts ?? {}).slice(0, 30);
  } catch {
    // Not a Node project, or no manifest.
  }

  try {
    const head = await fs.readFile(path.join(root, ".git", "HEAD"), "utf8");
    const match = head.match(/ref:\s*refs\/heads\/(.+)/);
    context.gitBranch = match?.[1]?.trim() ?? null;
  } catch {
    // Not a git checkout.
  }

  return context;
}

const MODE_GUIDANCE: Record<NovaMode, string> = {
  plan: [
    "You are in PLAN mode. You can read, search and reason, but you cannot write files or run commands — those tools are not available to you.",
    "Produce a concrete plan: the files that must change, what changes in each, and how the result will be verified. Name real paths you have actually read.",
    "Do not claim to have made changes. When the plan is ready, say so plainly and stop; the user switches to build mode to execute it.",
  ].join(" "),
  build: [
    "You are in BUILD mode. You can change the workspace and run commands, and each such call is approved by the user before it runs.",
    "If the user denies a call, respect that decision and find another route rather than asking again for the same thing.",
  ].join(" "),
  auto: [
    "You are in AUTO mode. Workspace edits run without individual approval; commands with effects outside the workspace still require it.",
    "Work carefully — nobody is reviewing each edit before it lands.",
  ].join(" "),
};

/**
 * The core instructions.
 *
 * Written as behaviour rules rather than a persona, because every measurable failure of a coding
 * agent is behavioural: editing before reading, claiming success without verifying, rewriting a
 * file to change a line, or narrating a plan it never carried out.
 */
export function buildNovaSystemPrompt(context: ProjectContext, mode: NovaMode, toolNames: string[], workspace?: NovaWorkspace): string {
  const remote = workspace?.kind === "e2b";
  const sections: string[] = [
    remote
      // Saying so plainly matters: an agent that believes it is on the user's machine will offer
      // to open files in their editor and reason about their local git history, neither of which
      // exists here.
      ? "You are Nova, a coding agent working in an isolated remote sandbox. Files you create exist only in that sandbox, not on the user's machine, and the sandbox is destroyed when the session ends."
      : "You are Nova, a coding agent working in a real project on the user's machine. Your changes are real and immediately visible to them.",
    MODE_GUIDANCE[mode],
    [
      "How to work:",
      "- Understand before you change. Read the files you are about to edit, and search for how a symbol is used before you alter it.",
      "- Prefer edit_file over write_file for existing files. Never reproduce a whole file to change part of it.",
      "- Match the surrounding code: its naming, its structure, its idioms, its comment density. Code that reads as foreign is code that gets reverted.",
      "- Verify your work by running the project's own tests or checks, and report the real result. Never describe an outcome you did not observe.",
      "- For anything with more than two steps, call todo_write once at the start. Update it in batches — pass arrays to complete and start — and never call it again just to restate an unchanged list; every call is a full round trip that costs the user time and money.",
      "- Batch independent reads and searches into one turn. Reading four files as four parallel calls is one round trip; four separate turns is four.",
      "- Read tool results carefully. An error is information about the problem, not a reason to try the same thing again.",
    ].join("\n"),
    [
      "How to answer:",
      "- Be direct. Report what you did, what it produced, and anything you deliberately left undone.",
      "- Reference code as `path/to/file.ts:42` so the user can jump straight to it.",
      "- If you could not finish something, say which part and why, rather than presenting partial work as complete.",
    ].join("\n"),
    `Available tools: ${toolNames.join(", ")}.`,
  ];

  const project: string[] = [workspace ? `Workspace (${workspace.kind}): ${workspace.label}` : `Project root: ${context.root}`];
  if (context.gitBranch) project.push(`Git branch: ${context.gitBranch}`);
  if (context.layout.length > 0) project.push(`Top level: ${context.layout.join(" ")}`);
  if (context.packageScripts.length > 0) project.push(`package.json scripts: ${context.packageScripts.join(", ")}`);
  sections.push(project.join("\n"));

  if (context.instructions?.trim()) {
    sections.push(
      `Project instructions from ${context.instructionsFile}. These come from the project's maintainers and take precedence over your general habits:\n\n${context.instructions.trim()}`,
    );
  }

  return sections.join("\n\n");
}
