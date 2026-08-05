import type { AgentTool } from "./agent-runtime";
import type { InteractiveCodingSandboxProvider, SandboxCommand } from "./providers/contracts";
import { ALLOWED_SANDBOX_PROGRAMS } from "./sandbox-policy";

function workspacePath(root: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string");
  const path = value.startsWith("/") ? value : `${root}/${value}`;
  if ((path !== root && !path.startsWith(`${root}/`)) || path.split("/").includes("..")) throw new Error("path must stay inside the workspace root");
  return path;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

function commandArguments(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("args must be an array of strings");
  return value;
}

function isVerification(command: SandboxCommand): boolean {
  if (command.program === "pytest") return true;
  if (command.program === "cargo" || command.program === "go") return command.args[0] === "test";
  if (command.program === "bun" || command.program === "npm") {
    return command.args[0] === "test" || (command.args[0] === "run" && /^(test|check|typecheck|lint|build)(:|$)/.test(command.args[1] ?? ""));
  }
  if (command.program === "node") return command.args[0] === "--test";
  return command.program === "git" && command.args[0] === "diff" && command.args.includes("--check");
}

function isReadOnlyCommand(command: SandboxCommand): boolean {
  if (["ls", "pwd", "find", "rg"].includes(command.program)) return true;
  if (command.program === "git") return true;
  return ["node", "python", "python3", "go", "cargo", "bun", "npm"].includes(command.program) && ["--version", "-v", "version"].includes(command.args[0] ?? "");
}

export async function initializeE2BCodingWorkspace(options: { sandbox: InteractiveCodingSandboxProvider; sandboxId: string; workspaceRoot: string }): Promise<void> {
  const path = workspacePath(options.workspaceRoot, ".circuit-nova-workspace");
  await options.sandbox.writeFile(options.sandboxId, path, "Circuit-Nova isolated workspace.\n");
}

export function createE2BCodingTools(options: {
  sandbox: InteractiveCodingSandboxProvider;
  sandboxId: string;
  workspaceRoot: string;
}): AgentTool[] {
  const { sandbox, sandboxId, workspaceRoot } = options;
  if (workspaceRoot !== "/workspace" && !workspaceRoot.startsWith("/workspace/")) throw new Error("workspaceRoot must stay inside /workspace");
  return [
    {
      name: "read_file",
      description: "Read one UTF-8 file from the task workspace.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      capabilityId: "workspace.files", effect: "none", requiresApproval: false, parallelSafe: true,
      async execute(args) { return { content: await sandbox.readFile(sandboxId, workspacePath(workspaceRoot, args.path)) }; },
    },
    {
      name: "write_file",
      description: "Write one complete UTF-8 file inside the task workspace.",
      inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false },
      capabilityId: "workspace.files", effect: "workspace", requiresApproval: false, parallelSafe: false,
      async execute(args) {
        if (typeof args.content !== "string") throw new Error("content must be a string");
        const path = workspacePath(workspaceRoot, args.path);
        await sandbox.writeFile(sandboxId, path, args.content);
        return { content: JSON.stringify({ path, bytesWritten: new TextEncoder().encode(args.content).byteLength }) };
      },
    },
    {
      name: "search_files",
      description: "Search workspace text using a fixed-string ripgrep query.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, path: { type: "string" } }, required: ["query"], additionalProperties: false },
      capabilityId: "workspace.files", effect: "none", requiresApproval: false, parallelSafe: true,
      async execute(args) {
        const query = requiredString(args.query, "query");
        const path = workspacePath(workspaceRoot, args.path ?? ".");
        const result = await sandbox.runCommand(sandboxId, { program: "rg", args: ["--line-number", "--fixed-strings", query, path], cwd: workspaceRoot, timeoutMs: 30_000 });
        return { content: result.stdout || result.stderr || "No matches.", isError: result.exitCode > 1 };
      },
    },
    {
      name: "list_files",
      description: "List files within a bounded workspace directory depth.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
      capabilityId: "workspace.files", effect: "none", requiresApproval: false, parallelSafe: true,
      async execute(args) {
        const path = workspacePath(workspaceRoot, args.path ?? ".");
        const result = await sandbox.runCommand(sandboxId, { program: "find", args: [path, "-maxdepth", "4", "-type", "f"], cwd: workspaceRoot, timeoutMs: 30_000 });
        return { content: result.stdout || result.stderr || "No files.", isError: result.exitCode !== 0 };
      },
    },
    {
      name: "run_command",
      description: "Run one policy-allowlisted argv command inside the workspace. Shell syntax is not supported.",
      inputSchema: { type: "object", properties: { program: { type: "string", enum: ALLOWED_SANDBOX_PROGRAMS }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" }, timeoutMs: { type: "integer", minimum: 1, maximum: 900_000 } }, required: ["program", "args"], additionalProperties: false },
      capabilityId: "workspace.terminal", effect: "workspace", requiresApproval: false, parallelSafe: false,
      async execute(args) {
        const command: SandboxCommand = {
          program: requiredString(args.program, "program"),
          args: commandArguments(args.args),
          cwd: workspacePath(workspaceRoot, args.cwd ?? "."),
          timeoutMs: typeof args.timeoutMs === "number" ? args.timeoutMs : 120_000,
        };
        const result = await sandbox.runCommand(sandboxId, command);
        return {
          content: JSON.stringify({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr }),
          isError: result.exitCode !== 0,
          effect: isVerification(command) || isReadOnlyCommand(command) ? "none" : "workspace",
          verification: isVerification(command) ? { passed: result.exitCode === 0, scope: "targeted", summary: `${command.program} ${command.args.join(" ")}` } : undefined,
        };
      },
    },
  ];
}
