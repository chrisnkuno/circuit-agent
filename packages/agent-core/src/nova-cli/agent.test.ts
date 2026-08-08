import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { NovaAgent, type NovaEvent } from "./agent";
import { LocalWorkspace } from "./backends";
import { loadSession } from "./session";

let root: string;
const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

/** A model whose turns are scripted, so the loop is tested rather than a provider. */
function scriptedModel(turns: Array<Partial<AgentModelTurn>>): AgentTurnProvider & { requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return {
        responseId: `resp_${index}`,
        model: "nova-test",
        finishReason: "stop",
        content: "Done.",
        toolCalls: [],
        usage,
        ...turn,
      } as AgentModelTurn;
    },
  };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-agent-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");
  await fs.writeFile(path.join(root, "NOVA.md"), "Always use tabs.\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("NovaAgent", () => {
  it("runs a read-edit-verify loop and returns the model's summary", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "app.ts" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c2", name: "edit_file", arguments: { path: "app.ts", oldText: "3000", newText: "8080" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c3", name: "run_command", arguments: { command: "npm test" } }] },
      { finishReason: "stop", content: "Changed the port to 8080." },
    ]);
    const events: NovaEvent[] = [];
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 0, stdout: "3 passed", stderr: "" })),
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
      onEvent: (event) => events.push(event),
    });

    const result = await agent.send("change the port to 8080");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("Changed the port to 8080.");
    expect(await fs.readFile(path.join(root, "app.ts"), "utf8")).toContain("8080");

    const toolEvents = events.filter((event) => event.type === "runtime" && event.event.type === "tool_result");
    expect(toolEvents).toHaveLength(3);
  });

  it("refuses to call an unverified edit complete", async () => {
    // Inherited from the hosted runtime and worth keeping honest here: changing the workspace and
    // then declaring success without running anything is the single most common way an agent lies.
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: { path: "app.ts", oldText: "3000", newText: "8080" } }] },
      { finishReason: "stop", content: "All done, everything works." },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });

    const result = await agent.send("change the port");
    expect(result.status).toBe("needs_verification");
    expect(result.summary).toContain("without passing verification");
  });

  it("puts the project's own instructions into the system prompt", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "Understood." }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "deny" });
    await agent.send("what does this project do?");

    const system = model.requests[0].messages.find((message) => message.role === "system");
    expect(system?.content).toContain("Always use tabs.");
    expect(system?.content).toContain("NOVA.md");
  });

  it("does not offer write or command tools in plan mode", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "Here is the plan." }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "deny" });
    await agent.send("plan the change");

    const offered = model.requests[0].tools.map((tool) => tool.name);
    expect(offered).toContain("read_file");
    expect(offered).toContain("grep_files");
    expect(offered).not.toContain("write_file");
    expect(offered).not.toContain("edit_file");
    expect(offered).not.toContain("run_command");
  });

  it("stops when the user denies a call rather than proceeding anyway", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "write_file", arguments: { path: "new.ts", content: "x" } }] },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "deny",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });

    const result = await agent.send("create a file");
    expect(result.status).toBe("needs_approval");
    await expect(fs.readFile(path.join(root, "new.ts"), "utf8")).rejects.toThrow();
  });

  it("persists the session so a later run can resume the thread", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "All set." }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "allow" });
    await agent.send("summarise the project");

    const saved = await loadSession(root, agent.sessionId);
    expect(saved?.title).toBe("summarise the project");
    expect(saved?.messages.length).toBeGreaterThan(0);

    const second = scriptedModel([{ finishReason: "stop", content: "Continuing." }]);
    const resumed = new NovaAgent({ root, model: second, prices, mode: "plan", approve: async () => "allow" });
    resumed.resume(saved!);
    await resumed.send("now do the same for the tests");
    // The follow-up must carry the earlier exchange, or "the same" means nothing.
    expect(second.requests[0].messages.at(-1)?.content).toContain("Earlier in this session");
  });

  it("takes a checkpoint before a build turn and can revert to it", async () => {
    const gitCalls: string[][] = [];
    const model = scriptedModel([{ finishReason: "stop", content: "Done." }]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async (args) => {
        gitCalls.push(args);
        return { exitCode: 0, stdout: args[0] === "write-tree" ? "tree_abc\n" : "", stderr: "" };
      },
    });

    const result = await agent.send("make a change");
    expect(result.checkpoint?.tree).toBe("tree_abc");

    const reverted = await agent.undo();
    expect(reverted?.tree).toBe("tree_abc");
    expect(gitCalls.at(-1)).toEqual(["read-tree", "-u", "--reset", "tree_abc"]);
  });

  it("takes no checkpoint in plan mode, where nothing can change", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "Plan ready." }]);
    let gitCalled = false;
    const agent = new NovaAgent({
      root, model, prices, mode: "plan",
      approve: async () => "allow",
      git: async () => { gitCalled = true; return { exitCode: 0, stdout: "", stderr: "" }; },
    });

    const result = await agent.send("plan it");
    expect(result.checkpoint).toBeUndefined();
    expect(gitCalled).toBe(false);
  });

  it("refuses to spend past its own budget ceiling", async () => {
    const model = scriptedModel([{
      finishReason: "stop",
      content: "Done.",
      usage: { inputTokens: 10_000_000, outputTokens: 10_000_000, totalTokens: 20_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "allow", budgets: { maxRwf: 10 } });
    await expect(agent.send("do something expensive")).rejects.toThrow(/exceeds the reserved model budget/);
  });
});
