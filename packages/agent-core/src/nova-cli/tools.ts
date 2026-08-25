import type { AgentTool } from "../agent-runtime";
import type { ExaCategory, ExaSearchClient, ExaSearchHit } from "../providers/exa";
import type { Expense } from "./cost";
import type { DefenderBrain } from "./defender-brain";
import type { NovaWorkspace } from "./backends";
export { runShellCommand } from "./command";
export type { CommandRunner } from "./command";
import { isFindDelete, isRecursiveForceRemoval, tokenizeCommand } from "./command";
import type { HookRegistry } from "./hooks";
import { NestedInstructionTracker } from "./nested-instructions";
import { NOVA_CAPABILITIES } from "./permissions";
import { COMBINED_SECRET_PATTERN, findSecretsInLine, SEVERITY_RANK, type SecretFinding } from "./secret-scan";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "./tool-schema";
import type { ToolProvider } from "./tool-providers";
import { collectExternalTools } from "./tool-providers";
import { credentialRequest, deployOffer, deployPlan, detectWebApp, DEPLOY_PROVIDERS, type DeployTarget } from "./deploy";
import { addMemory, type MemoryKind, type MemoryScope } from "./memory";

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
   * Where project-scope memory is written.
   *
   * Separate from the workspace because memory is a *local* record even when the work is happening
   * in a remote sandbox: a fact learned during an E2B session must outlive that container, and a
   * `.nova/memory.md` inside a disposable sandbox is written to something that will be deleted.
   */
  memoryRoot?: string;
  /** Native, bounded security knowledge retrieval. Defender mode scopes the tool capability. */
  defenderBrain?: Pick<DefenderBrain, "search">;
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

/** An all-empty array reads as "no filter", not as a filter matching nothing. */
function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be an array of strings`);
  const cleaned = (value as string[]).map((entry) => entry.trim()).filter(Boolean);
  return cleaned.length > 0 ? cleaned : undefined;
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

export type PlacedSecretFinding = SecretFinding & { path: string; line: number };

/**
 * The `scan_secrets` tool's own logic, exported so a UI surface (`nova.ts`'s `/scan`) can run the
 * identical scan directly — without spending a model turn, and without the two ever drifting into
 * scanning slightly different things. Sorted worst-first: a findings list a person reads top to
 * bottom should read most-consequential first, the same convention `DEFENDER_PLAYBOOKS`' own
 * category ordering already follows.
 */
export async function scanWorkspaceForSecrets(workspace: Pick<NovaWorkspace, "grep">, include?: string): Promise<PlacedSecretFinding[]> {
  const matches = await workspace.grep(COMBINED_SECRET_PATTERN.source, { regex: true, include });
  const findings = matches.flatMap((match) => findSecretsInLine(match.text).map((finding) => ({ path: match.path, line: match.line, ...finding })));
  return findings.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]);
}

export async function createNovaTools(options: NovaToolOptions): Promise<AgentTool[]> {
  const { workspace, todos } = options;
  const commandTimeoutMs = options.commandTimeoutMs ?? 120_000;

  const tools: AgentTool[] = [
    {
      name: "read_file",
      description: "Read a UTF-8 text file from the project, including project-local environment/configuration files when relevant to the user's task. Reading is allowed; do not repeat secret values in the answer. Prefer reading a whole file; use offset/limit only for very large files.",
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
        const findings = await scanWorkspaceForSecrets(workspace, include);
        if (findings.length === 0) {
          return { content: "No likely secrets found by pattern in the scanned files.", data: { findings: [] } };
        }
        const content = findings.map((finding) => `${finding.path}:${finding.line}: [${finding.severity}] ${finding.kind} — ${finding.masked}`).join("\n");
        return {
          content: `${findings.length} possible secret${findings.length === 1 ? "" : "s"} found by pattern, worst first — verify each; a pattern match is a lead, not proof.\n${content}`,
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
      description: `Run a bounded command in the project root. Use for builds, tests, linters and git inspection. Use start_application, not this tool, for a dev server or other application the user needs to open. Requires approval. ${workspace.commandGuidance}`,
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
      async execute(args, context) {
        const command = requiredString(args.command, "command");
        // Refused, not merely gated: these destroy work that no checkpoint can return, and a
        // human approving quickly is exactly the moment they will not notice which flag it was.
        if (isRefusedCommand(command)) {
          return { content: `Refused: '${command}' can destroy work irrecoverably. Ask the user to run it themselves if it is really intended.`, isError: true };
        }
        if (isLikelyPersistentCommand(command)) {
          return {
            content: "Refused a likely persistent foreground command. Use start_application so Nova can keep it alive, verify the HTTP endpoint, and return a reachable URL. Use a short timeout only for a temporary smoke test that should stop afterward.",
            isError: true,
            data: { command, reason: "persistent_foreground_command" },
          };
        }
        const timeoutMs = Math.min(optionalInteger(args.timeoutMs, "timeoutMs") ?? commandTimeoutMs, commandTimeoutMs);
        const result = await workspace.runCommand(command, timeoutMs, context.signal);
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        // A missing program is the one failure whose fix is never "try again": the model has to
        // pick a different program. Naming that explicitly beats an ENOENT the model reads as a
        // transient error and retries verbatim.
        const missing = missingProgram(command, result);
        if (missing) {
          return {
            content: `exit ${result.exitCode}\n${body}\n\n'${missing}' is not available in this environment. Do not retry this command. Use a program listed as available in the environment section, or check for an alternative with 'command -v' before running it.`,
            isError: true,
            data: { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, missingProgram: missing },
          };
        }
        const kind = classifyVerification(command);
        const rejectedVerification = kind && result.exitCode === 0 ? rejectedVerificationReason(command, result) : null;
        const verificationNote = rejectedVerification ? `\n\nNova did not accept this as verification: ${rejectedVerification}` : "";
        return {
          content: `exit ${result.exitCode}\n${body}${verificationNote}`,
          isError: result.exitCode !== 0,
          data: { command, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, ...(kind && !rejectedVerification ? { verificationKind: kind } : {}), ...(rejectedVerification ? { verificationRejectedReason: rejectedVerification } : {}) },
          // A passing test command is the evidence the runtime needs before it will call a
          // workspace-changing run complete. The kind travels with it, so the runtime can tell a
          // behavioural result apart from a build that only proves the code compiles.
          verification: kind && result.exitCode === 0 && !rejectedVerification
            ? { passed: true, kind, scope: "targeted" as const, summary: `${command} exited 0` }
            : undefined,
        };
      },
    },
    {
      name: "start_application",
      description: "Start a local development application and keep it running across turns. Nova waits for a real HTTP response before reporting success; startup logs alone are never treated as proof. Use application_status for logs and stop_application when it is no longer needed. Requires approval.",
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string", description: "Persistent start command, for example 'bun run dev -- --port 4173'." },
          port: { type: "integer", description: "TCP port the application will listen on." },
          directory: { type: "string", description: "Project-relative application directory. Defaults to the workspace root." },
          path: { type: "string", description: "HTTP path used for readiness. Defaults to '/'." },
          timeoutMs: { type: "integer", description: "Readiness deadline, from 1000 to 60000ms. Defaults to 20000ms." },
        },
        required: ["command", "port"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.terminal,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args, context) {
        const status = await workspace.startApplication({
          command: requiredString(args.command, "command"),
          port: optionalInteger(args.port, "port")!,
          directory: typeof args.directory === "string" ? args.directory : undefined,
          path: typeof args.path === "string" ? args.path : undefined,
          timeoutMs: optionalInteger(args.timeoutMs, "timeoutMs"),
          signal: context.signal,
        });
        return {
          content: `Application ${status.id} is running and answered HTTP at ${status.url}. It will remain available while this Nova session is open.`,
          data: status,
          verification: { passed: true, kind: "smoke", scope: "targeted" as const, summary: `${status.url} answered HTTP` },
        };
      },
    },
    {
      name: "application_status",
      description: "Show managed applications, whether each process is still running, its verified URL, and recent stdout/stderr. Optionally inspect one application id.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Application id such as app-1. Omit to list all applications." } },
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.read,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
        const applications = await workspace.applicationStatus(id);
        if (applications.length === 0) return { content: id ? `No managed application named ${id}.` : "No managed applications.", data: { applications: [] } };
        const content = applications.map((application) => {
          const header = `${application.id}: ${application.state} at ${application.url} (port ${application.port})`;
          const logs = [application.stdout.trim(), application.stderr.trim()].filter(Boolean).join("\n");
          return logs ? `${header}\nRecent logs:\n${logs}` : header;
        }).join("\n\n");
        return { content, data: { applications } };
      },
    },
    {
      name: "stop_application",
      description: "Stop a managed application and its process tree. Requires approval.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Application id returned by start_application." } },
        required: ["id"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.terminal,
      effect: "workspace",
      requiresApproval: true,
      parallelSafe: false,
      async execute(args) {
        const status = await workspace.stopApplication(requiredString(args.id, "id"));
        return { content: `Stopped ${status.id} on port ${status.port}.`, data: status };
      },
    },
    {
      name: "query_defensive_brain",
      description:
        "Retrieve a few current, reviewed defensive-security records relevant to a concrete question. Use this before security analysis; refine the query instead of requesting the entire corpus.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Specific defensive question, technology, control, or behavior." },
          limit: { type: "integer", minimum: 1, maximum: 8 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.playbooks,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const query = requiredString(args.query, "query");
        const limit = optionalInteger(args.limit, "limit") ?? 4;
        if (!options.defenderBrain) return { content: "Defensive brain unavailable; use read_playbook for the curated fallback.", isError: true };
        const result = await options.defenderBrain.search(query, limit);
        if (result.hits.length === 0) {
          return { content: `No reviewed defensive-brain records matched '${query}'.${result.reason ? ` ${result.reason}` : " Refine the query or use read_playbook."}`, isError: true };
        }
        const content = result.hits.map((hit) => [
          `## ${hit.title} (${hit.domain})`,
          `Confidence: ${hit.confidence}; reviewed: ${hit.reviewedAt}; expires: ${hit.expiresAt}${hit.stale ? "; STALE — verify before relying on it" : ""}`,
          hit.summary,
          hit.guidance,
          `Sources:\n${hit.sources.map((source) => `- ${source.title}: ${source.url}`).join("\n")}`,
        ].join("\n\n")).join("\n\n---\n\n");
        return { content, data: { records: result.hits.map((hit) => ({ id: hit.id, domain: hit.domain, stale: hit.stale, confidence: hit.confidence })) } };
      },
    },
    {
      name: "read_playbook",
      description:
        "Read one security playbook in full, by id from the index in your instructions. Pull the two or three categories this project actually has a surface for, rather than reciting all of them.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.playbooks,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const id = requiredString(args.id, "id");
        const playbook = playbookFor(id);
        if (!playbook) {
          return {
            content: `No playbook '${id}'. Available: ${DEFENDER_PLAYBOOK_CATALOG.map((entry) => entry.id).join(", ")}`,
            isError: true,
          };
        }
        return { content: playbook.text, data: { id: playbook.id, title: playbook.title } };
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
          const replaced = todos.replace(texts);
          return { content: renderTodos(replaced), data: { items: replaced } };
        }
        // Both in one call, and both tolerant of a single id: a model that passes `complete: 2`
        // should not be punished with an error it has to spend another round trip recovering from.
        const complete = idList(args.complete, "complete");
        const start = idList(args.start, "start");
        if (complete.length === 0 && start.length === 0) return { content: renderTodos(todos.list()), data: { items: todos.list() } };

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
        // The same plan as values, not only as prose: a front end showing "4/9 done" must not have
        // to parse the checklist it is rendering, and a golden-event suite must not break because a
        // checkbox glyph changed.
        return { content: `${note}${warning}${renderTodos(updated.items)}`, data: { items: updated.items } };
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
        return { content: renderTodos(todos.list()), data: { items: todos.list() } };
      },
    },
  ];

  // Search is offered only when it is actually configured. A tool that is always present and
  // always fails teaches the model to stop trying, and wastes a turn discovering that each time.
  if (options.search) {
    const search = options.search;
    /**
     * Charged after the call, not before: contents are billed per page actually returned, which a
     * request that asked for ten results and found three does not know in advance. When Exa reports
     * its own `costDollars` that figure wins over the catalog rate — a list price applied to a
     * guessed page count is an estimate, and the provider's number is the invoice.
     */
    const chargeSearch = (label: string, pages: number, costDollars: number | null) => {
      options.onExpense?.({
        provider: "exa",
        meter: "search",
        quantities: { request: 1, contents: pages },
        ...(costDollars !== null ? { reportedUsd: costDollars } : {}),
        label,
      });
    };

    // Search is a discovery surface, not a bulk document loader. Enough text to establish why a
    // result matters belongs here; the full page is one targeted web_fetch away if it is actually
    // needed. This cap matters most in DEFENDER, where several advisory hits otherwise remain in
    // every later model request.
    const SEARCH_RESULT_TEXT_CHARS = 1_500;
    const renderHits = (hits: readonly ExaSearchHit[]): string =>
      hits
        .map((hit, index) => [
          `[${index + 1}] ${hit.title}${hit.publishedDate ? ` (${hit.publishedDate.slice(0, 10)})` : ""}`,
          hit.url,
          ...(hit.text ? [hit.text.slice(0, SEARCH_RESULT_TEXT_CHARS)] : hit.highlights.slice(0, 3)),
        ].join("\n"))
        .join("\n\n");

    tools.push({
      name: "web_search",
      description:
        "Search the web for documentation, APIs, error messages and current information beyond the project. Returns extractive highlights from each page, which is usually enough to answer from directly.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "A natural-language description. Long, specific queries work better than keywords." },
          numResults: { type: "integer", description: "1-25. Defaults to 3; request more only when coverage requires it." },
          includeDomains: { type: "array", items: { type: "string" }, description: "Restrict to these domains, e.g. [\"nvd.nist.gov\", \"github.com\"]." },
          excludeDomains: { type: "array", items: { type: "string" } },
          category: { type: "string", enum: ["company", "people", "publication", "news", "personal site", "financial report"] },
          startPublishedDate: { type: "string", description: "ISO date. Use to exclude stale results when recency matters." },
          fresh: { type: "boolean", description: "Bypass the content cache and crawl every result live. Slower; use when a cached copy would be a wrong answer." },
        },
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
          numResults: Math.min(optionalInteger(args.numResults, "numResults") ?? 3, 25),
          type: "auto",
          ...(optionalStringArray(args.includeDomains, "includeDomains") ? { includeDomains: optionalStringArray(args.includeDomains, "includeDomains")! } : {}),
          ...(optionalStringArray(args.excludeDomains, "excludeDomains") ? { excludeDomains: optionalStringArray(args.excludeDomains, "excludeDomains")! } : {}),
          ...(typeof args.category === "string" ? { category: args.category as ExaCategory } : {}),
          ...(typeof args.startPublishedDate === "string" ? { startPublishedDate: args.startPublishedDate } : {}),
          // `highlights` is left unset so the client sends the bare `true` Exa documents as its
          // highest-quality setting; a maxCharacters cap here would quietly lower result quality.
          ...(args.fresh === true ? { contents: { maxAgeHours: 0 } } : {}),
        });
        chargeSearch(`web search: ${query.length > 48 ? `${query.slice(0, 47)}…` : query}`, response.results.length, response.costDollars);
        if (response.results.length === 0) return { content: "No results." };
        return { content: renderHits(response.results), data: { requestId: response.requestId, searchType: response.searchType, urls: response.results.map((hit) => hit.url) } };
      },
    });

    /**
     * Multi-step research, as one tool call.
     *
     * Distinct from `web_search` rather than a flag on it, because it is a different bargain and the
     * model should be choosing it deliberately: Exa plans several sub-searches, reasons across what
     * comes back and synthesizes a cited answer, which takes 4-40 seconds instead of about one. That
     * is worth it for "what changed in this ecosystem and what does it mean for us" and wasteful for
     * "what is the signature of this function".
     *
     * This is the tool DEFENDER mode wants. A vulnerability question is exactly the shape deep
     * search is built for — it spans an advisory database, a changelog and a project's own issue
     * tracker, and the answer has to be assembled from all three rather than found on one page. The
     * grounding Exa returns is kept and rendered, because a security claim without its source is not
     * usable evidence.
     */
    tools.push({
      name: "deep_research",
      description:
        "Research a question that needs several searches and a synthesized, cited answer — ecosystem changes, security advisories affecting a dependency, comparing approaches across sources. Takes up to a minute; use web_search for anything a single page can answer.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The research question, stated in full." },
          effort: { type: "string", enum: ["lite", "standard", "maximum"], description: "Reasoning depth. Defaults to standard." },
          numResults: { type: "integer", description: "How many sources to gather. 1-25, defaults to 6." },
          instructions: { type: "string", description: "How to research, e.g. \"prefer official advisories over blog posts\". Not what shape to return." },
          includeDomains: { type: "array", items: { type: "string" } },
          startPublishedDate: { type: "string", description: "ISO date; excludes anything older." },
          fresh: { type: "boolean", description: "Crawl every source live rather than using cached copies." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      capabilityId: NOVA_CAPABILITIES.research,
      effect: "none",
      requiresApproval: false,
      parallelSafe: true,
      async execute(args) {
        const query = requiredString(args.query, "query");
        const effort = typeof args.effort === "string" ? args.effort : "standard";
        const type = effort === "lite" ? "deep-lite" : effort === "maximum" ? "deep-reasoning" : "deep";
        const response = await search.search({
          query,
          type,
          numResults: Math.min(optionalInteger(args.numResults, "numResults") ?? 6, 25),
          ...(typeof args.instructions === "string" && args.instructions.trim() ? { systemPrompt: args.instructions.trim() } : {}),
          ...(optionalStringArray(args.includeDomains, "includeDomains") ? { includeDomains: optionalStringArray(args.includeDomains, "includeDomains")! } : {}),
          ...(typeof args.startPublishedDate === "string" ? { startPublishedDate: args.startPublishedDate } : {}),
          ...(args.fresh === true ? { contents: { maxAgeHours: 0 } } : {}),
          // Text, not a structured schema: the caller is a language model that will read prose and
          // decide for itself. A JSON schema here would force every research question through one
          // predetermined shape, and Exa returns citations in `grounding` either way.
          outputSchema: { type: "text", description: "A direct, specific answer to the question, citing what it rests on." },
        });
        chargeSearch(`deep research: ${query.length > 40 ? `${query.slice(0, 39)}…` : query}`, response.results.length, response.costDollars);

        const answer = typeof response.output?.content === "string" ? response.output.content.trim() : "";
        // Sources are printed even when synthesis came back empty — a list of the right pages is a
        // usable result, and reporting "no results" over a failed synthesis would throw them away.
        const citations = (response.output?.grounding ?? []).flatMap((entry) => entry.citations.map((citation) => citation.url));
        const sources = [...new Set([...citations, ...response.results.map((hit) => hit.url)])];
        if (!answer && sources.length === 0) return { content: "No results." };
        // When synthesis succeeded, the extracts have already done their job. Appending them all
        // again duplicates the evidence beneath the answer and can add tens of thousands of tokens
        // to every later request. If synthesis failed, compact hits remain the useful fallback.
        return {
          content: [
            answer || "(no synthesized answer returned)",
            sources.length > 0 ? `\nSources:\n${sources.map((url, index) => `[${index + 1}] ${url}`).join("\n")}` : "",
            !answer && response.results.length > 0 ? `\n${renderHits(response.results)}` : "",
          ].filter(Boolean).join("\n"),
          data: { requestId: response.requestId, searchType: response.searchType, sources, grounding: response.output?.grounding ?? [] },
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
        // Exa's extractor first when it is configured: it renders JavaScript pages and parses PDFs,
        // neither of which a raw fetch plus tag-stripping can do at all — those come back as an
        // empty shell or as binary noise, and the model cannot tell either from a page that simply
        // said nothing. Falls through to the plain fetch on any failure, so the tool never becomes
        // *less* capable than it was by being wired to a second provider.
        if (options.search) {
          try {
            const extracted = await options.search.contents([url], { text: { maxCharacters: 16_000 } });
            const failure = extracted.statuses.find((status) => status.status === "error");
            const page = extracted.results[0];
            if (page?.text) {
              options.onExpense?.({
                provider: "exa",
                meter: "search",
                quantities: { request: 0, contents: 1 },
                ...(extracted.costDollars !== null ? { reportedUsd: extracted.costDollars } : {}),
                label: `fetch: ${url.length > 56 ? `${url.slice(0, 55)}…` : url}`,
              });
              return { content: page.text.slice(0, 16_000), data: { url, title: page.title, via: "exa" } };
            }
            if (failure) throw new Error(failure.errorTag ?? "extraction failed");
          } catch {
            // Deliberately silent: the fallback below is a complete answer, and reporting a
            // provider-selection detail as a tool error would read as the fetch itself failing.
          }
        }
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) return { content: `Fetch failed with status ${response.status}.`, isError: true };
        const text = await response.text();
        return { content: stripMarkup(text).slice(0, 16_000), data: { url, via: "fetch" } };
      },
    });
  }

  /**
   * Deploying, as a two-step tool: `check` answers questions, `deploy` publishes.
   *
   * One tool rather than two because they share the detection and the credential logic, and the
   * split lives in a required `action` argument the model must state outright — which is also what
   * makes the safe call unmistakably distinct from the irreversible one in an approval prompt.
   *
   * `effect: "external"` is the load-bearing declaration. The runtime enforces that an external
   * tool must require approval (`BoundedAgentRuntime`'s constructor throws otherwise), so a deploy
   * physically cannot run without a human answering — which is the guarantee this feature needs,
   * because publishing to the internet under someone's account is not undoable by a checkpoint.
   */
  tools.push({
    name: "deploy_app",
    description:
      "Check whether this project can be deployed, and deploy it to Vercel or Render once the user has agreed. Use action='check' freely — it only reads the manifest and reports what is possible, including whether an API token is configured. Use action='deploy' only after the user has explicitly asked for a deploy.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["check", "deploy"], description: "'check' inspects and reports; 'deploy' publishes." },
        target: { type: "string", enum: ["vercel", "render"], description: "Required for deploy; omit on check to see both." },
        production: { type: "boolean", description: "Deploy to production rather than a preview URL. Defaults to false." },
        directory: { type: "string", description: "Project directory, relative to the root. Defaults to the root." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    capabilityId: NOVA_CAPABILITIES.terminal,
    effect: "external",
    requiresApproval: true,
    parallelSafe: false,
    async execute(args) {
      const action = requiredString(args.action, "action");
      const directory = typeof args.directory === "string" && args.directory.trim() ? args.directory.trim() : ".";

      // Read through the workspace, so this works identically against a remote sandbox.
      const manifestPath = directory === "." ? "package.json" : `${directory}/package.json`;
      let packageJson: Record<string, unknown> | undefined;
      try {
        packageJson = JSON.parse((await workspace.readFile(manifestPath, {})).content) as Record<string, unknown>;
      } catch {
        // No manifest, or unreadable: detection handles both, and a static site legitimately has none.
      }
      let files: string[] = [];
      try {
        files = await workspace.list(directory, 2);
      } catch {
        // An unlistable directory is reported by detection as "nothing found", not as a crash.
      }
      const detection = detectWebApp({ ...(packageJson ? { packageJson } : {}), files });

      if (action === "check") {
        if (!detection.isWebApp) {
          return { content: `This does not look like a deployable web app (${detection.reason}).`, data: { ...detection } };
        }
        // Report credential state without ever reading a token value — presence only.
        const credentials = detection.recommended.map((target) => {
          const request = credentialRequest(target, process.env);
          return `  ${DEPLOY_PROVIDERS[target].label}: ${request ? `no ${request.variable} configured — ${request.url}` : "token configured"}`;
        });
        return {
          content: [
            deployOffer(detection),
            "",
            "Credentials:",
            ...credentials,
            "",
            "Nothing has been deployed. Ask the user before calling this again with action='deploy'.",
          ].filter((line) => line !== undefined).join("\n"),
          data: { ...detection, targets: detection.recommended },
        };
      }

      if (action !== "deploy") throw new Error("action must be 'check' or 'deploy'");
      const target = requiredString(args.target, "target") as DeployTarget;
      if (!(target in DEPLOY_PROVIDERS)) throw new Error(`target must be one of: ${Object.keys(DEPLOY_PROVIDERS).join(", ")}`);
      if (!detection.isWebApp) {
        return { content: `Refusing to deploy: this does not look like a web app (${detection.reason}). Say what should be deployed and I will look again.`, isError: true };
      }

      // A missing token stops the run and asks, rather than invoking a CLI that will drop into an
      // interactive login the agent cannot answer and the user cannot see.
      const request = credentialRequest(target, process.env);
      if (request) {
        return { content: request.message, isError: true, data: { needsCredential: request.variable, url: request.url, target } };
      }

      const plan = deployPlan(target, detection, { production: args.production === true, directory });
      const outputs: string[] = [];
      for (const command of plan.commands) {
        const result = await workspace.runCommand(command, Math.max(commandTimeoutMs, 300_000));
        const body = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n") || "(no output)";
        outputs.push(`$ ${command}\nexit ${result.exitCode}\n${body}`);
        if (result.exitCode !== 0) {
          return { content: [...outputs, ...plan.notes].join("\n\n"), isError: true, data: { target, exitCode: result.exitCode } };
        }
      }
      return {
        content: [...outputs, ...plan.notes].join("\n\n"),
        data: { target, production: args.production === true },
        // A live URL responding is the strongest evidence a deploy can produce — it is the
        // assembled program exercised the way a user meets it, on the machine it will actually run
        // on. Reported as smoke rather than behavior: the deploy succeeded, which is not the same
        // as every page working.
        verification: { passed: true, kind: "smoke" as const, scope: "full" as const, summary: `deployed to ${DEPLOY_PROVIDERS[target].label}` },
      };
    },
  });

  /**
   * Writing something down so the next session already knows it.
   *
   * Until now the agent could *read* memory but never write it — the defender playbook told it to
   * "persist durable conclusions to .nova/memory.md" with no tool to do so, which left it either
   * ignoring the instruction or blind-writing the file through `write_file` and destroying the
   * structure the parser and the `/memory` command depend on.
   *
   * Deliberately narrow, because an agent that remembers whatever it likes becomes an agent whose
   * context nobody can account for:
   *
   * - **Durable facts only.** The description says what qualifies and what does not. Anything true
   *   only of the current turn belongs in the answer, not in a file the user carries forever.
   * - **Scoped explicitly.** `project` goes in the repository and can be committed for a team;
   *   `user` follows the person across every project. Conflating them is how "I prefer tabs" ends
   *   up in someone else's checkout, so the model has to say which it means.
   * - **Visible and editable.** It appends a bullet to the same markdown file a human writes by
   *   hand and can open, diff or delete. Nothing is stored anywhere the user cannot see it.
   * - **Effect `workspace`, so it is approval-gated.** Writing to a file the user carries between
   *   sessions is a change to their environment, and it goes through the same gate as any edit.
   */
  tools.push({
    name: "remember",
    description:
      "Save one durable fact so future sessions start knowing it — a convention this project follows, a decision and its reason, a preference the user stated, or a lesson learned the hard way. Use it when you learn something that will still be true next week. Do not use it for anything specific to the current task, for information already obvious from the code, or to store notes to yourself mid-task (use todo_write for that).",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "One self-contained sentence. It will be read months from now with no other context." },
        scope: { type: "string", enum: ["project", "user"], description: "'project' for facts about this repository; 'user' for facts about the person that travel with them." },
        kind: { type: "string", enum: ["preference", "convention", "decision", "lesson", "fact"], description: "Preferences and conventions are recalled most eagerly. Defaults to fact." },
      },
      required: ["text", "scope"],
      additionalProperties: false,
    },
    capabilityId: NOVA_CAPABILITIES.write,
    effect: "workspace",
    requiresApproval: true,
    parallelSafe: false,
    async execute(args) {
      const text = requiredString(args.text, "text");
      const scope = requiredString(args.scope, "scope") as MemoryScope;
      if (scope !== "project" && scope !== "user") throw new Error("scope must be 'project' or 'user'");
      const kind = typeof args.kind === "string" ? args.kind as MemoryKind : "fact";
      const root = options.memoryRoot ?? workspace.label;
      const result = await addMemory(scope, text, root, process.env, { kind });
      // A duplicate is reported rather than written twice, and reported as success: the fact *is*
      // remembered, which is what the caller wanted, and an error here would invite it to retry.
      return {
        content: result.changed
          ? `Remembered (${scope}/${kind}): ${text}
Written to ${scope === "project" ? ".nova/memory.md" : result.file} — the user can edit or delete it there.`
          : `Already remembered; ${result.file} is unchanged.`,
        data: { scope, kind, text, file: result.file, changed: result.changed },
      };
    },
  });

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
export type { VerificationKind } from "../agent-runtime";
import type { VerificationKind } from "../agent-runtime";
import { DEFENDER_PLAYBOOK_CATALOG, playbookFor } from "./defender-playbooks";

/**
 * The program a failed command could not find, or null when the failure was something else.
 *
 * Matches the three ways this is reported — a POSIX shell's `command not found`, Node's spawn
 * `ENOENT`, and cmd.exe's "is not recognized" — and then confirms the name against the command
 * that was actually run, so a compiler error quoting "not found" in someone's source file does not
 * get reported as a missing program.
 */
export function missingProgram(command: string, result: { exitCode: number; stdout: string; stderr: string }): string | null {
  if (result.exitCode === 0) return null;
  const output = `${result.stdout}\n${result.stderr}`;
  const match = output.match(/(?:^|[\s:'"`])['"`]?([\w.+-]+)['"`]?:?\s*(?:command not found|not found\b|is not recognized as an internal)/i)
    ?? output.match(/ENOENT[^\n]*?spawn\s+([\w.+-]+)/i)
    ?? output.match(/spawn\s+([\w.+-]+)\s+ENOENT/i);
  const program = match?.[1];
  if (!program) return null;
  let tokens: string[];
  try {
    tokens = tokenizeCommand(command);
  } catch {
    return null;
  }
  return tokens.includes(program) ? program : null;
}

/** Runners whose names embed a word boundary the bare word "test" cannot match (e.g. `vitest`). */
const TEST_COMMAND = /\b(tests?|pytest|jest|vitest|mocha|jasmine|karma|ava|rspec|minitest|phpunit|pest|junit|gotestsum|nose2|unittest|testthat|ctest|gradlew?\s+test|xctest)\b/i;
const CHECK_COMMAND = /\b(typecheck|tsc|lint|eslint|pylint|ruff|flake8|mypy|pyright|check|build|compile|py_compile|vet|clippy|rubocop|audit|fmt|format)\b/i;

/**
 * Suites that assemble the program rather than exercising a unit of it.
 *
 * Matched *before* `TEST_COMMAND`, because every one of these also contains the word "test" or a
 * runner name — `playwright test`, `vitest run e2e/` — and classifying them as plain unit tests
 * would throw away the stronger claim they actually support.
 */
const BEHAVIOR_COMMAND = /\b(e2e|end-to-end|playwright|cypress|puppeteer|selenium|webdriver|testcafe|nightwatch|integration|behave|cucumber|supertest|testcontainers)\b/i;

/**
 * Exercising the assembled thing directly, without a suite around it.
 *
 * This is the cheap end of the ladder and deliberately so: `curl` against a route the run just
 * registered, or the project's own CLI invoked with `--help`, is seconds of evidence that the
 * program starts and answers — which no unit test establishes. `smoke` covers a project script
 * named for it, the common HTTP probes, and a health endpoint by name.
 */
const SMOKE_COMMAND = /\b(smoke|healthcheck|health[-_ ]?check|curl|wget|httpie|\bhttp\s+(?:get|post)\b|playwright\s+screenshot)\b/i;

/** Commands that normally stay alive until somebody stops them. */
const PERSISTENT_COMMAND = /(?:^|(?:&&|;|\|)\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)(?:\s|$)|(?:vite|next\s+dev|webpack\s+serve)(?:\s|$)|bun\s+run\s+--hot\b)|(?:^|\s)(?:--watch|-w)(?:\s|$)/i;

/** A persistent process is acceptable only when the same command proves it will be bounded. */
function hasPersistentCommandBoundary(command: string): boolean {
  if (/(?:^|\s)(?:timeout|gtimeout)\s+\d/i.test(command)) return true;
  const backgrounded = /(?:^|\s)&(?:\s|$)/.test(command);
  const probed = /\b(?:curl|wget|httpie|healthcheck|health[-_ ]?check)\b/i.test(command);
  const cleaned = /\b(?:kill|pkill|trap)\b/i.test(command);
  return backgrounded && probed && cleaned;
}

/** Prevents a foreground dev server from consuming the whole tool timeout and every retry. */
export function isLikelyPersistentCommand(command: string): boolean {
  return PERSISTENT_COMMAND.test(command) && !hasPersistentCommandBoundary(command);
}

/** Successful process exit is not evidence when the script explicitly says it did no work. */
export function rejectedVerificationReason(
  command: string,
  result: { stdout: string; stderr: string },
): string | null {
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (/^\s*(?:echo|printf)\b/i.test(command)) return "the command only prints text";
  if (/\b(?:no (?:automated )?tests?(?: found| configured| available)?|0 tests? (?:run|executed|passed)|no build step (?:needed|required|configured)|nothing to (?:test|build|check))\b/i.test(output)) {
    return "the command reported that no real build or test ran";
  }
  return null;
}

/** The strongest kind of evidence a command provides, or null when it verifies nothing. */
export function classifyVerification(command: string): VerificationKind | null {
  // Strongest first: a command that matches several patterns is credited with the strongest claim
  // it actually supports, and `npm run e2e` matching both "e2e" and "test" is the normal case.
  if (BEHAVIOR_COMMAND.test(command)) return "behavior";
  if (SMOKE_COMMAND.test(command)) return "smoke";
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
