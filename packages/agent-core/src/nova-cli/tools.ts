import { spawn } from "node:child_process";
import type { AgentTool } from "../agent-runtime";
import type { ExaSearchClient } from "../providers/exa";
import type { NovaWorkspace } from "./backends";
import { NOVA_CAPABILITIES } from "./permissions";

/**
 * Nova CLI's tool set.
 *
 * The shape follows the set OpenCode and Cline both arrived at independently — read, write, edit,
 * list, glob, grep, bash, todo, web — because it is the smallest set that covers real work. Two
 * decisions are worth naming:
 *
 * - `edit_file` exists alongside `write_file` so a one-line change never requires the model to
 *   reproduce a whole file from memory.
 * - `list_files`/`glob_files`/`grep_files` are separate tools rather than one search tool, because
 *   a model chooses correctly between three sharply described tools and chooses badly between
 *   three modes of one.
 *
 * Every tool declares `effect` and `parallelSafe`, which is what `BoundedAgentRuntime` uses to
 * decide what may run concurrently and what needs a human first.
 */

export type TodoItem = { id: number; text: string; status: "pending" | "in_progress" | "done" };

/**
 * Session-scoped task list. The agent's own memory of a multi-step job, not the user's.
 *
 * Status changes are applied in batches because the single-id version was measurably expensive:
 * across three live sandbox runs, `todo_write` was 5 of every 11–15 tool calls — a third of all
 * tool traffic — because closing four todos meant four separate model round trips, each one a full
 * request carrying the entire conversation. The list is bookkeeping; it should cost one call.
 */
export class TodoList {
  private items: TodoItem[] = [];
  private nextId = 1;

  replace(texts: string[]): TodoItem[] {
    this.items = texts.map((text) => ({ id: this.nextId++, text, status: "pending" as const }));
    return this.list();
  }

  setStatus(ids: readonly number[], status: TodoItem["status"]): TodoItem[] {
    for (const id of ids) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) throw new Error(`No todo with id ${id}`);
      item.status = status;
    }
    return this.list();
  }

  /** True when every todo is already in the requested state — nothing to report, nothing to do. */
  alreadyIn(ids: readonly number[], status: TodoItem["status"]): boolean {
    return ids.length > 0 && ids.every((id) => this.items.find((item) => item.id === id)?.status === status);
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}

export type CommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

export const runShellCommand: CommandRunner = (command, options) =>
  new Promise((resolve) => {
    // A real shell, deliberately: the hosted worker uses an argv allowlist because it runs
    // unattended in a container, but the CLI runs a developer's own commands on their own machine
    // with their approval on every call. Refusing pipes and redirects there would only teach them
    // to work around the tool.
    const child = spawn(command, { cwd: options.cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ exitCode: 124, stdout, stderr: `${stderr}\nCommand exceeded ${options.timeoutMs}ms and was killed.` });
    }, options.timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: 127, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });
  });

export type NovaToolOptions = {
  /** Local directory or remote sandbox — the tools are identical either way. */
  workspace: NovaWorkspace;
  todos: TodoList;
  search?: ExaSearchClient;
  fetchImpl?: typeof fetch;
  /** Ceiling for a single `run_command` call. */
  commandTimeoutMs?: number;
};

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

/** Commands that end a session's worth of work in one keystroke. Refused rather than approved. */
const REFUSED_COMMAND_PATTERNS = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/,
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/,
  /\bmkfs\b|\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{.*\|.*&\s*\}\s*;/,
];

export function isRefusedCommand(command: string): boolean {
  return REFUSED_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}

export function createNovaTools(options: NovaToolOptions): AgentTool[] {
  const { workspace, todos } = options;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;

  const tools: AgentTool[] = [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the project. Prefer reading a whole file; use offset/limit only for very large files.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path relative to the project root." },
          offset: { type: "integer", description: "1-based first line to return." },
          limit: { type: "integer", description: "How many lines to return." },
        },
        required: ["path"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const result = await workspace.readFile(requiredString(args.path, "path"), {
          offset: optionalInteger(args.offset, "offset"),
          limit: optionalInteger(args.limit, "limit"),
        });
        const header = result.truncated ? `${result.path} (lines ${result.startLine}-${result.startLine + result.content.split("\n").length - 1} of ${result.totalLines})\n` : "";
        return { content: `${header}${result.content}` };
      },
    },
    {
      name: "list_files",
      description: "List files and directories under a path in the project.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, depth: { type: "integer", description: "Directory levels to descend. Default 2." } },
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const prefix = typeof args.path === "string" && args.path.trim() && args.path !== "." ? args.path.replace(/^\.\//, "").replace(/\/$/, "") : "";
        const entries = await workspace.list(prefix, optionalInteger(args.depth, "depth") ?? 2);
        return { content: entries.length > 0 ? entries.join("\n") : "No entries." };
      },
    },
    {
      name: "glob_files",
      description: "Find files whose path matches a glob, e.g. 'src/**/*.ts' or '**/*.{js,ts}'.",
      inputSchema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"], additionalProperties: false },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const matches = await workspace.glob(requiredString(args.pattern, "pattern"));
        return { content: matches.length > 0 ? matches.join("\n") : "No files matched." };
      },
    },
    {
      name: "grep_files",
      description: "Search file contents. Fixed-string by default; set regex true for a pattern. Filter files with the include glob.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          include: { type: "string", description: "Glob limiting which files are searched." },
          regex: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const matches = await workspace.grep(requiredString(args.query, "query"), {
          include: typeof args.include === "string" ? args.include : undefined,
          regex: args.regex === true,
        });
        if (matches.length === 0) return { content: "No matches." };
        return { content: matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n") };
      },
    },
    {
      name: "write_file",
      description: "Create a file or replace its entire contents. For changing part of an existing file, use edit_file instead.",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.write,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args) {
        const result = await workspace.writeFile(requiredString(args.path, "path"), args.content as string);
        return { content: `Wrote ${result.path} (${result.bytesWritten} bytes).` };
      },
    },
    {
      name: "edit_file",
      description: "Replace an exact string in a file. oldText must appear exactly once unless replaceAll is true; include surrounding lines to make it unique.",
      inputSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          replaceAll: { type: "boolean" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.write,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args) {
        const result = await workspace.editFile(requiredString(args.path, "path"), args.oldText as string, args.newText as string, {
          replaceAll: args.replaceAll === true,
        });
        return { content: `Edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}).` };
      },
    },
    {
      name: "run_command",
      description: `Run a command in the project root. Use for builds, tests, linters and git inspection. Requires approval. ${workspace.commandGuidance}`,
      inputSchema: {
        type: "object",
        properties: { command: { type: "string" }, timeoutMs: { type: "integer" } },
        required: ["command"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.terminal,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args) {
        const command = requiredString(args.command, "command");
        // Refused, not merely gated: these destroy work that no checkpoint can return, and a
        // human approving quickly is exactly the moment they will not notice which flag it was.
        if (isRefusedCommand(command)) {
          return { content: `Refused: '${command}' can destroy work irrecoverably. Ask the user to run it themselves if it is really intended.`, isError: true };
        }
        const timeoutMs = Math.min(optionalInteger(args.timeoutMs, "timeoutMs") ?? commandTimeoutMs, commandTimeoutMs);
        const result = await workspace.runCommand(command, timeoutMs);
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        return {
          content: `exit ${result.exitCode}\n${body}`,
          isError: result.exitCode !== 0,
          // A passing test command is the evidence the runtime needs before it will call a
          // workspace-changing run complete.
          verification: looksLikeVerification(command) && result.exitCode === 0
            ? { passed: true, scope: "targeted" as const, summary: `${command} exited 0` }
            : undefined,
        };
      },
    },
    {
      name: "todo_write",
      description:
        "Record the plan as a checklist at the start of any multi-step task, then keep it current. Update several todos in ONE call — pass arrays to complete and start — rather than calling this repeatedly. Do not call it again when nothing has changed.",
      inputSchema: {
        type: "object",
        properties: {
          items: { type: "array", items: { type: "string" }, description: "Replaces the whole list." },
          complete: { type: "array", items: { type: "integer" }, description: "Todo ids that are now done." },
          start: { type: "array", items: { type: "integer" }, description: "Todo ids now in progress." },
        },
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.planning,
      effect: "none",
      requiresApproval: false,
      parallelSafe: false,
      async execute(args) {
        if (Array.isArray(args.items)) {
          const texts = args.items.map((item, index) => requiredString(item, `items[${index}]`));
          return { content: renderTodos(todos.replace(texts)) };
        }
        // Both in one call, and both tolerant of a single id: a model that passes `complete: 2`
        // should not be punished with an error it has to spend another round trip recovering from.
        const complete = idList(args.complete, "complete");
        const start = idList(args.start, "start");
        if (complete.length === 0 && start.length === 0) return { content: renderTodos(todos.list()) };

        // Saying so is cheaper than letting the model discover it by re-reading an identical list,
        // which is exactly the loop that made this the most-called tool in every measured run.
        const redundant = todos.alreadyIn(complete, "done") && start.length === 0;
        if (start.length > 0) todos.setStatus(start, "in_progress");
        const updated = complete.length > 0 ? todos.setStatus(complete, "done") : todos.list();
        const note = redundant ? "Already recorded; no change. Do not call todo_write again unless the plan changes.\n" : "";
        return { content: `${note}${renderTodos(updated)}` };
      },
    },
    {
      name: "todo_read",
      description: "Read the current checklist.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      capabilityId: NOVA_CAPABILITIES.planning,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute() {
        return { content: renderTodos(todos.list()) };
      },
    },
  ];

  // Search is offered only when it is actually configured. A tool that is always present and
  // always fails teaches the model to stop trying, and wastes a turn discovering that each time.
  if (options.search) {
    const search = options.search;
    tools.push({
      name: "web_search",
      description: "Search the web for documentation, APIs, error messages and current information beyond the project.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, numResults: { type: "integer" } },
        required: ["query"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.research,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const response = await search.search({
          query: requiredString(args.query, "query"),
          numResults: Math.min(optionalInteger(args.numResults, "numResults") ?? 5, 10),
          type: "auto",
          highlightMaxCharacters: 1_000,
        });
        if (response.results.length === 0) return { content: "No results." };
        return {
          content: response.results
            .map((hit, index) => [`[${index + 1}] ${hit.title}`, hit.url, ...(hit.highlights ?? []).slice(0, 2)].join("\n"))
            .join("\n\n"),
        };
      },
    });
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (fetchImpl) {
    tools.push({
      name: "web_fetch",
      description: "Fetch a URL and return its text, for documentation pages found by web_search.",
      inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
      capabilityId: NOVA_CAPABILITIES.research,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const url = requiredString(args.url, "url");
        if (!/^https?:\/\//i.test(url)) throw new Error("url must be http or https");
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return { content: `Fetch failed with status ${response.status}.`, isError: true };
        const text = await response.text();
        return { content: stripMarkup(text).slice(0, 40_000) };
      },
    });
  }

  return tools;
}

/** Accepts an array of ids or a bare id, because both are things a model will send. */
function idList(value: unknown, name: string): number[] {
  if (value === undefined || value === null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, index) => {
    if (!Number.isInteger(item) || (item as number) < 1) throw new Error(`${name}[${index}] must be a positive integer`);
    return item as number;
  });
}

function renderTodos(items: TodoItem[]): string {
  if (items.length === 0) return "No todos.";
  const mark = { pending: " ", in_progress: "~", done: "x" } as const;
  return items.map((item) => `[${mark[item.status]}] ${item.id}. ${item.text}`).join("\n");
}

/** Commands whose exit code is meaningful evidence that the work is correct, not just finished. */
export function looksLikeVerification(command: string): boolean {
  return /\b(test|tests|pytest|jest|vitest|typecheck|tsc|lint|check|build)\b/.test(command);
}

function stripMarkup(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
