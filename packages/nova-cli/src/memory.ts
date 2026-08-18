import { BOLD, CYAN, DIM, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS } from "./glyphs";
import { GUTTER, heading, note, type SectionStyle } from "./sections";
import {
  MEMORY_LIMITS,
  memoryChars,
  memoryFile,
  type MemoryEntry,
  type MemoryKind,
  type MemoryScope,
} from "@circuit-nova/nova-core/nova-cli/memory";

/**
 * The terminal half of memory: parsing `/memory` commands and drawing the result.
 *
 * The storage, recall and prompt-block half moved to agent-core, because the desktop app and any
 * background job need exactly the same facts and had no way to reach them here. What stays is what
 * is genuinely terminal — command syntax and ANSI rendering — and everything else is re-exported so
 * existing callers keep importing memory from one place.
 */

export * from "@circuit-nova/nova-core/nova-cli/memory";

export type MemoryCommand =
  | { kind: "list" }
  | { kind: "add"; scope: MemoryScope; text: string; memoryKind: MemoryKind; pinned: boolean }
  | { kind: "replace"; scope: MemoryScope; oldText: string; newText: string }
  | { kind: "recall"; query: string }
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
  if (shorthand && !input.trim().startsWith("##")) return { kind: "add", scope: "project", text: shorthand[1].trim(), memoryKind: "fact", pinned: false };

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

  let pinned = false;
  rest = rest.replace(/(^|\s)--(core|pinned)(\s|$)/, (_whole, before: string, _name: string, after: string) => {
    pinned = true;
    return before && after ? " " : "";
  }).trim();
  let memoryKind: MemoryKind = "fact";
  rest = rest.replace(/(^|\s)--kind[=\s]+(preference|convention|decision|lesson|fact)(\s|$)/, (_whole, before: string, kind: MemoryKind, after: string) => {
    memoryKind = kind;
    return before && after ? " " : "";
  }).trim();

  const [verb, ...others] = rest.split(/\s+/);
  const argument = others.join(" ").trim();

  switch (verb) {
    case "":
    case "list":
    case "ls":
      return { kind: "list" };
    case "add":
    case "remember":
      return argument ? { kind: "add", scope, text: argument, memoryKind, pinned } : { kind: "invalid", reason: "/memory add needs the fact to remember, for example /memory add --kind convention we use bun, not npm." };
    case "replace": {
      const parts = argument.split(/\s+(?:=>|with)\s+/);
      return parts.length === 2 && parts[0].trim() && parts[1].trim()
        ? { kind: "replace", scope, oldText: parts[0].trim(), newText: parts[1].trim() }
        : { kind: "invalid", reason: "/memory replace takes a unique fragment and replacement, for example /memory replace dark mode => light mode." };
    }
    case "recall":
    case "search":
      return argument ? { kind: "recall", query: argument } : { kind: "invalid", reason: "/memory recall needs a topic to retrieve." };
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
      return { kind: "add", scope, text: rest, memoryKind, pinned };
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
      const tag = `${entry.kind}${entry.pinned ? "/core" : ""}`;
      out.push(`${GUTTER}${paint(`${entry.index}.`.padStart(3), DIM, style.depth)} ${entry.text} ${paint(`[${tag}]`, DIM, style.depth)}`);
    }
  }
  const usage = (["project", "user"] as const).map((scope) => `${scope} ${memoryChars(entries.filter((entry) => entry.scope === scope))}/${MEMORY_LIMITS[scope]}`).join(` ${glyphs.middot} `);
  out.push(`${GUTTER}${paint(`${glyphs.middot} ${usage} ${glyphs.middot} /memory recall <topic> ${glyphs.middot} project entries win conflicts`, DIM, style.depth)}`);
  return out.join("\n");
}

/** The confirmation line printed when a fact is recorded. */
export function describeAdded(entry: { scope: MemoryScope; text: string }, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  return `${GUTTER}${paint(glyphs.check, CYAN, style.depth)} ${paintAll("remembered", [BOLD], style.depth)} ${paint(`(${entry.scope})`, DIM, style.depth)} ${entry.text}`;
}
