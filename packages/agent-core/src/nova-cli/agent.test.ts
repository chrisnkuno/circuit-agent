import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { NovaAgent, type NovaEvent } from "./agent";
import { LocalWorkspace } from "./backends";
import { readEventJournal } from "./protocol";
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
    expect(result.status).toBe("blocked");
    await expect(fs.readFile(path.join(root, "new.ts"), "utf8")).rejects.toThrow();
    const events = await readEventJournal(root, agent.sessionId);
    expect(events.filter((event) => event.payload.type === "turn_status").map((event) => event.payload)).toMatchObject([
      { from: "queued", to: "running" },
      { from: "running", to: "waiting_approval" },
      { from: "waiting_approval", to: "blocked" },
    ]);
    expect(events.some((event) => event.payload.type === "approval_requested" && event.payload.request.actionDigest.length === 64)).toBe(true);
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
    // The follow-up must carry native earlier messages, not a lossy rendered transcript.
    expect(second.requests[0].messages.some((message) => message.role === "assistant" && message.content === "All set.")).toBe(true);
    expect(second.requests[0].messages.at(-1)).toEqual({ role: "user", content: "now do the same for the tests" });
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

  it("summarizes the transcript once it approaches the context limit, and carries the summary forward", async () => {
    const readCall = (id: string) => ({ finishReason: "tool_calls" as const, content: "", toolCalls: [{ id, name: "read_file", arguments: { path: "app.ts" } }] });
    const model = scriptedModel([
      readCall("c1"), readCall("c2"), readCall("c3"), readCall("c4"), readCall("c5"), readCall("c6"),
      { finishReason: "stop", content: "Turn 1 complete." }, // ends turn 1
      { finishReason: "stop", content: "Summary of turn 1." }, // consumed by compaction's own summarizer call
      { finishReason: "stop", content: "Turn 2 complete." }, // turn 2's real response
    ]);
    const events: NovaEvent[] = [];
    const agent = new NovaAgent({
      root, model, prices, mode: "plan",
      approve: async () => "allow",
      // A tiny context limit and the default keepRecent(6) guarantee the six-tool-call transcript
      // from turn 1 crosses the compaction threshold by the time turn 2 starts. maxOutputTokens
      // stays at the runtime's own floor (256) — the runtime validates it independently of budget.
      budgets: { contextLimit: 300, maxOutputTokens: 256 },
      onEvent: (event) => events.push(event),
    });

    const firstResult = await agent.send("read the file six times over");
    const messagesBeforeTurn2 = model.requests.length;
    const secondResult = await agent.send("now do something else");

    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction).toBeDefined();
    // The compaction's own summarizer call is a real extra request the scripted queue had to serve.
    expect(model.requests.length).toBeGreaterThan(messagesBeforeTurn2 + 1);
    // Turn 2's request must see the summary, not the raw six-tool-call transcript it replaced.
    const turn2System = model.requests.at(-1)?.messages.map((message) => message.content).join("\n");
    expect(turn2System).toContain("Summary of turn 1.");
    // The summarizer is a paid model call, not invisible overhead.
    expect(secondResult.usage.totalTokens).toBe(usage.totalTokens * 2);
    expect((await loadSession(root, agent.sessionId))?.totalRwf).toBe(firstResult.actualModelRwf + secondResult.actualModelRwf);
  });

  it("exposes the plan and workspace diff for the TUI's /todos and /diff commands", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "todo_write", arguments: { items: ["read the config"] } }] },
      { finishReason: "stop", content: "Noted the plan." },
    ]);
    const gitCalls: string[][] = [];
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async (args) => {
        gitCalls.push(args);
        if (args[0] === "write-tree") return { exitCode: 0, stdout: "tree_abc\n", stderr: "" };
        if (args[0] === "diff") return { exitCode: 0, stdout: " app.ts | 2 +-\n", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });

    expect(agent.todos).toEqual([]); // nothing recorded before the first turn
    await agent.send("record a plan");
    expect(agent.todos).toEqual([{ id: 1, text: "read the config", status: "pending" }]);

    expect(await agent.diffStat()).toBe("app.ts | 2 +-");
    expect(gitCalls.some((args) => args[0] === "diff")).toBe(true);
  });

  it("lists every checkpoint taken so far, and disposes the workspace on request", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "Done." }, { finishReason: "stop", content: "Done again." }]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async (args) => ({ exitCode: 0, stdout: args[0] === "write-tree" ? `tree_${model.requests.length}\n` : "", stderr: "" }),
    });

    await agent.send("first change");
    await agent.send("second change");
    expect(agent.listCheckpoints().map((checkpoint) => checkpoint.tree)).toEqual(["tree_0", "tree_1"]);

    await expect(agent.dispose()).resolves.toBeUndefined(); // LocalWorkspace.dispose() is a no-op.
  });

  it("reports no diff before any checkpoint exists", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "Nothing to do yet." }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "allow" });
    expect(await agent.diffStat()).toBe("");
  });

  it("refuses to spend past its own budget ceiling", async () => {
    const model = scriptedModel([{
      finishReason: "stop",
      content: "Done.",
      usage: { inputTokens: 10_000_000, outputTokens: 10_000_000, totalTokens: 20_000_000, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
    }]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "allow", budgets: { maxRwf: 10 } });
    const result = await agent.send("do something expensive");
    expect(result).toMatchObject({ status: "iteration_limit", actualModelRwf: 0, iterations: 0 });
    expect(result.summary).toContain("approved model budget");
    expect(model.requests).toHaveLength(0);
  });
});
