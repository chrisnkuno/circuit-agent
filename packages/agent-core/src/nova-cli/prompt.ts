import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
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
  /** Broad-to-specific instruction chain selected from repository and working-directory files. */
  instructions: string | null;
  instructionsFile: string | null;
  instructionSources?: Array<{ path: string; sha256: string; truncated: boolean }>;
  /** Top-level entries, so the model does not spend its first turn listing the root. */
  layout: string[];
  packageScripts: string[];
  gitBranch: string | null;
};

export const INSTRUCTION_FILES = ["AGENTS.override.md", "NOVA.md", "AGENTS.md", "CLAUDE.md", ".novarules"];

async function instructionBoundary(root: string): Promise<string> {
  const requestedRoot = path.resolve(root);
  const temporaryRoot = path.resolve(os.tmpdir());
  let current = path.resolve(root);
  while (true) {
    // A shared /tmp may itself be a checkout in CI; temporary test/workspace children must not
    // inherit unrelated instructions from that ambient repository.
    if (current !== temporaryRoot && await fs.stat(path.join(current, ".git")).then(() => true).catch(() => false)) return current;
    const parent = path.dirname(current);
    if (current === temporaryRoot || parent === current) return requestedRoot;
    current = parent;
  }
}

export async function collectProjectContext(root: string, maxInstructionChars = 8_000): Promise<ProjectContext> {
  const context: ProjectContext = { root, instructions: null, instructionsFile: null, instructionSources: [], layout: [], packageScripts: [], gitBranch: null };

  const boundary = await instructionBoundary(root);
  const directories: string[] = [];
  for (let current = path.resolve(root); ; current = path.dirname(current)) {
    directories.unshift(current);
    if (current === boundary) break;
  }
  const discovered: Array<{ file: string; relative: string; text: string }> = [];
  for (const directory of directories) {
    for (const candidate of INSTRUCTION_FILES) {
      try {
        const file = path.join(directory, candidate);
        const text = await fs.readFile(file, "utf8");
        discovered.push({ file, relative: path.relative(boundary, file).split(path.sep).join("/") || candidate, text });
        break;
      } catch {
        // One instruction file per directory; a missing candidate just advances precedence.
      }
    }
  }
  let remaining = Math.max(0, maxInstructionChars);
  const selected: Array<{ path: string; content: string; sha256: string; truncated: boolean }> = [];
  // Deeper instructions are more specific, so they receive the budget first.
  for (const item of [...discovered].reverse()) {
    if (remaining <= 0) break;
    const content = item.text.slice(0, remaining);
    selected.unshift({
      path: item.relative,
      content,
      sha256: createHash("sha256").update(item.text).digest("hex"),
      truncated: content.length < item.text.length,
    });
    remaining -= content.length;
  }
  if (selected.length > 0) {
    context.instructions = selected.length === 1
      ? selected[0].content
      : selected.map((source) => `[${source.path}]\n${source.content}`).join("\n\n");
    context.instructionsFile = selected.map((source) => source.path).join(" -> ");
    context.instructionSources = selected.map(({ path: sourcePath, sha256, truncated }) => ({ path: sourcePath, sha256, truncated }));
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
    const head = await fs.readFile(path.join(boundary, ".git", "HEAD"), "utf8");
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
      [
        "- Test by invariant, not by example. Every change that has behaviour gets tests, however small the program:",
        "assert the properties that must hold for all valid inputs — round-trips (decode(encode(x)) == x), bounds and ordering,",
        "conservation (totals that must balance), idempotence, and the error cases that must fail — rather than one happy-path value.",
        "Cover the boundaries you can name: empty, single, maximum, duplicate, out-of-range, malformed, and unicode where text is involved.",
        "A passing typecheck or build is not a test; it proves the code compiles, not that it is correct.",
      ].join(" "),
      "- When you change existing behaviour, first write or identify the test that fails for the old behaviour and passes for the new one. A test that passes before and after proves nothing about your change.",
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
    const provenance = context.instructionSources?.map((source) => `${source.path}@${source.sha256.slice(0, 12)}${source.truncated ? " (truncated)" : ""}`).join(", ");
    sections.push(
      `Project instructions from ${context.instructionsFile}. These come from the project's maintainers, apply from broad to specific, and take precedence over your general habits.${provenance ? ` Provenance: ${provenance}.` : ""}\n\n${context.instructions.trim()}`,
    );
  }

  return sections.join("\n\n");
}
