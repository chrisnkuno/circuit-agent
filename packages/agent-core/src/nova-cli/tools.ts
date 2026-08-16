import type { AgentTool } from "../agent-runtime";
import type { ExaSearchClient } from "../providers/exa";
import type { Expense } from "./cost";
import type { NovaWorkspace } from "./backends";
export { runShellCommand } from "./command";
export type { CommandRunner } from "./command";
import { isFindDelete, isRecursiveForceRemoval } from "./command";
import type { HookRegistry } from "./hooks";
import { NestedInstructionTracker } from "./nested-instructions";
import { NOVA_CAPABILITIES } from "./permissions";
import { COMBINED_SECRET_PATTERN, findSecretsInLine } from "./secret-scan";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "./tool-schema";
import type { ToolProvider } from "./tool-providers";
import { collectExternalTools } from "./tool-providers";

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

  /**
   * Applies every id that exists and reports the rest, rather than throwing on the first miss.
   *
   * Observed live: a model referencing an id from an earlier turn's list (ids are never reused
   * once `replace()` hands out a fresh set) turned an otherwise-valid batch — "mark 2 and 4 done" —
   * into a hard tool error that discarded id 2's real, valid update along with it. Reporting the
   * miss and keeping the rest lets the model self-correct in its next line of text instead of
   * spending a whole round trip recovering from an error.
   */
  setStatus(ids: readonly number[], status: TodoItem["status"]): { items: TodoItem[]; unknownIds: number[] } {
    const unknownIds: number[] = [];
    for (const id of ids) {
      const item = this.items.find((candidate) => candidate.id === id);
      if (!item) { unknownIds.push(id); continue; }
      item.status = status;
    }
    return { items: this.list(), unknownIds };
  }

  /** True when every todo is already in the requested state — nothing to report, nothing to do. */
  alreadyIn(ids: readonly number[], status: TodoItem["status"]): boolean {
    return ids.length > 0 && ids.every((id) => this.items.find((item) => item.id === id)?.status === status);
  }

  list(): TodoItem[] {
    return this.items.map((item) => ({ ...item }));
  }
}

export type NovaToolOptions = {
  /** Local directory or remote sandbox — the tools are identical either way. */
  workspace: NovaWorkspace;
  todos: TodoList;
  search?: ExaSearchClient;
  /**
   * Where metered spending outside the model is reported.
   *
   * The tool is the only place that knows a search happened and how many results it billed for, so
   * it is the only place that can report it. Without this the searches simply never reach the
   * ledger, and the session total reads lower than the invoice.
   */
  onExpense?: (expense: Expense) => void;
  fetchImpl?: typeof fetch;
  /** Ceiling for a single `run_command` call. */
  commandTimeoutMs?: number;
  /** Surfaces a directory's own instructions the first time a tool reaches it. See nested-instructions.ts. */
  instructions?: NestedInstructionTracker;
  /** Skills, MCP servers and plugins — anything offering tools Nova did not ship with. See tool-providers.ts. */
  externalToolProviders?: ToolProvider[];
  /** Pre/post tool-call interception. See hooks.ts. Applied to every tool, built-in and external alike. */
  hooks?: HookRegistry;
  /**
   * Runs one self-contained sub-task through a bounded sub-agent, when the caller (`agent.ts`) has
   * wired one up. Absent this, `delegate_task` is not offered — same "only real capabilities get a
   * tool" rule `search` already follows.
   */
  delegate?: DelegateRunner;
};

export type DelegateResult = { report: string; status: string; iterations: number; toolCallsExecuted: number };
export type DelegateRunner = (task: string) => Promise<DelegateResult>;

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${name} must be a positive integer`);
  return value as number;
}

/**
 * Commands that end a session's worth of work in one keystroke. Refused rather than approved.
 *
 * `rm` and `find -delete` are deliberately not regex here — they were, and a substring match on
 * `rm\s+-[^\n]*[rf]` refused `git rm -rf old-directory`, an ordinary, safe, everyday operation that
 * removes a *tracked* file (fully recoverable from history), because the text "rm -rf" appears
 * inside it. `isRecursiveForceRemoval`/`isFindDelete` check what program is actually being run —
 * `rm` as git's subcommand and `rm` as the filesystem command are not the same operation, and only
 * a check that knows the difference can refuse one without refusing the other.
 */
const REFUSED_COMMAND_PATTERNS = [
  /\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|checkout\s+--\s+\.)/,
  /\bmkfs\b|\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\s*\{.*\|.*&\s*\}\s*;/,
];
export function isRefusedCommand(command: string): boolean {
  return REFUSED_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    || isRecursiveForceRemoval(command)
    || isFindDelete(command);
}

export async function createNovaTools(options: NovaToolOptions): Promise<AgentTool[]> {
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
        return {
          content: `${header}${result.content}`,
          data: { path: result.path, startLine: result.startLine, totalLines: result.totalLines, truncated: result.truncated },
        };
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
        return { content: entries.length > 0 ? entries.join("\n") : "No entries.", data: { entries } };
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
        return { content: matches.length > 0 ? matches.join("\n") : "No files matched.", data: { matches } };
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
        if (matches.length === 0) return { content: "No matches.", data: { matches: [] } };
        return {
          content: matches.map((match) => `${match.path}:${match.line}: ${match.text}`).join("\n"),
          data: { matches: matches.map((match) => ({ path: match.path, line: match.line, text: match.text })) },
        };
      },
    },
    {
      name: "scan_secrets",
      description: "Scan tracked files for likely hardcoded credentials (API keys, private keys, tokens, passwords) by pattern. Read-only; matched values are masked in the output, never shown in full.",
      inputSchema: {
        type: "object",
        properties: { include: { type: "string", description: "Glob limiting which files are scanned, e.g. 'src/**'." } },
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const include = typeof args.include === "string" ? args.include : undefined;
        const matches = await workspace.grep(COMBINED_SECRET_PATTERN.source, { regex: true, include });
        const findings = matches.flatMap((match) => findSecretsInLine(match.text).map((finding) => ({ path: match.path, line: match.line, ...finding })));
        if (findings.length === 0) {
          return { content: "No likely secrets found by pattern in the scanned files.", data: { findings: [] } };
        }
        const content = findings.map((finding) => `${finding.path}:${finding.line}: ${finding.kind} — ${finding.masked}`).join("\n");
        return {
          content: `${findings.length} possible secret${findings.length === 1 ? "" : "s"} found by pattern — verify each; a pattern match is a lead, not proof.\n${content}`,
          data: { findings },
        };
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
        return { content: `Wrote ${result.path} (${result.bytesWritten} bytes).`, data: { path: result.path, bytesWritten: result.bytesWritten } };
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
        return {
          content: `Edited ${result.path} (${result.replacements} replacement${result.replacements === 1 ? "" : "s"}).`,
          data: { path: result.path, replacements: result.replacements },
        };
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
        const kind = classifyVerification(command);
        return {
          content: `exit ${result.exitCode}\n${body}`,
          isError: result.exitCode !== 0,
          data: { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(kind ? { verificationKind: kind } : {}) },
          // A passing test command is the evidence the runtime needs before it will call a
          // workspace-changing run complete. The kind travels with it, so the runtime can tell a
          // behavioural result apart from a build that only proves the code compiles.
          verification: kind && result.exitCode === 0
            ? { passed: true, kind, scope: "targeted" as const, summary: `${command} exited 0` }
            : undefined,
        };
      },
    },
    {
      name: "todo_write",
      description:
        "Record the plan as a checklist at the start of any multi-step task, then keep it current. Update several todos in ONE call — pass arrays to complete and start — rather than calling this repeatedly. Do not call it again when nothing has changed. Passing `items` replaces the whole list and assigns new ids — always use the ids from the most recent todo_write or todo_read result, never ones from earlier in the conversation.",
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
        const unknownIds = new Set<number>();
        if (start.length > 0) todos.setStatus(start, "in_progress").unknownIds.forEach((id) => unknownIds.add(id));
        const updated = complete.length > 0 ? todos.setStatus(complete, "done") : { items: todos.list(), unknownIds: [] as number[] };
        updated.unknownIds.forEach((id) => unknownIds.add(id));
        const note = redundant ? "Already recorded; no change. Do not call todo_write again unless the plan changes.\n" : "";
        const warning = unknownIds.size > 0
          ? `No todo with id ${[...unknownIds].join(", ")} — it may be from an earlier list. Current ids are shown below.\n`
          : "";
        return { content: `${note}${warning}${renderTodos(updated.items)}` };
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
        const query = requiredString(args.query, "query");
        const response = await search.search({
          query,
          numResults: Math.min(optionalInteger(args.numResults, "numResults") ?? 5, 10),
          type: "auto",
          highlightMaxCharacters: 1_000,
        });
        // Both meters, and after the call rather than before it: contents are billed per page
        // actually returned, which a request that finds three results does not know in advance.
        options.onExpense?.({
          provider: "exa",
          meter: "search",
          quantities: { request: 1, contents: response.results.length },
          label: `web search: ${query.length > 48 ? `${query.slice(0, 47)}…` : query}`,
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

  if (options.delegate) {
    const delegate = options.delegate;
    tools.push({
      name: "delegate_task",
      description:
        "Hand off one self-contained sub-task to a bounded sub-agent with its own tool loop, and get back its final report. Good for an independent piece of work you can describe completely up front — a focused investigation, a well-scoped chunk of a larger job — not for the thread of work you were asked to do yourself. The sub-agent has the same tools and mode you do, minus this one: it cannot delegate further.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "A complete, self-contained brief — the sub-agent starts with no memory of this conversation." } },
        required: ["task"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.planning,
      effect: "none",
      requiresApproval: false,
      // Not parallel-safe despite effect:"none": it can run for many iterations and is expensive
      // to run concurrently with anything else in the same batch.
      parallelSafe: false,
      async execute(args) {
        const task = requiredString(args.task, "task");
        const result = await delegate(task);
        const note = result.status === "completed" ? "" : `\n\n[sub-agent ended: ${result.status}, ${result.iterations} iteration(s), ${result.toolCallsExecuted} tool call(s)]`;
        return { content: `${result.report}${note}` };
      },
    });
  }

  // External tools (skills, MCP, plugins) are merged in before the final wrap below, so schema
  // validation, path-instruction surfacing and hook interception all apply to them exactly as they
  // do to every built-in tool — one wrapping point a tool cannot reach around, regardless of where
  // it came from.
  if (options.externalToolProviders && options.externalToolProviders.length > 0) {
    const builtInNames = new Set(tools.map((tool) => tool.name));
    for (const externalTool of await collectExternalTools(options.externalToolProviders)) {
      if (builtInNames.has(externalTool.name)) throw new Error(`Tool name '${externalTool.name}' collides with a built-in Nova tool`);
      tools.push(externalTool);
    }
  }

  // Schema validation is applied here, once, rather than inside each `execute`. Wrapping every
  // tool on the way out is what makes it impossible for a tool — including one added later — to be
  // reachable without it, which is the property that stops the schema and the code drifting apart
  // again. `assertSupportedSchema` runs now so an unvalidatable schema fails at construction
  // rather than passing everything through at run time.
  const instructions = options.instructions;
  const hooks = options.hooks;
  return tools.map((tool) => {
    assertSupportedSchema(tool.name, tool.inputSchema);
    const schema = tool.inputSchema as ToolInputSchema;
    const execute = tool.execute.bind(tool);
    // `async` so a rejected argument surfaces as a rejected promise rather than a synchronous
    // throw. `execute` is declared to return a promise, and a caller that only guards `await`
    // would otherwise be bypassed by the one failure mode it most needs to catch.
    const withValidatedArguments = async (argumentsValue: Record<string, unknown>, context: Parameters<AgentTool["execute"]>[1]) =>
      execute(validateToolArguments(tool.name, schema, argumentsValue), context);
    const withInstructions =
      !instructions || !PATH_TOOLS.has(tool.name)
        ? withValidatedArguments
        : // The one place every path-taking tool passes through, which is what makes "surface a
          // directory's instructions the first time any tool reaches it" true regardless of which of
          // the three tools got there first.
          async (argumentsValue: Record<string, unknown>, context: Parameters<AgentTool["execute"]>[1]) => {
            const result = await withValidatedArguments(argumentsValue, context);
            const touchedPath = typeof argumentsValue.path === "string" ? argumentsValue.path : undefined;
            if (!touchedPath || result.isError) return result;
            const note = NestedInstructionTracker.render(await instructions.discover(touchedPath));
            return note ? { ...result, content: `${result.content}${note}` } : result;
          };
    if (!hooks) return { ...tool, execute: withInstructions };
    return {
      ...tool,
      // Outermost: hooks see the same validated arguments and final content (including any
      // nested-instruction note) that everything else in the pipeline already agreed on.
      async execute(argumentsValue, context) {
        const preOutcome = await hooks.runPreToolUse(tool.name, argumentsValue);
        if (preOutcome.blocked) return { content: `Blocked by hook: ${preOutcome.reason}`, isError: true };
        const result = await withInstructions(argumentsValue, context);
        const warnings = await hooks.runPostToolUse(tool.name, argumentsValue, { content: result.content, isError: result.isError ?? false });
        if (warnings.length === 0) return result;
        return { ...result, content: `${result.content}\n\n--- post-tool-use hook warnings ---\n${warnings.join("\n")}` };
      },
    };
  });
}

/** Tools whose `path` argument names the file or directory whose instructions matter. */
const PATH_TOOLS = new Set(["read_file", "write_file", "edit_file"]);

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

/**
 * How strong a command's success is as evidence that a workspace change actually works.
 *
 * The two are not interchangeable, and collapsing them was hiding a real failure mode: a passing
 * `tsc` says the code *parses and type-checks*, not that it does what was asked. An agent that
 * edits logic and then runs only a build has verified nothing about behaviour, but the gate could
 * not tell that apart from a full test run.
 *
 * - `tests` — executed behaviour. The only evidence that a change does what it claims.
 * - `check` — types, syntax, lint, build. Real evidence, strictly weaker: necessary, never
 *   sufficient for a change to logic.
 *
 * The patterns are deliberately generous. Observed missing in practice: `python3 -m py_compile
 * file.py` after writing a script is a real syntax check but matched none of the original
 * keywords, so a verified turn reported `needs_verification`. `lint` as a bare word never matched
 * `eslint .`, since "eslint" has no word boundary before "lint". A false positive only matters if
 * the command also exits non-zero and gets ignored, which `run_command` cannot do silently — its
 * exit code is always shown.
 */
export type VerificationKind = "tests" | "check";

/** Runners whose names embed a word boundary the bare word "test" cannot match (e.g. `vitest`). */
const TEST_COMMAND = /\b(tests?|pytest|jest|vitest|mocha|jasmine|karma|ava|rspec|minitest|phpunit|pest|junit|gotestsum|nose2|unittest|testthat|ctest|gradlew?\s+test|xctest)\b/i;
const CHECK_COMMAND = /\b(typecheck|tsc|lint|eslint|pylint|ruff|flake8|mypy|pyright|check|build|compile|py_compile|vet|clippy|rubocop|audit|fmt|format)\b/i;

/** The strongest kind of evidence a command provides, or null when it verifies nothing. */
export function classifyVerification(command: string): VerificationKind | null {
  if (TEST_COMMAND.test(command)) return "tests";
  if (CHECK_COMMAND.test(command)) return "check";
  return null;
}

export function looksLikeVerification(command: string): boolean {
  return classifyVerification(command) !== null;
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
