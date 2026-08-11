import type { InteractiveCodingSandboxProvider } from "../providers/contracts";
import { listSandboxFiles, searchSandboxText } from "../sandbox-search";
import {
  DEFAULT_WORKSPACE_LIMITS,
  displayPath,
  editTextFile,
  globToRegExp,
  globWorkspace,
  grepWorkspace,
  looksBinary,
  readTextFile,
  walkWorkspace,
  writeTextFile,
  WorkspaceViolation,
  type GrepMatch,
  type ReadResult,
  type WorkspaceLimits,
} from "./workspace";
import { hasShellSyntax, runLocalCommand, tokenizeCommand, type CommandRunner } from "./command";
export { hasShellSyntax, tokenizeCommand } from "./command";

/**
 * Where Nova's files actually live.
 *
 * The CLI runs against a developer's machine by default, but not every job should. Trying an
 * unfamiliar dependency, running a script from an untrusted issue, or working on a machine that
 * must not accumulate build output are all reasons to want the work to happen somewhere else. So
 * the tool set is written against this interface, and the same eleven tools — same names, same
 * arguments, same descriptions — run against a local directory or a remote E2B sandbox.
 *
 * One tool set, two backends, is a deliberate choice over two tool sets. The model's behaviour is
 * shaped by tool names and descriptions; changing them per backend would mean the agent that works
 * well locally is not the agent that runs remotely, and every prompt fix would have to be made
 * twice.
 */
export interface NovaWorkspace {
  readonly kind: "local" | "e2b" | "docker";
  /** Shown in the prompt and the CLI header, so nobody is unsure where files are landing. */
  readonly label: string;
  /** Backend-specific truth appended to run_command's description. */
  readonly commandGuidance: string;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<ReadResult>;
  writeFile(path: string, content: string): Promise<{ path: string; bytesWritten: number }>;
  editFile(path: string, oldText: string, newText: string, options?: { replaceAll?: boolean }): Promise<{ path: string; replacements: number }>;
  list(prefix: string, depth: number): Promise<string[]>;
  glob(pattern: string): Promise<string[]>;
  grep(query: string, options?: { include?: string; regex?: boolean }): Promise<GrepMatch[]>;
  runCommand(command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  /** Releases anything the backend is holding. Local keeps nothing; E2B has a sandbox to stop. */
  dispose(): Promise<void>;
}

/** The developer's own working tree. */
export class LocalWorkspace implements NovaWorkspace {
  readonly kind = "local" as const;
  readonly commandGuidance = "Runs in a real shell, so pipes and redirection work.";

  constructor(private readonly root: string, private readonly limits: WorkspaceLimits = DEFAULT_WORKSPACE_LIMITS, private readonly runner: CommandRunner = runLocalCommand) {}

  get label(): string {
    return this.root;
  }

  readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
    return readTextFile(this.root, path, { ...options, limits: this.limits });
  }

  writeFile(path: string, content: string): Promise<{ path: string; bytesWritten: number }> {
    return writeTextFile(this.root, path, content, this.limits);
  }

  editFile(path: string, oldText: string, newText: string, options: { replaceAll?: boolean } = {}): Promise<{ path: string; replacements: number }> {
    return editTextFile(this.root, path, oldText, newText, { ...options, limits: this.limits });
  }

  async list(prefix: string, depth: number): Promise<string[]> {
    const entries: string[] = [];
    for await (const entry of walkWorkspace(this.root, this.limits)) {
      if (prefix && entry.relative !== prefix && !entry.relative.startsWith(`${prefix}/`)) continue;
      const relativeDepth = entry.relative.split("/").length - (prefix ? prefix.split("/").length : 0);
      if (relativeDepth > depth) continue;
      entries.push(entry.isDirectory ? `${entry.relative}/` : entry.relative);
      if (entries.length >= 400) break;
    }
    return entries.sort();
  }

  glob(pattern: string): Promise<string[]> {
    return globWorkspace(this.root, pattern, this.limits);
  }

  grep(query: string, options: { include?: string; regex?: boolean } = {}): Promise<GrepMatch[]> {
    return grepWorkspace(this.root, query, { ...options, limits: this.limits });
  }

  runCommand(command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.runner(command, {
      cwd: this.root,
      timeoutMs,
      strictEnvironment: this.limits.strictCommandEnvironment,
      containProcessTree: this.limits.containProcessTree,
    });
  }

  async dispose(): Promise<void> {}
}

/**
 * Splits a command line into argv.
 *
 * The E2B provider takes argv rather than a shell string, and enforces an allowlist against the
 * program name — that is the security boundary the hosted product relies on, and the CLI does not
 * get to weaken it just because a human is watching. Shell metacharacters are refused rather than
 * quietly passed through as literal arguments, which would otherwise produce a baffling failure.
 */
export type E2BWorkspaceOptions = {
  sandbox: InteractiveCodingSandboxProvider;
  sandboxId: string;
  /** Always inside /workspace — the provider refuses anything else. */
  workspaceRoot: string;
  limits?: WorkspaceLimits;
  /** Called on dispose; the CLI decides whether that means stop or suspend. */
  onDispose?: (sandboxId: string) => Promise<void>;
};

/**
 * A remote sandbox, for when the work should not touch the developer's machine.
 *
 * Not exported directly — `E2BWorkspace` and `DockerWorkspace` are it, each fixing which sandbox
 * `kind` they report and what their label is prefixed with. Everything else about a sandboxed
 * workspace is provider-neutral already, because `InteractiveCodingSandboxProvider` (the boundary
 * this reads and writes through) is: whichever provider `options.sandbox` actually is, this class
 * cannot tell and does not need to. Two subclasses that were otherwise-identical copies of one
 * another is exactly the drift "unified execution semantics" means to rule out — a fix applied
 * here reaches both backends by construction, not by remembering to make it twice.
 *
 * Search is the interesting part: `grep` is not on the sandbox allowlist, so content search runs
 * through `rg`, and file discovery runs through `find` with the matching done locally by the same
 * tested glob matcher the local backend uses. Reusing that matcher is what keeps `**\/*.ts` mean
 * the same thing in every backend rather than "whatever the remote tool happened to support".
 */
abstract class SandboxWorkspace implements NovaWorkspace {
  abstract readonly kind: "e2b" | "docker";
  readonly commandGuidance =
    "Runs in an isolated remote sandbox as argv, not through a shell: pipes, redirection and command chaining are unavailable, and only allowlisted programs (node, python3, npm, git, rg, ls, find, pytest, cargo, go, bun, uv) may run.";

  private readonly limits: WorkspaceLimits;

  constructor(private readonly options: E2BWorkspaceOptions) {
    if (!options.workspaceRoot.startsWith("/workspace")) throw new WorkspaceViolation("Sandbox workspace root must be inside /workspace");
    this.limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  }

  get label(): string {
    return `${this.kind}:${this.options.sandboxId}:${this.options.workspaceRoot}`;
  }

  /** Same confinement rule as local, against the sandbox root instead of the project root. */
  private absolute(candidate: string): string {
    if (typeof candidate !== "string" || !candidate.trim()) throw new WorkspaceViolation("path must be a non-empty string");
    const root = this.options.workspaceRoot;
    const joined = candidate.startsWith("/") ? candidate : `${root}/${candidate}`;
    const segments: string[] = [];
    for (const segment of joined.split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") segments.pop();
      else segments.push(segment);
    }
    const resolved = `/${segments.join("/")}`;
    if (resolved !== root && !resolved.startsWith(`${root}/`)) throw new WorkspaceViolation(`path escapes the workspace root: ${candidate}`);
    return resolved;
  }

  private relative(absolute: string): string {
    return absolute.startsWith(`${this.options.workspaceRoot}/`) ? absolute.slice(this.options.workspaceRoot.length + 1) : absolute;
  }

  async readFile(path: string, options: { offset?: number; limit?: number } = {}): Promise<ReadResult> {
    const absolute = this.absolute(path);
    const text = await this.options.sandbox.readFile(this.options.sandboxId, absolute);
    if (looksBinary(Buffer.from(text.slice(0, 4_096), "utf8"))) throw new WorkspaceViolation(`${this.relative(absolute)} looks like a binary file`);
    if (Buffer.byteLength(text, "utf8") > this.limits.maxReadBytes) {
      throw new WorkspaceViolation(`${this.relative(absolute)} is above the ${this.limits.maxReadBytes}-byte read limit`);
    }

    const lines = text.split("\n");
    const startLine = Math.max(1, options.offset ?? 1);
    if (startLine === 1 && options.limit === undefined) {
      return { path: this.relative(absolute), content: text, startLine: 1, totalLines: lines.length, truncated: false };
    }
    const slice = lines.slice(startLine - 1, options.limit === undefined ? undefined : startLine - 1 + options.limit);
    return {
      path: this.relative(absolute),
      content: slice.join("\n"),
      startLine,
      totalLines: lines.length,
      truncated: startLine > 1 || (options.limit !== undefined && startLine - 1 + options.limit < lines.length),
    };
  }

  async writeFile(path: string, content: string): Promise<{ path: string; bytesWritten: number }> {
    if (typeof content !== "string") throw new WorkspaceViolation("content must be a string");
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > this.limits.maxWriteBytes) throw new WorkspaceViolation(`content is ${bytes} bytes, above the ${this.limits.maxWriteBytes}-byte write limit`);
    const absolute = this.absolute(path);
    await this.options.sandbox.writeFile(this.options.sandboxId, absolute, content);
    return { path: this.relative(absolute), bytesWritten: bytes };
  }

  async editFile(path: string, oldText: string, newText: string, options: { replaceAll?: boolean } = {}): Promise<{ path: string; replacements: number }> {
    if (typeof oldText !== "string" || oldText === "") throw new WorkspaceViolation("oldText must be a non-empty string");
    if (typeof newText !== "string") throw new WorkspaceViolation("newText must be a string");
    if (oldText === newText) throw new WorkspaceViolation("oldText and newText are identical");

    const existing = await this.readFile(path);
    const occurrences = existing.content.split(oldText).length - 1;
    if (occurrences === 0) throw new WorkspaceViolation(`oldText was not found in ${existing.path}`);
    if (occurrences > 1 && !options.replaceAll) {
      throw new WorkspaceViolation(`oldText appears ${occurrences} times in ${existing.path}; include more surrounding context or set replaceAll`);
    }
    const updated = options.replaceAll ? existing.content.split(oldText).join(newText) : existing.content.replace(oldText, newText);
    await this.writeFile(path, updated);
    return { path: existing.path, replacements: options.replaceAll ? occurrences : 1 };
  }

  /** Every file in the sandbox workspace, as project-relative paths. */
  private async allFiles(): Promise<string[]> {
    const files = await listSandboxFiles(this.options.sandbox, this.options.sandboxId, this.options.workspaceRoot, this.limits.ignoredDirectories);
    return files.map((file) => this.relative(file));
  }

  async list(prefix: string, depth: number): Promise<string[]> {
    const files = await this.allFiles();
    const entries = new Set<string>();
    for (const file of files) {
      if (prefix && file !== prefix && !file.startsWith(`${prefix}/`)) continue;
      const parts = file.split("/");
      const base = prefix ? prefix.split("/").length : 0;
      // Directories are implied by the paths beneath them; `find -type f` never lists them.
      for (let level = base + 1; level < parts.length && level - base <= depth; level += 1) {
        entries.add(`${parts.slice(0, level).join("/")}/`);
      }
      if (parts.length - base <= depth) entries.add(file);
      if (entries.size >= 400) break;
    }
    return [...entries].sort();
  }

  async glob(pattern: string): Promise<string[]> {
    const matcher = globToRegExp(pattern);
    return (await this.allFiles()).filter((file) => matcher.test(file)).sort().slice(0, 500);
  }

  async grep(query: string, options: { include?: string; regex?: boolean } = {}): Promise<GrepMatch[]> {
    return searchSandboxText({
      sandbox: this.options.sandbox,
      sandboxId: this.options.sandboxId,
      root: this.options.workspaceRoot,
      query,
      includeMatcher: options.include ? globToRegExp(options.include) : undefined,
      regex: options.regex,
      ignoredDirectories: this.limits.ignoredDirectories,
    });
  }

  async runCommand(command: string, timeoutMs: number): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (hasShellSyntax(command)) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: "This sandbox runs commands as argv, not through a shell. Pipes, redirection and chaining are unavailable — run one program per call.",
      };
    }
    const [program, ...args] = tokenizeCommand(command);
    try {
      return await this.options.sandbox.runCommand(this.options.sandboxId, { program, args, cwd: this.options.workspaceRoot, timeoutMs });
    } catch (error) {
      // A policy refusal is a fact about what is permitted, and the model can act on it — it is
      // not an infrastructure failure and must not end the run.
      return { exitCode: 2, stdout: "", stderr: error instanceof Error ? error.message : "Command was refused by the sandbox policy." };
    }
  }

  async dispose(): Promise<void> {
    await this.options.onDispose?.(this.options.sandboxId);
  }
}

/** A remote E2B sandbox. All behaviour lives in `SandboxWorkspace`; this fixes `kind` and `label`. */
export class E2BWorkspace extends SandboxWorkspace {
  readonly kind = "e2b" as const;
  constructor(options: E2BWorkspaceOptions) {
    super(options);
  }
}

/** Options are identical to E2B's — both wrap the same `InteractiveCodingSandboxProvider`. */
export type DockerWorkspaceOptions = E2BWorkspaceOptions;

/** A local Docker container as the sandbox, via `DockerSandboxProvider`. Otherwise identical to E2B. */
export class DockerWorkspace extends SandboxWorkspace {
  readonly kind = "docker" as const;
  constructor(options: DockerWorkspaceOptions) {
    super(options);
  }
}

/**
 * Copies a local project into a sandbox, for starting remote work from existing code.
 *
 * Bounded on purpose: this is a convenience for seeding a workspace, not a sync engine, and a
 * silent multi-minute upload of a repository with a large build directory would be a worse
 * surprise than an explicit limit.
 */
export async function uploadProject(
  workspace: NovaWorkspace,
  localRoot: string,
  options: { limits?: WorkspaceLimits; maxFiles?: number; onFile?: (path: string) => void } = {},
): Promise<{ uploaded: string[]; skipped: string[] }> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const maxFiles = options.maxFiles ?? 300;
  const uploaded: string[] = [];
  const skipped: string[] = [];

  for await (const entry of walkWorkspace(localRoot, limits)) {
    if (entry.isDirectory) continue;
    if (uploaded.length >= maxFiles) { skipped.push(entry.relative); continue; }
    try {
      const file = await readTextFile(localRoot, entry.relative, { limits });
      await workspace.writeFile(entry.relative, file.content);
      uploaded.push(entry.relative);
      options.onFile?.(entry.relative);
    } catch {
      // Binary and oversized files are the expected skips, not failures worth stopping for.
      skipped.push(entry.relative);
    }
  }
  return { uploaded, skipped };
}

/** Copies the sandbox workspace back to a local directory, so remote work can be kept. */
export async function downloadProject(
  workspace: NovaWorkspace,
  localRoot: string,
  options: { limits?: WorkspaceLimits } = {},
): Promise<{ written: string[]; failed: string[] }> {
  const limits = options.limits ?? DEFAULT_WORKSPACE_LIMITS;
  const written: string[] = [];
  const failed: string[] = [];

  for (const path of await workspace.glob("**/*")) {
    try {
      const file = await workspace.readFile(path);
      await writeTextFile(localRoot, path, file.content, limits);
      written.push(displayPath(localRoot, `${localRoot}/${path}`));
    } catch {
      failed.push(path);
    }
  }
  return { written, failed };
}
