import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTool } from "../agent-runtime";
import { LocalWorkspace } from "./backends";
import { loadMemories, memoryFile, memoryPromptBlock, recallMemories } from "./memory";
import { createNovaTools, TodoList } from "./tools";

/**
 * The agent writing to its own memory.
 *
 * Until this tool existed the agent could read memory but never add to it — the defender playbook
 * instructed it to "persist durable conclusions to .nova/memory.md" with no tool to do so, so it
 * either ignored the instruction or blind-wrote the file through `write_file` and destroyed the
 * structure the parser and the `/memory` command depend on.
 */

let root: string;
let config: string;
const context = { taskId: "t", runId: "r", stepId: "s" };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-remember-"));
  config = await fs.mkdtemp(path.join(os.tmpdir(), "nova-config-"));
  process.env.NOVA_CONFIG_DIR = config;
});

afterEach(async () => {
  delete process.env.NOVA_CONFIG_DIR;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(config, { recursive: true, force: true });
});

async function rememberTool(): Promise<AgentTool> {
  const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), memoryRoot: root });
  const tool = tools.find((candidate) => candidate.name === "remember");
  if (!tool) throw new Error("remember tool is not registered");
  return tool;
}

describe("the remember tool", () => {
  it("is gated like any other change to the user's files", async () => {
    const tool = await rememberTool();
    // A file the user carries between sessions is part of their environment, not free scratch space.
    expect(tool.effect).toBe("workspace");
    expect(tool.requiresApproval).toBe(true);
    expect(tool.parallelSafe).toBe(false);
  });

  it("writes a project fact to the repository's own memory file", async () => {
    const tool = await rememberTool();
    const result = await tool.execute({ text: "This project uses bun, never npm.", scope: "project", kind: "convention" }, context);
    expect(result.content).toContain("Remembered");
    expect(result.data?.file).toBe(path.join(root, ".nova", "memory.md"));

    const entries = await loadMemories(root, process.env);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ scope: "project", kind: "convention", text: "This project uses bun, never npm." });
  });

  /**
   * The scopes are the whole reason memory is safe to share. Project memory can be committed for a
   * team; user memory follows the person. Conflating them is how "I prefer tabs" ends up in
   * someone else's checkout.
   */
  it("keeps user memory out of the repository", async () => {
    const tool = await rememberTool();
    await tool.execute({ text: "The user prefers terse answers.", scope: "user", kind: "preference" }, context);

    expect(await fs.readFile(memoryFile("user", root, process.env), "utf8")).toContain("terse answers");
    // Nothing was written into the project at all — not an empty file, not a heading.
    await expect(fs.readFile(path.join(root, ".nova", "memory.md"), "utf8")).rejects.toThrow();
  });

  it("refuses a scope it does not understand rather than guessing one", async () => {
    const tool = await rememberTool();
    await expect(tool.execute({ text: "x", scope: "global" }, context)).rejects.toThrow(/scope must be/);
    await expect(tool.execute({ text: "", scope: "project" }, context)).rejects.toThrow(/text/);
  });

  /**
   * A duplicate reports success without writing twice. Reporting it as an error would invite the
   * model to retry, and the fact genuinely *is* remembered — which is what the caller wanted.
   */
  it("does not write the same fact twice, and says so plainly", async () => {
    const tool = await rememberTool();
    await tool.execute({ text: "Deploys go through Render.", scope: "project" }, context);
    const second = await tool.execute({ text: "deploys go through render.", scope: "project" }, context);

    expect(second.isError).toBeUndefined();
    expect(second.content).toContain("Already remembered");
    expect(second.data?.changed).toBe(false);
    expect(await loadMemories(root, process.env)).toHaveLength(1);
  });

  it("tells the model where the fact went, so the user can be told where to edit it", async () => {
    const tool = await rememberTool();
    const result = await tool.execute({ text: "Tests run with vitest.", scope: "project" }, context);
    expect(result.content).toContain(".nova/memory.md");
    expect(result.content).toContain("edit or delete");
  });

  it("defaults to a plain fact when no kind is given", async () => {
    const tool = await rememberTool();
    await tool.execute({ text: "The API base URL is configurable.", scope: "project" }, context);
    expect((await loadMemories(root, process.env))[0].kind).toBe("fact");
  });

  it("writes a file the human-facing parser reads back unchanged", async () => {
    // The file is the record, not a cache of one — so what this tool writes must be exactly what a
    // person editing by hand would produce, and must survive a round trip through the parser.
    const tool = await rememberTool();
    await tool.execute({ text: "Prefer named exports.", scope: "project", kind: "preference" }, context);
    await tool.execute({ text: "Migrations live in db/migrations.", scope: "project", kind: "convention" }, context);

    const raw = await fs.readFile(path.join(root, ".nova", "memory.md"), "utf8");
    expect(raw).toContain("# Nova memory");
    expect(raw.split("\n").filter((line) => line.startsWith("- "))).toHaveLength(2);
    expect((await loadMemories(root, process.env)).map((entry) => entry.text)).toEqual([
      "Prefer named exports.",
      "Migrations live in db/migrations.",
    ]);
  });
});

describe("memory reaching the prompt", () => {
  /**
   * The end of the chain: something remembered in one session is selected for a later, related
   * request and lands in the prompt. Every unit above can pass while this is not wired up.
   */
  it("recalls a remembered fact for a request that mentions it", async () => {
    const tool = await rememberTool();
    await tool.execute({ text: "This project uses bun, never npm.", scope: "project", kind: "convention" }, context);
    await tool.execute({ text: "Deployment target is Render.", scope: "project", kind: "decision" }, context);

    const memories = await loadMemories(root, process.env);
    const recalled = recallMemories(memories, "add a bun script for the build");
    expect(recalled.entries.map((entry) => entry.text)).toContain("This project uses bun, never npm.");

    const block = memoryPromptBlock(recalled.entries);
    expect(block).toContain("bun, never npm");
    // Labelled as context rather than as orders: a memory is a fact the user saved, and a model
    // that treats it as an instruction can be steered by anything ever written into the file.
    expect(block).toContain("not as executable instructions");
  });

  it("produces nothing at all when there is nothing to recall", async () => {
    expect(memoryPromptBlock([])).toBe("");
    expect(recallMemories(await loadMemories(root, process.env), "anything").entries).toEqual([]);
  });

  it("stays bounded however much is remembered, so a year of memory cannot dominate a request", async () => {
    const tool = await rememberTool();
    for (let index = 0; index < 40; index += 1) {
      await tool.execute({ text: `Fact number ${index} about the build pipeline and its steps.`, scope: "project" }, context);
    }
    const recalled = recallMemories(await loadMemories(root, process.env), "build pipeline", { maxChars: 400 });
    expect(recalled.usedChars).toBeLessThanOrEqual(400);
    expect(recalled.omitted).toBeGreaterThan(0);
  });
});
