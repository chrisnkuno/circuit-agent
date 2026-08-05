import { describe, expect, it } from "vitest";
import { createE2BCodingTools, initializeE2BCodingWorkspace } from "./e2b-coding-tools";
import type { InteractiveCodingSandboxProvider, SandboxCommand } from "./providers/contracts";

function fakeSandbox() {
  const commands: SandboxCommand[] = [];
  const writes: Array<{ path: string; content: string }> = [];
  const sandbox: InteractiveCodingSandboxProvider = {
    async createSandbox() { return { sandboxId: "sandbox-1", status: "created" }; },
    async stopSandbox() {},
    async readFile(_id, path) { return `read:${path}`; },
    async writeFile(_id, path, content) { writes.push({ path, content }); },
    async runCommand(_id, command) { commands.push(command); return { exitCode: 0, stdout: "ok", stderr: "" }; },
  };
  return { sandbox, commands, writes };
}

describe("E2B coding tools", () => {
  it("confines file reads and writes to the workspace", async () => {
    const fake = fakeSandbox();
    const tools = createE2BCodingTools({ sandbox: fake.sandbox, sandboxId: "sandbox-1", workspaceRoot: "/workspace/repo" });
    await expect(tools.find((tool) => tool.name === "read_file")!.execute({ path: "src/a.ts" }, { taskId: "t", runId: "r", stepId: "s" })).resolves.toMatchObject({ content: "read:/workspace/repo/src/a.ts" });
    await tools.find((tool) => tool.name === "write_file")!.execute({ path: "src/a.ts", content: "hello" }, { taskId: "t", runId: "r", stepId: "s" });
    expect(fake.writes).toEqual([{ path: "/workspace/repo/src/a.ts", content: "hello" }]);
    await expect(tools[0].execute({ path: "../escape" }, { taskId: "t", runId: "r", stepId: "s" })).rejects.toThrow("workspace root");
  });

  it("uses argv commands and recognizes verification evidence", async () => {
    const fake = fakeSandbox();
    const run = createE2BCodingTools({ sandbox: fake.sandbox, sandboxId: "sandbox-1", workspaceRoot: "/workspace/repo" }).find((tool) => tool.name === "run_command")!;
    const result = await run.execute({ program: "bun", args: ["test"] }, { taskId: "t", runId: "r", stepId: "s" });
    expect(fake.commands[0]).toEqual({ program: "bun", args: ["test"], cwd: "/workspace/repo/.", timeoutMs: 120_000 });
    expect(result.verification).toMatchObject({ passed: true, scope: "targeted" });
    const nodeResult = await run.execute({ program: "node", args: ["--test"] }, { taskId: "t", runId: "r", stepId: "s" });
    expect(nodeResult).toMatchObject({ effect: "none", verification: { passed: true } });
  });

  it("initializes the workspace before the first read-only tool call", async () => {
    const fake = fakeSandbox();
    await initializeE2BCodingWorkspace({ sandbox: fake.sandbox, sandboxId: "sandbox-1", workspaceRoot: "/workspace/repo" });
    expect(fake.writes).toEqual([{ path: "/workspace/repo/.circuit-nova-workspace", content: "Circuit-Nova isolated workspace.\n" }]);
  });

  it("keeps search fixed-string and read-only", async () => {
    const fake = fakeSandbox();
    const search = createE2BCodingTools({ sandbox: fake.sandbox, sandboxId: "sandbox-1", workspaceRoot: "/workspace/repo" }).find((tool) => tool.name === "search_files")!;
    await search.execute({ query: "hello; rm", path: "src" }, { taskId: "t", runId: "r", stepId: "s" });
    expect(fake.commands[0]).toMatchObject({ program: "rg", args: ["--line-number", "--fixed-strings", "hello; rm", "/workspace/repo/src"] });
  });
});
