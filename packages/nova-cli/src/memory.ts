import { promises as fs } from "node:fs";
import path from "node:path";
import { BOLD, CYAN, DIM, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS } from "./glyphs";
import { GUTTER, heading, note, type SectionStyle } from "./sections";
import { settingsDirectory } from "./settings";

/**
 * Things worth remembering between sessions.
 *
 * A coding agent that has to be told "we use bun, not npm" at the start of every session is being
 * paid to re-learn the same fact forever, and the user is paying for those tokens each time. The
 * fix every capable agent converges on is the same: a small, *visible*, editable file of durable
 * facts that is prepended to the conversation.
 *
 * Two things make this one honest rather than magic:
 *
 * - It is a plain markdown list at a path the user can open, diff and delete. Nothing is inferred
 *   and written behind their back — a memory exists because someone typed `#` or `/memory add`.
 * - It is scoped. Project memory (`.nova/memory.md`) belongs to the repository and can be committed
 *   for a team; user memory (beside the settings file) follows the person across every project.
 *   Conflating the two is how "I prefer tabs" ends up in someone else's repository.
 *
 * Storage is deliberately the same format the file already has if a human wrote it: `- fact` lines
 * under an optional heading. A memory file edited by hand in an editor stays readable by this
 * parser, which is what makes the file the source of record rather than a cache of one.
 */

export type MemoryScope = "project" | "user";

export type MemoryEntry = {
  scope: MemoryScope;
  /** 1-based position within its scope, which is what `/memory forget N` names. */
  index: number;
  text: string;
};

export const MEMORY_HEADER = "# Nova memory";

const PREAMBLE = [
  MEMORY_HEADER,
  "",
  "Durable facts Nova is told to remember. One per line. Edit or delete freely — this file is the",
  "record, not a cache of one.",
  "",
].join("\n");

export function memoryFile(scope: MemoryScope, root: string, environment: Record<string, string | undefined>): string {
  return scope === "project"
    ? path.join(root, ".nova", "memory.md")
    : path.join(settingsDirectory(environment), "memory.md");
}

/** Bullet lines, in file order. Anything else in the file is prose the user wrote and is left alone. */
export function parseMemoryFile(contents: string, scope: MemoryScope): MemoryEntry[] {
  const entries: MemoryEntry[] = [];
  for (const line of contents.split("\n")) {
    const match = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!match) continue;
    entries.push({ scope, index: entries.length + 1, text: match[1] });
  }
  return entries;
}

export function formatMemoryFile(entries: readonly MemoryEntry[]): string {
  return `${PREAMBLE}${entries.map((entry) => `- ${entry.text}`).join("\n")}\n`;
}

async function readScope(scope: MemoryScope, root: string, environment: Record<string, string | undefined>): Promise<MemoryEntry[]> {
  try {
    return parseMemoryFile(await fs.readFile(memoryFile(scope, root, environment), "utf8"), scope);
  } catch {
    return [];
  }
}

/**
 * Every memory that applies here, user scope first.
 *
 * Ordered so the project's own rules are read last and therefore win an argument, matching the
 * broad-to-specific precedence the core already applies to nested `AGENTS.md` files — one
 * precedence rule for the whole product rather than a second one invented here.
 */
export async function loadMemories(root: string, environment: Record<string, string | undefined>): Promise<MemoryEntry[]> {
  const [user, project] = await Promise.all([readScope("user", root, environment), readScope("project", root, environment)]);
  return [...user, ...project];
}

async function writeScope(scope: MemoryScope, entries: readonly MemoryEntry[], root: string, environment: Record<string, string | undefined>): Promise<string> {
  const file = memoryFile(scope, root, environment);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  // Written through a temporary file and renamed: a memory file half-written because the process
  // was interrupted is a file the next session silently reads as truncated truth.
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, formatMemoryFile(entries), { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, file);
  return file;
}

export type MemoryChange = { entries: MemoryEntry[]; file: string; changed: boolean };

/** Adds one fact, ignoring an exact duplicate rather than growing the file with it. */
export async function addMemory(scope: MemoryScope, text: string, root: string, environment: Record<string, string | undefined>): Promise<MemoryChange> {
  const trimmed = text.trim();
  const existing = await readScope(scope, root, environment);
  if (trimmed === "") return { entries: existing, file: memoryFile(scope, root, environment), changed: false };
  if (existing.some((entry) => entry.text.toLowerCase() === trimmed.toLowerCase())) {
    return { entries: existing, file: memoryFile(scope, root, environment), changed: false };
  }
  const next = [...existing, { scope, index: existing.length + 1, text: trimmed }];
  return { entries: next, file: await writeScope(scope, next, root, environment), changed: true };
}

export async function forgetMemory(scope: MemoryScope, index: number, root: string, environment: Record<string, string | undefined>): Promise<MemoryChange & { removed?: MemoryEntry }> {
  const existing = await readScope(scope, root, environment);
  const removed = existing.find((entry) => entry.index === index);
  if (!removed) return { entries: existing, file: memoryFile(scope, root, environment), changed: false };
  const next = existing
    .filter((entry) => entry.index !== index)
    .map((entry, position) => ({ ...entry, index: position + 1 }));
  return { entries: next, file: await writeScope(scope, next, root, environment), changed: true, removed };
}

export async function clearMemories(scope: MemoryScope, root: string, environment: Record<string, string | undefined>): Promise<MemoryChange> {
  const existing = await readScope(scope, root, environment);
  if (existing.length === 0) return { entries: [], file: memoryFile(scope, root, environment), changed: false };
  return { entries: [], file: await writeScope(scope, [], root, environment), changed: true };
}

/**
 * The block prepended to a turn.
 *
 * Sent once per thread rather than per turn: the conversation carries it forward, so re-sending it
 * every turn would bill the user for the same paragraph on every message. `nova.ts` re-sends it
 * only when the set actually changes, which is the other moment the model needs to see it.
 */
export function memoryPromptBlock(entries: readonly MemoryEntry[]): string {
  if (entries.length === 0) return "";
  return [
    "Remembered facts about this user and project (they asked you to keep these in mind; project entries win where they conflict):",
    ...entries.map((entry) => `- ${entry.text}`),
    "",
  ].join("\n");
}

export type MemoryCommand =
  | { kind: "list" }
  | { kind: "add"; scope: MemoryScope; text: string }
  | { kind: "forget"; scope: MemoryScope; index: number }
  | { kind: "clear"; scope: MemoryScope }
  | { kind: "where" }
  | { kind: "invalid"; reason: string };

/**
 * `/memory`, and the `#` shorthand.
 *
 * `# use bun, not npm` is the fastest possible way to record a fact — one character, no command to
 * recall — and it is unambiguous at the start of a line because a bare `#` there is a markdown
 * heading nobody types at a chat prompt. It defaults to project scope: the overwhelming majority of
 * remembered facts are about the repository in front of you.
 */
export function parseMemoryCommand(input: string): MemoryCommand | null {
  const shorthand = /^#\s*(.+)$/.exec(input.trim());
  if (shorthand && !input.trim().startsWith("##")) return { kind: "add", scope: "project", text: shorthand[1].trim() };

  const match = /^\/memory(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  let rest = (match[1] ?? "").trim();
  if (rest === "") return { kind: "list" };

  // Scope is a flag rather than a subcommand so it can sit anywhere: `/memory add --user x` and
  // `/memory --user add x` are the same instruction and both are things people type.
  let scope: MemoryScope = "project";
  const scoped = rest.replace(/(^|\s)--(user|global|project|local)(\s|$)/, (_whole, before: string, name: string, after: string) => {
    scope = name === "user" || name === "global" ? "user" : "project";
    return before && after ? " " : "";
  });
  rest = scoped.trim();

  const [verb, ...others] = rest.split(/\s+/);
  const argument = others.join(" ").trim();

  switch (verb) {
    case "":
    case "list":
    case "ls":
      return { kind: "list" };
    case "add":
    case "remember":
      return argument ? { kind: "add", scope, text: argument } : { kind: "invalid", reason: "/memory add needs the fact to remember, for example /memory add we use bun, not npm." };
    case "forget":
    case "remove":
    case "rm": {
      if (!/^\d+$/.test(argument)) return { kind: "invalid", reason: "/memory forget takes the number shown beside the entry, for example /memory forget 2." };
      return { kind: "forget", scope, index: Number(argument) };
    }
    case "clear":
      return { kind: "clear", scope };
    case "where":
    case "path":
    case "file":
      return { kind: "where" };
    default:
      // Anything else is treated as the fact itself: `/memory we deploy on Fridays` is what people
      // type before they learn the subcommand, and refusing it teaches nothing useful.
      return { kind: "add", scope, text: rest };
  }
}

/** The `/memory` view: both scopes, separated, each numbered by the index `/memory forget` takes. */
export function renderMemories(entries: readonly MemoryEntry[], style: SectionStyle, files: Record<MemoryScope, string>): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const out: string[] = [];
  for (const scope of ["project", "user"] as const) {
    const scoped = entries.filter((entry) => entry.scope === scope);
    out.push(heading(scope === "project" ? "project memory" : "your memory", 2, style, scope === "project" ? "accent" : "neutral"));
    out.push(note(files[scope], style));
    if (scoped.length === 0) {
      out.push(note(scope === "project" ? "nothing yet — # a fact, or /memory add <fact>" : "nothing yet — /memory add --user <fact>", style));
      continue;
    }
    for (const entry of scoped) {
      out.push(`${GUTTER}${paint(`${entry.index}.`.padStart(3), DIM, style.depth)} ${entry.text}`);
    }
  }
  out.push(`${GUTTER}${paint(`${glyphs.middot} /memory forget N ${glyphs.middot} /memory clear ${glyphs.middot} project entries win where they conflict`, DIM, style.depth)}`);
  return out.join("\n");
}

/** The confirmation line printed when a fact is recorded. */
export function describeAdded(entry: { scope: MemoryScope; text: string }, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  return `${GUTTER}${paint(glyphs.check, CYAN, style.depth)} ${paintAll("remembered", [BOLD], style.depth)} ${paint(`(${entry.scope})`, DIM, style.depth)} ${entry.text}`;
}
