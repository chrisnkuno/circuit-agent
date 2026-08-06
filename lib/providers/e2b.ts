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

/** Concrete E2B adapter with secure access, bounded lifetime, and argv-only commands. */
export class E2BSandboxProvider implements InteractiveCodingSandboxProvider {
  constructor(private readonly options: E2BSandboxProviderOptions, private readonly client: E2BClient = defaultClient) {
    if (!options.apiKey.trim()) throw new Error("E2B_API_KEY is required");
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
    const sandbox = await this.client.connect(sandboxId, { apiKey: this.options.apiKey, timeoutMs: command.timeoutMs + 5_000 });
    const serialized = [command.program, ...command.args.map(quoteArgument)].join(" ");
    try {
      return await sandbox.commands.run(serialized, { cwd: command.cwd, timeoutMs: command.timeoutMs });
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
    const sandbox = await this.client.connect(sandboxId, { apiKey: this.options.apiKey, timeoutMs: 30_000 });
    await sandbox.files.write(path, content);
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    validateWorkspaceFile(path, "");
    const sandbox = await this.client.connect(sandboxId, { apiKey: this.options.apiKey, timeoutMs: 30_000 });
    return sandbox.files.read(path);
  }

  /**
   * Pauses without a memory snapshot: only the filesystem is preserved, which is exactly what the
   * next step needs and nothing more. Keeping memory would snapshot running processes at roughly
   * four seconds per gigabyte, to restore a process tree the next step never inherits anyway.
   */
  async suspendSandbox(sandboxId: string): Promise<void> {
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
    await this.client.kill(sandboxId, { apiKey: this.options.apiKey });
  }
}
