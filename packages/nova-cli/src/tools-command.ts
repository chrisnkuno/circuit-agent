import type { AgentTool } from "@circuit-nova/nova-core";

/**
 * `/tools` — what the agent can actually call right now, and where each of it came from.
 *
 * The reason this exists: a project gains a tool source by a directory appearing. A skill in
 * `.nova/skills`, a plugin someone committed, an MCP server declared in `.nova/mcp.json` — all of
 * them silently widen what the agent can do, and before this there was no way to ask "what is
 * loaded?" short of reading the filesystem by hand. Hooks matter most of all here: a `pre-tool-use`
 * script can block calls, and an unexplained refusal is indistinguishable from a Nova bug unless
 * something can show the script exists.
 *
 * Rendering is a pure function of already-gathered data so it can be tested without a TTY, a
 * workspace, or a running agent — the same split `jobs-command.ts` uses.
 */

export type ToolsView = {
  tools: readonly Pick<AgentTool, "name" | "provenance">[];
  hooks: { preToolUse: readonly string[]; postToolUse: readonly string[] };
  /** Present but offering nothing — a real state worth showing, since it usually means a broken manifest path. */
  emptyProviders?: readonly string[];
};

export type ToolsStyle = {
  bold: (text: string) => string;
  dim: (text: string) => string;
  cyan: (text: string) => string;
  yellow: (text: string) => string;
};

const plain: ToolsStyle = { bold: (t) => t, dim: (t) => t, cyan: (t) => t, yellow: (t) => t };

function sourceLabel(provenance: AgentTool["provenance"]): string {
  if (!provenance || provenance.kind === "built-in") return "built-in";
  return `${provenance.kind}:${provenance.providerId}`;
}

export function renderTools(view: ToolsView, style: ToolsStyle = plain): string {
  const groups = new Map<string, string[]>();
  for (const tool of view.tools) {
    const label = sourceLabel(tool.provenance);
    const names = groups.get(label) ?? [];
    names.push(tool.name);
    groups.set(label, names);
  }

  const lines: string[] = [];
  // Built-in first and always, then external sources: the ordering answers "what did this project
  // add?" at a glance rather than making someone scan an alphabetical list for unfamiliar names.
  const builtIn = groups.get("built-in") ?? [];
  groups.delete("built-in");
  lines.push(`  ${style.bold("built-in")} ${style.dim(`(${builtIn.length})`)}`);
  if (builtIn.length > 0) lines.push(`    ${style.dim(builtIn.join(", "))}`);

  if (groups.size === 0 && (view.emptyProviders?.length ?? 0) === 0) {
    lines.push("");
    lines.push(`  ${style.dim("No skills, plugins or MCP servers loaded.")}`);
    lines.push(`  ${style.dim("Add one under .nova/skills, .nova/plugins, or declare a server in .nova/mcp.json.")}`);
  } else {
    for (const [label, names] of groups) {
      lines.push("");
      // Yellow, matching how the CLI already marks anything not local-and-ordinary: these are tools
      // Nova did not ship, every one of them approval-gated on every call.
      lines.push(`  ${style.yellow(label)} ${style.dim(`(${names.length})`)}`);
      lines.push(`    ${style.cyan(names.join(", "))}`);
    }
    for (const label of view.emptyProviders ?? []) {
      lines.push("");
      lines.push(`  ${style.yellow(label)} ${style.dim("(0)")} ${style.dim("— loaded but offering no tools")}`);
    }
  }

  const { preToolUse, postToolUse } = view.hooks;
  if (preToolUse.length > 0 || postToolUse.length > 0) {
    lines.push("");
    lines.push(`  ${style.bold("hooks")}`);
    // Pre-tool-use is called out as blocking because that is the consequence someone needs to know
    // about when a tool call is refused for a reason Nova itself never decided.
    for (const script of preToolUse) lines.push(`    ${style.yellow("pre")}  ${script} ${style.dim("— can block a tool call")}`);
    for (const script of postToolUse) lines.push(`    ${style.dim("post")} ${script} ${style.dim("— can warn, cannot block")}`);
  }

  lines.push("");
  lines.push(`  ${style.dim("Every non-built-in tool requires approval on every call, regardless of mode.")}`);
  return lines.join("\n");
}
