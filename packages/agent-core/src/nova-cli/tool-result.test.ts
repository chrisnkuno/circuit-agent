import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../agent-runtime";
import { LocalWorkspace } from "./backends";
import { WORKSPACE_TOKEN, normalizeToolResult, serializeToolResult } from "./tool-result";
import { createNovaTools, TodoList } from "./tools";

const context = { taskId: "t", runId: "r", stepId: "s" };

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

/**
 * Runs the same script of tool calls in a fresh directory and returns the serialized envelopes.
 *
 * Two directories, one script: whatever differs between the two runs is location, not behaviour.
 */
async function runScript(prefix: string): Promise<{ root: string; envelopes: string[] }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\nexport const host = \"localhost\";\n");
  const tools = await createNovaTools({
    workspace: new LocalWorkspace(root, undefined, async (command) => ({
      // Compilers print absolute paths; this is the exact shape that breaks naive comparison.
      exitCode: 0,
      stdout: `running in ${root}\n${path.join(root, "app.ts")}:1:1 - ok\n`,
      stderr: "",
    })),
    todos: new TodoList(),
  });
  const options = { root, realRoot: await fs.realpath(root) };
  const envelopes: string[] = [];
  const record = async (name: string, args: Record<string, unknown>) => {
    envelopes.push(serializeToolResult(await toolNamed(tools, name).execute(args, context), options));
  };
  await record("write_file", { path: "notes.md", content: "hello\n" });
  await record("read_file", { path: "app.ts" });
  await record("edit_file", { path: "app.ts", oldText: "3000", newText: "8080" });
  await record("glob_files", { pattern: "**/*.ts" });
  await record("grep_files", { query: "port" });
  await record("list_files", {});
  await record("run_command", { command: "npm test" });
  return { root, envelopes };
}

describe("tool results carry their facts as data", () => {
  it("reports the same result as prose and as values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-data-"));
    try {
      const tools = await createNovaTools({
        workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 2, stdout: "1 failed", stderr: "boom" })),
        todos: new TodoList(),
      });
      const written = await toolNamed(tools, "write_file").execute({ path: "a.txt", content: "hello" }, context);
      expect(written.content).toBe("Wrote a.txt (5 bytes).");
      expect(written.data).toEqual({ path: "a.txt", bytesWritten: 5 });

      const edited = await toolNamed(tools, "edit_file").execute({ path: "a.txt", oldText: "hello", newText: "goodbye" }, context);
      expect(edited.data).toEqual({ path: "a.txt", replacements: 1 });

      // The exit code and both streams survive as values, so an assertion never has to parse the
      // "exit 2\n..." sentence the model reads.
      const ran = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
      expect(ran.isError).toBe(true);
      expect(ran.data).toMatchObject({ command: "npm test", exitCode: 2, stdout: "1 failed", stderr: "boom", verificationKind: "tests" });

      const matches = await toolNamed(tools, "grep_files").execute({ query: "goodbye" }, context);
      expect(matches.data).toEqual({ matches: [{ path: "a.txt", line: 1, text: "goodbye" }] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("says so in data when a read was truncated, not only in the header", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-data-"));
    try {
      await fs.writeFile(path.join(root, "big.txt"), Array.from({ length: 50 }, (_, index) => `line ${index + 1}`).join("\n"));
      const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
      const result = await toolNamed(tools, "read_file").execute({ path: "big.txt", offset: 10, limit: 5 }, context);
      expect(result.data).toMatchObject({ path: "big.txt", startLine: 10, totalLines: 50, truncated: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("normalizing a result for comparison", () => {
  it("makes identical work in two different directories compare byte for byte", async () => {
    // The property that matters, and the one that was not true before: a golden envelope recorded
    // on one machine has to match the same work replayed on another, where the only difference is
    // the directory it happened in.
    const first = await runScript("nova-normA-");
    const second = await runScript("nova-normB-");
    try {
      expect(first.root).not.toBe(second.root);
      expect(second.envelopes).toEqual(first.envelopes);
      // And the root really was present to begin with — otherwise this proves nothing.
      const rawCommand = first.envelopes.at(-1)!;
      expect(rawCommand).toContain(WORKSPACE_TOKEN);
      expect(rawCommand).not.toContain(first.root);
    } finally {
      await fs.rm(first.root, { recursive: true, force: true });
      await fs.rm(second.root, { recursive: true, force: true });
    }
  });

  it("replaces the real path too, for a symlinked temporary directory", () => {
    // macOS reaches /var/folders/... and reports /private/var/folders/... — handling only the
    // first fails on exactly the machines contributors are most likely to use.
    const result = normalizeToolResult(
      { content: "error at /private/tmp/build/app.ts:3", data: { path: "/tmp/build/app.ts" } },
      { root: "/tmp/build", realRoot: "/private/tmp/build" },
    );
    expect(result.content).toBe(`error at ${WORKSPACE_TOKEN}/app.ts:3`);
    expect(result.data).toEqual({ path: `${WORKSPACE_TOKEN}/app.ts` });
  });

  it("normalizes both separator styles even when the evidence came from another OS", () => {
    const result = normalizeToolResult(
      { content: "POSIX /tmp/build/app.ts; Windows C:\\work\\build\\app.ts" },
      { root: "/tmp/build", realRoot: "C:\\work\\build" },
    );
    expect(result.content).toBe(`POSIX ${WORKSPACE_TOKEN}/app.ts; Windows ${WORKSPACE_TOKEN}\\app.ts`);
  });

  it("handles a root containing regex metacharacters", () => {
    // `+` and `(` are legal in directory names, and a normalizer built on RegExp would either
    // throw or silently match the wrong thing.
    const root = "/tmp/build+test (1)";
    const result = normalizeToolResult({ content: `failed in ${root}/app.ts` }, { root });
    expect(result.content).toBe(`failed in ${WORKSPACE_TOKEN}/app.ts`);
  });

  it("applies caller-supplied scrubbers for volatility it cannot guess", () => {
    // Durations and ports cannot be spotted without also mangling real output, so the caller names
    // them. This one is a test runner's timing line.
    const result = normalizeToolResult(
      { content: "Tests passed in 1.234s on port 51234", data: { stdout: "done in 9.9s" } },
      { root: "/tmp/x", scrub: [[/\d+\.\d+s/g, "<duration>"], [/port \d+/g, "port <port>"]] },
    );
    expect(result.content).toBe("Tests passed in <duration> on port <port>");
    expect(result.data).toEqual({ stdout: "done in <duration>" });
  });

  it("treats property order as no difference at all", () => {
    const left = serializeToolResult({ content: "ok", data: { b: 2, a: 1 } }, { root: "/tmp/x" });
    const right = serializeToolResult({ content: "ok", data: { a: 1, b: 2 } }, { root: "/tmp/x" });
    expect(left).toBe(right);
  });

  it("leaves the original result untouched, since the model must see what the tool produced", () => {
    const original = { content: "in /tmp/x/app.ts", data: { path: "/tmp/x/app.ts" } };
    const copy = structuredClone(original);
    normalizeToolResult(original, { root: "/tmp/x" });
    expect(original).toEqual(copy);
  });

  it("normalizes verification evidence, which embeds the command that was run", () => {
    const result = normalizeToolResult(
      { content: "ok", verification: { passed: true, kind: "tests", scope: "targeted", summary: "/tmp/x/node_modules/.bin/vitest exited 0" } },
      { root: "/tmp/x" },
    );
    expect(result.verification?.summary).toBe(`${WORKSPACE_TOKEN}/node_modules/.bin/vitest exited 0`);
  });
});
