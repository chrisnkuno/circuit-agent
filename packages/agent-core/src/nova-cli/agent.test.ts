import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  it("surfaces a subdirectory's own instructions the moment a real turn reaches it", async () => {
    // End to end, not just at the tool layer: the static system prompt built at the start of this
    // turn only knows about NOVA.md at the root (seeded in beforeEach) — src/api/AGENTS.md is
    // below the root collectProjectContext walks, so the only way its text reaches the model at
    // all is through the dynamic path this test is checking.
    await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "api", "AGENTS.md"), "Use snake_case for API field names.");
    await fs.writeFile(path.join(root, "src", "api", "handler.ts"), "export const userId = 1;");

    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "src/api/handler.ts" } }] },
      { finishReason: "stop", content: "Read it." },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    await agent.send("what's in the api handler?");

    // The tool result the model actually saw for that read_file call carries the nested
    // instructions — this is the message the second model turn was generated against.
    const toolResult = model.requests.at(-1)?.messages.find((message) => message.role === "tool" && message.name === "read_file");
    expect(toolResult?.content).toContain("Use snake_case for API field names.");
  });

  it("discovers a project-declared skill and actually runs it when the model calls it, end to end", async () => {
    // Not just at the tool layer: the skill must be discovered from .nova/skills, offered to the
    // model as a real tool, and its command actually executed through the workspace when called —
    // the same "the wiring, not the unit" bar `agent.ts`'s nested-instructions test above sets.
    await fs.mkdir(path.join(root, ".nova/skills/greet"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".nova/skills/greet/skill.json"),
      JSON.stringify({
        name: "greet",
        description: "Greets someone by name.",
        command: "printf 'hello %s' {{name}}",
        inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false },
      }),
    );
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "greet", arguments: { name: "world" } }] },
      { finishReason: "stop", content: "Greeted them." },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    const result = await agent.send("greet the world");
    expect(result.status).toBe("completed");
    const toolResult = model.requests.at(-1)?.messages.find((message) => message.role === "tool" && message.name === "greet");
    expect(toolResult?.content).toContain("hello world");
  });

  it("blocks a skill's own execution the same way it blocks a built-in tool when a pre-tool-use hook denies it", async () => {
    await fs.mkdir(path.join(root, ".nova/hooks/pre-tool-use"), { recursive: true });
    if (process.platform === "win32") {
      await fs.writeFile(path.join(root, ".nova/hooks/pre-tool-use/deny.cmd"), "@echo off\r\necho not today 1>&2\r\nexit /b 1\r\n");
    } else {
      await fs.writeFile(path.join(root, ".nova/hooks/pre-tool-use/deny.sh"), "#!/bin/sh\necho 'not today' >&2\nexit 1\n", { mode: 0o755 });
    }
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "app.ts" } }] },
      { finishReason: "stop", content: "Could not read it." },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    await agent.send("read app.ts");
    const toolResult = model.requests.at(-1)?.messages.find((message) => message.role === "tool" && message.name === "read_file");
    expect(toolResult?.content).toContain("not today");
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

  it("indexes the security playbooks in defender mode, and offers the write/terminal/playbook tools", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "No critical findings." }]);
    const agent = new NovaAgent({ root, model, prices, mode: "defender", approve: async () => "deny" });
    await agent.send("review this project for security issues");

    const system = model.requests[0].messages.find((message) => message.role === "system");
    expect(system?.content).toContain("DEFENDER mode");
    // The playbook index rather than 44,000 characters of playbook, with the tool that fetches one.
    expect(system?.content).toContain("injection");
    expect(system?.content).toContain("secrets-credential-hygiene");
    const tools = model.requests[0].tools.map((tool) => tool.name);
    expect(tools).toContain("write_file");
    expect(tools).toContain("run_command");
    expect(tools).toContain("read_playbook");
  });

  it("runs delegate_task as a real bounded sub-agent, and folds its cost into the turn total", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "delegate_task", arguments: { task: "count the exported symbols in app.ts" } }] },
      // The sub-agent's own single turn, driven by the same shared model.
      { finishReason: "stop", content: "app.ts exports one symbol: port." },
      { finishReason: "stop", content: "The sub-agent found one export." },
    ]);
    const agent = new NovaAgent({ root, model, prices, mode: "build", approve: async () => "allow" });

    const result = await agent.send("figure out how many symbols app.ts exports");
    expect(result.status).toBe("completed");
    expect(result.summary).toBe("The sub-agent found one export.");
    // Three model calls total: the parent's tool-call turn, the sub-agent's turn, the parent's
    // final turn — proving the sub-agent actually ran through the same provider, not a stub.
    expect(model.requests).toHaveLength(3);
    // Combined usage/cost includes what the sub-agent spent, not only the parent's own two turns.
    expect(result.usage.totalTokens).toBeGreaterThan(0);
  });

  it("never offers delegate_task to the sub-agent it creates, so delegation cannot recurse", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "delegate_task", arguments: { task: "investigate something" } }] },
      { finishReason: "stop", content: "sub-agent report" },
      { finishReason: "stop", content: "done" },
    ]);
    const agent = new NovaAgent({ root, model, prices, mode: "build", approve: async () => "allow" });
    await agent.send("delegate something");

    const subAgentRequest = model.requests[1];
    expect(subAgentRequest.tools.map((tool) => tool.name)).not.toContain("delegate_task");
  });

  it("gates an effectful call inside the sub-agent through the same approval callback as the top level", async () => {
    const approvals: string[] = [];
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "delegate_task", arguments: { task: "write a file" } }] },
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c2", name: "write_file", arguments: { path: "from-subagent.ts", content: "x" } }] },
      { finishReason: "stop", content: "wrote the file" },
      { finishReason: "stop", content: "done" },
    ]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async (request) => { approvals.push(request.tool.name); return "allow"; },
      git: async () => ({ exitCode: 1, stdout: "", stderr: "" }),
    });

    await agent.send("delegate a file write");
    expect(approvals).toContain("write_file");
    expect(await fs.readFile(path.join(root, "from-subagent.ts"), "utf8")).toBe("x");
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

  describe("restore scope", () => {
    // "make a change" is turn 1, run against an empty transcript (messages.length === 0 when the
    // checkpoint was captured) — so a conversation restore should cut the transcript back to
    // nothing, and a code restore should leave whatever "make a change" produced untouched.
    function checkpointedAgent() {
      const gitCalls: string[][] = [];
      const model = scriptedModel([{ finishReason: "stop", content: "Changed it." }]);
      const agent = new NovaAgent({
        root, model, prices, mode: "build",
        approve: async () => "allow",
        git: async (args) => {
          gitCalls.push(args);
          return { exitCode: 0, stdout: args[0] === "write-tree" ? "tree_abc\n" : "", stderr: "" };
        },
      });
      return { agent, model, gitCalls };
    }

    it("code scope reverts files and leaves the conversation exactly as it was", async () => {
      const { agent, model, gitCalls } = checkpointedAgent();
      await agent.send("make a change");
      gitCalls.length = 0;

      const reverted = await agent.undo("code");
      expect(reverted?.tree).toBe("tree_abc");
      expect(gitCalls).toEqual([["add", "--all", "--", ".", ":(exclude).nova"], ["read-tree", "-u", "--reset", "tree_abc"]]);

      // The transcript is untouched: a second turn still carries "make a change" and its answer as
      // history, proving this is a real property of the conversation the model receives, not just
      // an internal field nobody reads back.
      await agent.send("what did you just do?");
      const secondRequest = model.requests.at(-1)!;
      expect(secondRequest.messages.some((message) => message.content === "make a change")).toBe(true);
    });

    it("conversation scope truncates the transcript and never touches git at all", async () => {
      const { agent, model, gitCalls } = checkpointedAgent();
      await agent.send("make a change");
      gitCalls.length = 0;

      const reverted = await agent.undo("conversation");
      expect(reverted?.tree).toBe("tree_abc"); // still names which checkpoint was undone
      expect(gitCalls).toEqual([]); // no restore() call — code scope alone owns read-tree

      await agent.send("what did you just do?");
      const secondRequest = model.requests.at(-1)!;
      // "make a change" is gone from history: the conversation genuinely restarted from before it.
      expect(secondRequest.messages.some((message) => message.content === "make a change")).toBe(false);
    });

    it("conversation scope persists the truncated transcript immediately, not on the next turn", async () => {
      const { agent } = checkpointedAgent();
      await agent.send("make a change");
      await agent.undo("conversation");

      // Nobody has to send another turn for the file on disk to reflect the undo — closing Nova
      // right after `/undo conversation` must not leave the untruncated transcript behind.
      const onDisk = await loadSession(root, agent.sessionId);
      expect(onDisk?.messages).toEqual([]);
    });

    it("both (the default) reverts files and truncates the conversation together", async () => {
      const { agent, model, gitCalls } = checkpointedAgent();
      await agent.send("make a change");
      gitCalls.length = 0;

      const reverted = await agent.undo();
      expect(reverted?.tree).toBe("tree_abc");
      expect(gitCalls.some((call) => call[0] === "read-tree")).toBe(true);

      await agent.send("what did you just do?");
      expect(model.requests.at(-1)!.messages.some((message) => message.content === "make a change")).toBe(false);
    });

    it("returns undefined for any scope when there is nothing to undo", async () => {
      const { agent } = checkpointedAgent();
      expect(await agent.undo("code")).toBeUndefined();
      expect(await agent.undo("conversation")).toBeUndefined();
      expect(await agent.undo("both")).toBeUndefined();
    });
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

  it("scans for secrets directly, worst severity first, without spending a model turn", async () => {
    await fs.writeFile(path.join(root, "config.ts"), 'const token = "abcdefghij1234567890";\nconst key = "AKIAABCDEFGHIJKLMNOP";\n');
    const model = scriptedModel([]);
    const agent = new NovaAgent({ root, model, prices, mode: "plan", approve: async () => "deny" });

    const findings = await agent.scanSecrets();
    expect(findings.map((finding) => finding.severity)).toEqual(["critical", "medium"]);
    expect(findings[0]).toMatchObject({ path: "config.ts", kind: "AWS access key" });
    expect(model.requests).toHaveLength(0); // no model call was made
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

  it("relinquishes a replaced front end without destroying its shared workspace", async () => {
    const workspace = new LocalWorkspace(root);
    const dispose = vi.spyOn(workspace, "dispose");
    const agent = new NovaAgent({ root, model: scriptedModel([]), prices, mode: "build", approve: async () => "allow", workspace });
    await agent.relinquish();
    expect(dispose).not.toHaveBeenCalled();
    await agent.dispose();
    expect(dispose).toHaveBeenCalledOnce();
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

describe("the budgets a session runs with", () => {
  /** A provider that reports what its model can do, like the real ones now do. */
  function providerWith(capabilities: { contextWindow: number; maxOutputTokens: number; supportsEffort: boolean } | undefined) {
    return {
      capabilities,
      async complete() {
        return { responseId: "r", model: "m", finishReason: "stop" as const, content: "done", toolCalls: [], usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, reasoningTokens: 0 } };
      },
    };
  }

  it("takes the model's real window instead of the 200K floor", async () => {
    const agent = new NovaAgent({ root, model: providerWith({ contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true }) as never, prices, mode: "build", approve: async () => "allow" });
    // Exposed through the same accessor the runtime reads, so this asserts what a turn actually uses.
    expect(agent.budgetSnapshot.contextLimit).toBe(1_000_000);
    // Capped well below the model's own ceiling: the output budget is reserved out of the context
    // budget, so asking for all 128K would permanently spend an eighth of the window.
    expect(agent.budgetSnapshot.maxOutputTokens).toBe(64_000);
    await agent.dispose();
  });

  it("never asks a small model for more than it can write", async () => {
    const agent = new NovaAgent({ root, model: providerWith({ contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false }) as never, prices, mode: "build", approve: async () => "allow" });
    expect(agent.budgetSnapshot).toMatchObject({ contextLimit: 200_000, maxOutputTokens: 16_000 });
    await agent.dispose();
  });

  it("falls back to the conservative default for a provider that cannot say", async () => {
    const agent = new NovaAgent({ root, model: providerWith(undefined) as never, prices, mode: "build", approve: async () => "allow" });
    expect(agent.budgetSnapshot).toMatchObject({
      contextLimit: 200_000,
      maxOutputTokens: 16_000,
      maxIterations: 100,
      maxToolCalls: 500,
      maxToolCallsPerTurn: 16,
    });
    await agent.dispose();
  });

  it("lets an explicit caller budget win over the model's own figures", async () => {
    const agent = new NovaAgent({
      root,
      model: providerWith({ contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true }) as never,
      prices,
      mode: "build",
      approve: async () => "allow",
      budgets: { contextLimit: 50_000, maxOutputTokens: 4_000 },
    });
    expect(agent.budgetSnapshot).toMatchObject({ contextLimit: 50_000, maxOutputTokens: 4_000 });
    await agent.dispose();
  });
});

describe("the cached prompt prefix", () => {
  it("stays byte-identical across turns while recalled memory rides with the objective", async () => {
    // Prompt caching is a strict prefix match over tools → system → messages. Memory is selected by
    // overlap with *this turn's* objective, so putting it in the system block re-wrote the prefix
    // every turn and invalidated the cache for the whole transcript beneath it.
    await fs.mkdir(path.join(root, ".nova"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".nova", "memory.md"),
      "- the deployment pipeline runs on netlify\n- the database migrations live in convex\n",
    );
    const model = scriptedModel([{ content: "First." }, { content: "Second." }]);
    const agent = new NovaAgent({
      root, model, prices, mode: "build",
      approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });

    await agent.send("tell me about the netlify deployment pipeline");
    await agent.send("tell me about the convex database migrations");

    const systemOf = (request: (typeof model.requests)[number]) =>
      request.messages.find((message) => message.role === "system")?.content ?? "";
    expect(systemOf(model.requests[0])).toBe(systemOf(model.requests[1]));
    expect(systemOf(model.requests[0])).not.toMatch(/durable memory/i);

    // The memory still reaches the model — attached to the turn that asked for it.
    const userMessages = model.requests[1].messages.filter((message) => message.role === "user").map((message) => message.content);
    expect(userMessages.join("\n")).toMatch(/durable memory/i);
    await agent.dispose();
  });

  it("sends a recalled fact once per thread, including after resume", async () => {
    await fs.mkdir(path.join(root, ".nova"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova", "memory.md"), "- the deployment pipeline runs on netlify\n");
    const firstModel = scriptedModel([{ content: "First." }, { content: "Second." }]);
    const first = new NovaAgent({
      root, model: firstModel, prices, mode: "build", approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });

    await first.send("check the netlify deployment pipeline");
    await first.send("check the netlify deployment pipeline again");
    const headers = firstModel.requests[1].messages
      .filter((message) => message.role === "user")
      .reduce((count, message) => count + (message.content.match(/Relevant durable memory/g)?.length ?? 0), 0);
    expect(headers).toBe(1);

    const record = await loadSession(root, first.sessionId);
    expect(record?.recalledMemoryKeys).toHaveLength(1);
    await first.dispose();

    const resumedModel = scriptedModel([{ content: "Third." }]);
    const resumed = new NovaAgent({
      root, model: resumedModel, prices, mode: "build", approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    resumed.resume(record!);
    await resumed.send("check the netlify deployment pipeline once more");
    const resumedHeaders = resumedModel.requests[0].messages
      .filter((message) => message.role === "user")
      .reduce((count, message) => count + (message.content.match(/Relevant durable memory/g)?.length ?? 0), 0);
    expect(resumedHeaders).toBe(1);
    await resumed.dispose();
  });
});

describe("tool-result allowances", () => {
  it("scale with the window, and reproduce the old fixed numbers at a 200K one", async () => {
    const small = new NovaAgent({
      root,
      model: { capabilities: { contextWindow: 200_000, maxOutputTokens: 16_000, supportsEffort: false }, async complete() { throw new Error("unused"); } } as never,
      prices, mode: "build", approve: async () => "allow",
    });
    expect(small.budgetSnapshot.maxToolResultChars).toBe(40_000);
    expect(small.budgetSnapshot.maxTotalToolResultChars).toBe(400_000);
    await small.dispose();

    const large = new NovaAgent({
      root,
      model: { capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true }, async complete() { throw new Error("unused"); } } as never,
      prices, mode: "build", approve: async () => "allow",
    });
    // A bigger model must not read less of a file than a smaller one, which a fixed cap guaranteed.
    expect(large.budgetSnapshot.maxToolResultChars).toBe(200_000);
    expect(large.budgetSnapshot.maxTotalToolResultChars).toBe(2_000_000);
    await large.dispose();
  });

  it("actually runs a turn on a 1M-context model, budgets and all", async () => {
    // The budgets travel into the runtime, which validates them. Asserting the numbers without
    // executing a turn missed exactly that: the runtime's own ceiling rejected the figures a 1M
    // model derives, so the session died on its first request with a bounds error.
    const model = scriptedModel([{ content: "Done." }]);
    const agent = new NovaAgent({
      root,
      model: Object.assign(model, { capabilities: { contextWindow: 1_000_000, maxOutputTokens: 128_000, supportsEffort: true } }),
      prices, mode: "build", approve: async () => "allow",
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    const result = await agent.send("say hello");
    expect(result.status).not.toBe("failed");
    expect(model.requests[0].maxOutputTokens).toBeGreaterThan(16_000);
    await agent.dispose();
  });
});
