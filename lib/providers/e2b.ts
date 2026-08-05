import { CommandExitError, Sandbox } from "e2b";
import { validateSandboxCommand, validateWorkspaceFile } from "../sandbox-policy";
import type { InteractiveCodingSandboxProvider, SandboxCommand, SandboxCommandResult, SandboxRequest, SandboxSession } from "./contracts";

type SandboxHandle = {
  sandboxId: string;
  commands: { run(command: string, options: { cwd?: string; timeoutMs: number }): Promise<SandboxCommandResult> };
  files: { write(path: string, content: string): Promise<unknown>; read(path: string): Promise<string> };
};

type E2BClient = {
  create(template: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  connect(sandboxId: string, options: Record<string, unknown>): Promise<SandboxHandle>;
  kill(sandboxId: string, options: Record<string, unknown>): Promise<boolean>;
};

const defaultClient: E2BClient = {
  create: (template, options) => Sandbox.create(template, options),
  connect: (sandboxId, options) => Sandbox.connect(sandboxId, options),
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

  async stopSandbox(sandboxId: string): Promise<void> {
    await this.client.kill(sandboxId, { apiKey: this.options.apiKey });
  }
}
