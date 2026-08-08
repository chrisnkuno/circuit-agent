import { CommandExitError, Sandbox } from "e2b";
import { validateSandboxCommand, validateWorkspaceFile } from "../sandbox-policy";
import type { InteractiveCodingSandboxProvider, SandboxCommand, SandboxCommandResult, SandboxRequest, SandboxSession } from "./contracts";

type SandboxHandle = {
  sandboxId: string;
  commands: { run(command: string, options: { cwd?: string; timeoutMs: number }): Promise<SandboxCommandResult> };
  files: { write(path: string, content: string): Promise<unknown>; read(path: string): Promise<string> };
};

export type OwnedSandbox = { sandboxId: string; startedAtMs: number };

type E2BClient = {
  create(template: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  list(options: Record<string, unknown>): Promise<Array<{ sandboxId: string; startedAt?: Date | string; metadata?: Record<string, unknown> }>>;
  connect(sandboxId: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  pause(sandboxId: string, options: Record<string, unknown>): Promise<boolean>;
  kill(sandboxId: string, options: Record<string, unknown>): Promise<boolean>;
};

const defaultClient: E2BClient = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
  pause: (sandboxId, options) => Sandbox.pause(sandboxId, options),
  list: async (options) => {
    const paginator = Sandbox.list(options as never);
    const page = await paginator.nextItems();
    return page.map((item: Record<string, any>) => ({
      sandboxId: item.sandboxId ?? item.sandboxID,
      startedAt: item.startedAt,
      metadata: item.metadata,
    }));
  },
  kill: (sandboxId, options) => Sandbox.kill(sandboxId, options),
};

function quoteArgument(argument: string): string {
  return `'${argument.replaceAll("'", `'"'"'`)}'`;
}

export type E2BSandboxProviderOptions = {
  apiKey: string;
  templates?: Partial<Record<SandboxRequest["template"], string>>;
  allowInternetAccess?: boolean;
};

/** Connection errors are worth one silent retry; anything else is the caller's to handle. */
function looksDisconnected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /not found|terminated|disconnect|ECONNRESET|socket hang up|closed|unavailable|timeout/i.test(message);
}

/** Concrete E2B adapter with secure access, bounded lifetime, and argv-only commands. */
export class E2BSandboxProvider implements InteractiveCodingSandboxProvider {
  /**
   * One live connection per sandbox, reused across operations.
   *
   * Every read, write and command used to open its own connection, measured at ~380ms each against
   * a live sandbox. A thirteen-tool step therefore spent about five seconds doing nothing but
   * reconnecting, and the no-ripgrep search fallback — which reads files one at a time — paid it
   * per file. The handle is dropped and rebuilt on any error that looks like a dead connection, so
   * reuse never turns a transient disconnect into a failed step.
   */
  private readonly handles = new Map<string, Promise<SandboxHandle>>();

  constructor(private readonly options: E2BSandboxProviderOptions, private readonly client: E2BClient = defaultClient) {
    if (!options.apiKey.trim()) throw new Error("E2B_API_KEY is required");
  }

  private handle(sandboxId: string, timeoutMs: number): Promise<SandboxHandle> {
    const existing = this.handles.get(sandboxId);
    if (existing) return existing;
    const created = this.client.connect(sandboxId, { apiKey: this.options.apiKey, timeoutMs });
    this.handles.set(sandboxId, created);
    // A failed connect must not be cached, or the sandbox is permanently unusable.
    created.catch(() => this.handles.delete(sandboxId));
    return created;
  }

  /** Runs an operation on the shared handle, reconnecting once if the connection has gone. */
  private async withHandle<T>(sandboxId: string, timeoutMs: number, operation: (sandbox: SandboxHandle) => Promise<T>): Promise<T> {
    try {
      return await operation(await this.handle(sandboxId, timeoutMs));
    } catch (error) {
      if (error instanceof CommandExitError || !looksDisconnected(error)) throw error;
      this.handles.delete(sandboxId);
      return operation(await this.handle(sandboxId, timeoutMs));
    }
  }

  async createSandbox(request: SandboxRequest): Promise<SandboxSession> {
    if (!Number.isInteger(request.maxRuntimeSeconds) || request.maxRuntimeSeconds < 1 || request.maxRuntimeSeconds > 3_600) {
      throw new Error("maxRuntimeSeconds must be between 1 and 3600");
    }
    const template = this.options.templates?.[request.template] ?? "base";
    const sandbox = await this.client.create(template, {
      apiKey: this.options.apiKey,
      timeoutMs: request.maxRuntimeSeconds * 1_000,
      secure: true,
      allowInternetAccess: this.options.allowInternetAccess ?? false,
      metadata: { taskId: request.taskId, purpose: request.template },
    });
    return { sandboxId: sandbox.sandboxId, status: "created" };
  }

  async runCommand(sandboxId: string, command: SandboxCommand): Promise<SandboxCommandResult> {
    validateSandboxCommand(command);
    const serialized = [command.program, ...command.args.map(quoteArgument)].join(" ");
    try {
      return await this.withHandle(sandboxId, command.timeoutMs + 5_000, (sandbox) =>
        sandbox.commands.run(serialized, { cwd: command.cwd, timeoutMs: command.timeoutMs }));
    } catch (error) {
      // The provider contract represents ordinary process failures as results so
      // the worker can record them as evidence and make its own lifecycle decision.
      if (error instanceof CommandExitError) {
        return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
      }
      throw error;
    }
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    validateWorkspaceFile(path, content);
    await this.withHandle(sandboxId, 30_000, (sandbox) => sandbox.files.write(path, content));
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    validateWorkspaceFile(path, "");
    return this.withHandle(sandboxId, 30_000, (sandbox) => sandbox.files.read(path));
  }

  /**
   * Pauses without a memory snapshot: only the filesystem is preserved, which is exactly what the
   * next step needs and nothing more. Keeping memory would snapshot running processes at roughly
   * four seconds per gigabyte, to restore a process tree the next step never inherits anyway.
   */
  async suspendSandbox(sandboxId: string): Promise<void> {
    // The handle cannot survive the pause, and a stale one would be handed to the next step.
    this.handles.delete(sandboxId);
    await this.client.pause(sandboxId, { apiKey: this.options.apiKey, keepMemory: false });
  }

  /**
   * Sandboxes this system created, in any state. The `purpose` metadata written at creation is the
   * only ownership marker — an account is shared with other projects, and reaping something this
   * system did not create would destroy someone else's work.
   */
  async listOwnedSandboxes(): Promise<OwnedSandbox[]> {
    const all = await this.client.list({ apiKey: this.options.apiKey });
    return all
      .filter((item) => typeof item.metadata?.purpose === "string" && Boolean(item.sandboxId))
      .map((item) => ({
        sandboxId: item.sandboxId,
        startedAtMs: item.startedAt ? new Date(item.startedAt).getTime() : 0,
      }));
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    this.handles.delete(sandboxId);
    await this.client.kill(sandboxId, { apiKey: this.options.apiKey });
  }
}
