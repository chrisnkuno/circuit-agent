import type { SandboxCommand } from "./providers/contracts";

export const ALLOWED_SANDBOX_PROGRAMS = [
  "bun",
  "npm",
  "git",
  "node",
  "python",
  "python3",
  "pytest",
  "uv",
  "cargo",
  "go",
  "rg",
  "ls",
  "pwd",
  "find",
] as const;

export type AllowedSandboxProgram = (typeof ALLOWED_SANDBOX_PROGRAMS)[number];

const allowedPrograms = new Set<string>(ALLOWED_SANDBOX_PROGRAMS);
const blockedArguments = new Set([
  "-c",
  "--config-env",
  "--exec",
  "--exec-path",
  "--pre",
  "--pre-glob",
  "--upload-pack",
  "-delete",
  "-exec",
  "-execdir",
  "-ok",
  "-okdir",
]);
const allowedGitSubcommands = new Set(["diff", "log", "rev-parse", "show", "status"]);

function assertWorkspacePath(path: string, label: string): void {
  if ((path !== "/workspace" && !path.startsWith("/workspace/")) || path.split("/").includes("..")) {
    throw new Error(`${label} must stay inside /workspace`);
  }
}

/** Defense-in-depth policy applied before any command reaches an E2B shell. */
export function validateSandboxCommand(command: SandboxCommand): void {
  if (!allowedPrograms.has(command.program)) throw new Error(`Program is not allowed in coding sandboxes: ${command.program}`);
  if (!Number.isInteger(command.timeoutMs) || command.timeoutMs < 1 || command.timeoutMs > 15 * 60_000) {
    throw new Error("Command timeout must be between 1ms and 15 minutes");
  }
  if (command.args.length > 64 || command.args.some((argument) => argument.length > 4_096)) {
    throw new Error("Command arguments exceed the sandbox policy");
  }
  if (command.cwd) assertWorkspacePath(command.cwd, "cwd");
  if (command.args.some((argument) => blockedArguments.has(argument))) {
    throw new Error("Command contains an argument blocked by the sandbox policy");
  }
  if (command.args.some((argument) => argument.startsWith("/") && argument !== "/workspace" && !argument.startsWith("/workspace/"))) {
    throw new Error("Absolute command arguments must stay inside /workspace");
  }
  if ((command.program === "node" || command.program === "python" || command.program === "python3") && command.args.some((argument) => ["-e", "--eval", "-p", "--print", "-c"].includes(argument))) {
    throw new Error("Inline program evaluation is blocked");
  }
  if (command.program === "git") {
    const subcommand = command.args.find((argument) => !argument.startsWith("-"));
    if (!subcommand || !allowedGitSubcommands.has(subcommand)) throw new Error("Git command is not read-only");
  }
  if (command.program === "bun" && command.args[0] && !["test", "run"].includes(command.args[0])) {
    throw new Error("Bun command must run a declared script or test");
  }
  if (command.program === "npm" && command.args[0] && !["test", "run"].includes(command.args[0])) {
    throw new Error("npm command must run a declared script or test");
  }
}

export function validateWorkspaceFile(path: string, content: string): void {
  assertWorkspacePath(path, "File path");
  if (new TextEncoder().encode(content).byteLength > 1_000_000) throw new Error("Sandbox file exceeds the 1MB limit");
}
