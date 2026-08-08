import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../agent-runtime";
import { LocalWorkspace } from "./backends";
import { createNovaTools, isRefusedCommand, looksLikeVerification, TodoList } from "./tools";

let root: string;
const context = { taskId: "t", runId: "r", stepId: "s" };

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-tools-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export const port = 3000;\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("nova tool set", () => {
  it("declares effects the runtime can enforce, and gates exactly the dangerous ones", () => {
    const tools = createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    for (const name of ["read_file", "list_files", "glob_files", "grep_files"]) {
      expect(byName[name].effect, name).toBe("none");
      expect(byName[name].requiresApproval, name).toBe(false);
    }
    for (const name of ["write_file", "edit_file", "run_command"]) {
      expect(byName[name].effect, name).toBe("workspace");
      expect(byName[name].requiresApproval, name).toBe(true);
      // The runtime refuses to parallelise anything with an effect; this is what makes that true.
      expect(byName[name].parallelSafe, name).toBe(false);
    }
  });

  it("reads, writes and edits through the confined workspace", async () => {
    const tools = createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const read = await toolNamed(tools, "read_file").execute({ path: "src/app.ts" }, context);
    expect(read.content).toContain("port = 3000");

    await toolNamed(tools, "edit_file").execute({ path: "src/app.ts", oldText: "3000", newText: "8080" }, context);
    expect(await fs.readFile(path.join(root, "src", "app.ts"), "utf8")).toContain("8080");

    await expect(toolNamed(tools, "read_file").execute({ path: "../escape.txt" }, context)).rejects.toThrow(/escapes the workspace/);
  });

  it("runs commands through the injected runner and marks a passing check as verification", async () => {
    const seen: string[] = [];
    const tools = createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async (command: string) => {
        seen.push(command);
        return { exitCode: 0, stdout: "2 passed", stderr: "" };
      }),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(seen).toEqual(["npm test"]);
    expect(result.content).toContain("exit 0");
    expect(result.verification).toEqual({ passed: true, scope: "targeted", summary: "npm test exited 0" });

    const plain = await toolNamed(tools, "run_command").execute({ command: "ls -la" }, context);
    expect(plain.verification).toBeUndefined();
  });

  it("reports a non-zero command as an error without throwing away its output", async () => {
    const tools = createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 1, stdout: "", stderr: "TypeError: x is not a function" })),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("TypeError");
  });

  it("refuses irrecoverable commands rather than offering them for approval", async () => {
    expect(isRefusedCommand("rm -rf /")).toBe(true);
    expect(isRefusedCommand("git reset --hard HEAD~3")).toBe(true);
    expect(isRefusedCommand("git clean -fd")).toBe(true);
    expect(isRefusedCommand("rm build/output.txt")).toBe(false);
    expect(isRefusedCommand("npm test")).toBe(false);

    let ran = false;
    const tools = createNovaTools({ workspace: new LocalWorkspace(root, undefined, async () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; }), todos: new TodoList() });
    const result = await toolNamed(tools, "run_command").execute({ command: "rm -rf ." }, context);
    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Refused");
  });

  it("keeps a working checklist across calls", async () => {
    const tools = createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const write = toolNamed(tools, "todo_write");
    const created = await write.execute({ items: ["read the config", "add the flag"] }, context);
    expect(created.content).toContain("[ ] 1. read the config");

    const started = await write.execute({ start: 1 }, context);
    expect(started.content).toContain("[~] 1.");

    const done = await write.execute({ complete: 1 }, context);
    expect(done.content).toContain("[x] 1.");

    const read = await toolNamed(tools, "todo_read").execute({}, context);
    expect(read.content).toContain("[x] 1. read the config");
  });

  it("offers web_search only when search is configured", () => {
    const withoutSearch = createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    expect(withoutSearch.some((tool) => tool.name === "web_search")).toBe(false);

    const withSearch = createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: { search: async () => ({ requestId: "r", results: [] }) } as never,
    });
    expect(withSearch.some((tool) => tool.name === "web_search")).toBe(true);
  });

  it("formats search results into something the model can cite", async () => {
    const tools = createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: {
        search: async () => ({
          requestId: "r",
          results: [{ title: "Node fetch docs", url: "https://example.com/fetch", publishedDate: null, author: null, highlights: ["fetch is global since 18"] }],
        }),
      } as never,
    });
    const result = await toolNamed(tools, "web_search").execute({ query: "node fetch" }, context);
    expect(result.content).toContain("[1] Node fetch docs");
    expect(result.content).toContain("https://example.com/fetch");
    expect(result.content).toContain("global since 18");
  });
});

describe("verification detection", () => {
  it("recognises the commands whose exit code is real evidence", () => {
    expect(looksLikeVerification("npm test")).toBe(true);
    expect(looksLikeVerification("bunx tsc --noEmit")).toBe(true);
    expect(looksLikeVerification("pytest -q")).toBe(true);
    expect(looksLikeVerification("git status")).toBe(false);
    expect(looksLikeVerification("echo hello")).toBe(false);
  });
});
