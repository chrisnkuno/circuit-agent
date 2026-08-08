import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile as writeTempFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateSandboxCommand, validateWorkspaceFile } from "../sandbox-policy";
import type { InteractiveCodingSandboxProvider, SandboxCommand, SandboxCommandResult, SandboxRequest, SandboxSession } from "./contracts";

export type ProcessRunner = (argv: string[], options: { timeoutMs: number }) => Promise<SandboxCommandResult>;

const defaultRunner: ProcessRunner = (argv, options) => new Promise((resolve, reject) => {
  const child = spawn("docker", argv, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 124, stdout, stderr }); });
});

export type DockerSandboxProviderOptions = {
  image: string;
  allowInternetAccess?: boolean;
  memoryLimit?: string;
  cpuLimit?: string;
};

/**
 * Second interchangeable sandbox backend behind the same narrow contract E2B implements,
 * proving `InteractiveCodingSandboxProvider` is genuinely provider-neutral rather than
 * E2B-shaped. Talks to the local Docker CLI as argv-only subprocess calls — never a shell —
 * so the same defense-in-depth command and file policy applies regardless of backend.
 */
export class DockerSandboxProvider implements InteractiveCodingSandboxProvider {
  constructor(private readonly options: DockerSandboxProviderOptions, private readonly run: ProcessRunner = defaultRunner) {
    if (!options.image.trim()) throw new Error("A Docker coding image is required");
  }

  async createSandbox(request: SandboxRequest): Promise<SandboxSession> {
    if (!Number.isInteger(request.maxRuntimeSeconds) || request.maxRuntimeSeconds < 1 || request.maxRuntimeSeconds > 3_600) {
      throw new Error("maxRuntimeSeconds must be between 1 and 3600");
    }
    const containerName = `circuit-nova-${request.taskId.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 40)}-${randomUUID().slice(0, 8)}`;
    const result = await this.run([
      "run", "-d", "--rm",
      "--name", containerName,
      "--network", this.options.allowInternetAccess ? "bridge" : "none",
      "--memory", this.options.memoryLimit ?? "1g",
      "--cpus", this.options.cpuLimit ?? "1",
      "--workdir", "/workspace/repo",
      "--label", `circuit-nova-task=${request.taskId}`,
      this.options.image,
      "sleep", String(request.maxRuntimeSeconds + 30),
    ], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`Docker sandbox creation failed: ${result.stderr || result.stdout}`);
    return { sandboxId: containerName, status: "created" };
  }

  async runCommand(sandboxId: string, command: SandboxCommand): Promise<SandboxCommandResult> {
    validateSandboxCommand(command);
    return this.run(["exec", "-w", command.cwd ?? "/workspace/repo", sandboxId, command.program, ...command.args], { timeoutMs: command.timeoutMs + 5_000 });
  }

  async writeFile(sandboxId: string, path: string, content: string): Promise<void> {
    validateWorkspaceFile(path, content);
    const tempDir = await mkdtemp(join(tmpdir(), "circuit-nova-docker-"));
    try {
      const tempFile = join(tempDir, "payload");
      await writeTempFile(tempFile, content, "utf8");
      // docker cp does not create intermediate directories, so ensure the parent exists first.
      const mkdir = await this.run(["exec", sandboxId, "mkdir", "-p", dirname(path)], { timeoutMs: 15_000 });
      if (mkdir.exitCode !== 0) throw new Error(`Docker workspace directory creation failed: ${mkdir.stderr || mkdir.stdout}`);
      const result = await this.run(["cp", tempFile, `${sandboxId}:${path}`], { timeoutMs: 30_000 });
      if (result.exitCode !== 0) throw new Error(`Docker file write failed: ${result.stderr || result.stdout}`);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  async readFile(sandboxId: string, path: string): Promise<string> {
    validateWorkspaceFile(path, "");
    const result = await this.run(["exec", sandboxId, "cat", path], { timeoutMs: 30_000 });
    if (result.exitCode !== 0) throw new Error(`path '${path}' does not exist`);
    return result.stdout;
  }

  /**
   * A container already survives between commands, so releasing it between steps means leaving it
   * alone. `docker pause` would only freeze processes while still holding the container's memory,
   * which buys nothing here and risks a step resuming into a frozen process tree.
   */
  async suspendSandbox(): Promise<void> {}

  async stopSandbox(sandboxId: string): Promise<void> {
    await this.run(["rm", "-f", sandboxId], { timeoutMs: 30_000 });
  }
}
