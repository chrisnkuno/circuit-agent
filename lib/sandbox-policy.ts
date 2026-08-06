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

/**
 * What is *permitted* and what is *installed* are different questions, and conflating them costs
 * real runs. The allowlist above is the security boundary — the set of programs this system is
 * willing to run at all. The set below is what E2B's `base` template actually ships, probed
 * directly in a live sandbox: bun, pytest, uv, cargo, go and rg are all absent. A planner told it
 * may use `rg` picks it, the command exits 127, and the step fails for a reason that has nothing
 * to do with the work.
 *
 * A richer custom template can widen this through E2B_TEMPLATE_PROGRAMS without touching the
 * security boundary, which only ever narrows.
 */
export const BASE_TEMPLATE_PROGRAMS = ["npm", "git", "node", "python", "python3", "ls", "pwd", "find"] as const;

/** The programs a planner may actually be offered: permitted by policy *and* present in the image. */
export function availableSandboxPrograms(templatePrograms?: readonly string[]): AllowedSandboxProgram[] {
  const present = new Set<string>(templatePrograms ?? BASE_TEMPLATE_PROGRAMS);
  return ALLOWED_SANDBOX_PROGRAMS.filter((program) => present.has(program));
}

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
/**
 * The command rules below are exported because the model must be told them, not merely judged by
 * them. A planner that is told "git is allowed" and nothing more will propose `git init`, and the
 * step dies on a policy it was never shown — observed live as the single largest fixable class of
 * run failures. lib/coding-prompt.ts renders these into the prompt so the two cannot drift.
 */
export const ALLOWED_GIT_SUBCOMMANDS = ["diff", "log", "rev-parse", "show", "status"] as const;
/** npm and bun may only run declared scripts or tests, never arbitrary lifecycle commands. */
export const SCRIPT_RUNNER_SUBCOMMANDS = ["test", "run"] as const;
export const INLINE_EVAL_FLAGS = ["-e", "--eval", "-p", "--print", "-c"] as const;
export const INLINE_EVAL_PROGRAMS = ["node", "python", "python3"] as const;

const allowedGitSubcommands = new Set<string>(ALLOWED_GIT_SUBCOMMANDS);

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
  if ((INLINE_EVAL_PROGRAMS as readonly string[]).includes(command.program) && command.args.some((argument) => (INLINE_EVAL_FLAGS as readonly string[]).includes(argument))) {
    throw new Error("Inline program evaluation is blocked");
  }
  if (command.program === "git") {
    const subcommand = command.args.find((argument) => !argument.startsWith("-"));
    if (!subcommand || !allowedGitSubcommands.has(subcommand)) throw new Error("Git command is not read-only");
  }
  if (command.program === "bun" && command.args[0] && !(SCRIPT_RUNNER_SUBCOMMANDS as readonly string[]).includes(command.args[0])) {
    throw new Error("Bun command must run a declared script or test");
  }
  if (command.program === "npm" && command.args[0] && !(SCRIPT_RUNNER_SUBCOMMANDS as readonly string[]).includes(command.args[0])) {
    throw new Error("npm command must run a declared script or test");
  }
}

export function validateWorkspaceFile(path: string, content: string): void {
  assertWorkspacePath(path, "File path");
  if (new TextEncoder().encode(content).byteLength > 1_000_000) throw new Error("Sandbox file exceeds the 1MB limit");
}
