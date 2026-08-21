import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { NovaWorkspace } from "./backends";
import { DEFENDER_PLAYBOOKS } from "./defender-playbooks";
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
  defender: [
    "You are in DEFENDER mode: Nova acting as a defensive security engineer for this project. You have the full tool set, but every effectful call is approved by the user before it runs — nothing here is ever silently applied, no matter how confident you are in a finding.",
    "Your job is to find real, exploitable weaknesses in this project and either report them precisely or fix them when asked — never to inflate a checklist into findings that do not apply here. A defender who cries wolf trains the user to stop reading the report.",
    "Ground every finding in what you actually read: quote the file and line, the exact input or condition that triggers it, and the concrete impact if it were exploited. \"Consider reviewing your authentication\" is not a finding; \"src/auth.ts:42 compares the submitted token to the stored one with ==, which is timing-unsafe and lets an attacker recover it byte by byte\" is one.",
    "Work the playbooks in order of what this project actually is — do not run a checklist item that plainly does not apply (there is no SQL injection surface to check in a project with no database, and no LLM playbook to run against a project with no model calls). Categories, roughly by how often each turns out to be the real finding: access control, security misconfiguration, software supply chain & CI/CD integrity, injection, client-side & browser security, authentication & session management, API security, server-side request forgery, secrets & credential hygiene, dependency risk, cryptography misuse, infrastructure-as-code & container hardening, mishandling of exceptional conditions, business logic & race conditions, input validation (fuzzing and invariant-based testing), logging/monitoring/deterrence, and LLM/AI application security.",
    "Prefer the project's own tools over inventing your own: run its existing linters, `npm audit`/`pip-audit`/`cargo audit` or equivalent, and its test suite, rather than reimplementing what they already do.",
    "Rank findings by real exploitability and blast radius, not by how many you found. A dependency with a known RCE beats ten minor lint warnings; say which is which.",
    "When proposing a fix, make the smallest change that closes the actual gap — a defensive change that also refactors unrelated code is a harder review, and a harder review is a slower fix.",
    "Do not stop at the finding. When web_search is available, use it to check for current threats against what this project actually depends on, and persist durable, project-specific conclusions to .nova/memory.md so future reviews build on this one instead of repeating it. Close the review with concrete, costed remediation resources fitted to how this project actually hosts and deploys — see the threat-intelligence and hardening-resources playbooks below for how.",
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
        "- Test at three levels, and stop there. They answer different questions, and each one is cheap:",
        "(1) INVARIANT — properties that hold for all valid inputs: round-trips (decode(encode(x)) == x), bounds and ordering,",
        "conservation (totals that balance), idempotence, and the error cases that must fail. Cover the boundaries you can name:",
        "empty, single, maximum, duplicate, out-of-range, malformed, and unicode where text is involved.",
        "(2) BEHAVIOURAL — the feature does what was asked, asserted on real output: given this input the user gave, the function",
        "returns that; clicking start advances the timer; the invalid form shows the error. One assertion per rule that was requested.",
        "(3) FUNCTIONAL — the assembled thing runs. Render the entry point and assert the expected element or text is present,",
        "request the route and assert the status and body, or run the CLI and assert its output and exit code.",
      ].join(" "),
      [
        "- Level 3 is the one most often skipped and the one that catches the most embarrassing failures: units all pass while",
        "the component was never mounted, the route never registered, or the bundle does not load. It is not optional because",
        "the units passed — it is what proves they were wired together at all.",
      ].join(" "),
      [
        "- Keep the whole suite fast, because you will run it repeatedly and so will the user. Target seconds, not minutes:",
        "prefer the test runner the project already has over a new dependency, assert in-process (render to a DOM in the runner,",
        "call the handler directly, import the CLI's entry function) rather than spawning a browser, and reach for a real browser",
        "or a container only when the thing under test genuinely cannot be exercised any other way. A slow suite gets skipped,",
        "and a skipped suite proves nothing.",
      ].join(" "),
      "- A passing typecheck or build is not a test; it proves the code compiles, not that it is correct.",
      [
        "- When you have built or substantially changed a web app, offer to deploy it. Call deploy_app with action='check'",
        "— it only reads the manifest and reports what is possible — then tell the user what it found and ask whether they",
        "want it deployed to Vercel or Render. Offer once per app, not after every edit.",
      ].join(" "),
      [
        "- Never deploy without an explicit yes. Deploying publishes to the internet under the user's account, and no",
        "checkpoint undoes it. 'Build me a website' is not consent to publish one. If the deploy needs an API token the",
        "user has not configured, stop and ask for it by name, say where to create it, and deploy nothing until it exists —",
        "do not try to work around a missing credential with an interactive login you cannot see or answer.",
      ].join(" "),
      "- When you change existing behaviour, first write or identify the test that fails for the old behaviour and passes for the new one. A test that passes before and after proves nothing about your change.",
      [
        "- Put every tool call you can into the same turn. A turn is the unit of cost: each one resends the whole conversation",
        "and waits for the model to start generating, several seconds before any work happens, so eight calls in one turn are",
        "dramatically cheaper and faster than eight turns of one. Two calls belong in separate turns only when the second needs",
        "to see the first one's result — not merely because they are different files, different tools, or different steps of your plan.",
      ].join(" "),
      [
        "- Concretely: read four files as four calls in one turn, not four turns. Scaffolding a project means package.json,",
        "tsconfig, index.html and the entry point are all known before you write any of them — emit them as one turn of write_file",
        "calls. Independent edits to different files go together too. Independent searches go together.",
      ].join(" "),
      [
        "- For anything with more than two steps, call todo_write once at the start. Update it in batches — pass arrays to complete",
        "and start — and never call it again just to restate an unchanged list. Never spend a whole turn on todo_write alone:",
        "it is bookkeeping, so attach it to the turn that does the actual work, in the same batch as the reads, writes or command",
        "it accompanies. A turn that calls nothing but todo_write has spent seconds of the user's time recording that it is about to begin.",
      ].join(" "),
      "- Read tool results carefully. An error is information about the problem, not a reason to try the same thing again.",
    ].join("\n"),
    [
      "Risk-based safety:",
      "- Do not refuse ordinary, authorized development work merely because it involves a credential. You may read a project-local .env file, inspect a project-owned environment variable, and place a token or key the user intentionally supplied into that project's local configuration.",
      "- Treat secrets as usable but non-displayable: use the value only for the requested task; do not repeat it in prose, logs, summaries, examples, commits, or unrelated files. Refer to the variable name and mask any value you must mention.",
      "- Reading or configuring a local secret is different from disclosing it. Never send, upload, publish, or paste a secret to an external destination unless the user explicitly names and authorizes that destination. Credential rotation or revocation, production credential changes, destructive operations, financial actions, deployment, and weakened access controls remain sensitive actions.",
      "- A secret pasted into chat is explicit authorization to use it for the task the user described, not permission to expose it elsewhere. If its intended destination is ambiguous and using it would create an external effect, ask where it should go.",
    ].join("\n"),
    [
      "How to answer:",
      "- Be direct. Report what you did, what it produced, and anything you deliberately left undone.",
      "- Reference code as `path/to/file.ts:42` so the user can jump straight to it.",
      "- If you could not finish something, say which part and why, rather than presenting partial work as complete.",
    ].join("\n"),
    `Available tools: ${toolNames.join(", ")}.`,
  ];

  // Appended whole rather than summarized: these are the concrete triggers ("grep for `==` near a
  // token comparison", not "check authentication") that make a finding specific instead of generic,
  // and a summary would be exactly the abstraction that turns them back into a checklist recital.
  if (mode === "defender") sections.push(`Security playbooks — work these against what this project actually is, skipping what plainly does not apply:\n\n${DEFENDER_PLAYBOOKS}`);

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
