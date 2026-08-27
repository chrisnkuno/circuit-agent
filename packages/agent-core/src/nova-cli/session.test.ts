import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "../agent-runtime";
import { CheckpointStore, runGit, type GitRunner } from "./checkpoints";
import {
  atSafeBoundary,
  buildCompactedMessages,
  COMPACTION_INSTRUCTION,
  compactionUrgency,
  estimateMessageTokens,
  listSessions,
  loadSession,
  newSessionId,
  planCompaction,
  STANDING_CONSTRAINTS_HEADING,
  standingConstraintsBlock,
  saveSession,
  titleFromObjective,
  type SessionRecord,
} from "./session";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-session-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schemaVersion: 2,
    revision: 0,
    id: newSessionId(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    root,
    title: "Add a health check",
    messages: [{ role: "user", content: "add a health check" }],
    approvals: { edit_file: "allow" },
    totalRwf: 12,
    ...overrides,
  };
}

describe("session storage", () => {
  it("round-trips a session, including its standing approvals", async () => {
    const saved = record({ mode: "plan" });
    await saveSession(saved);
    const loaded = await loadSession(root, saved.id);
    expect(loaded?.title).toBe("Add a health check");
    expect(loaded?.approvals).toEqual({ edit_file: "allow" });
    expect(loaded?.totalRwf).toBe(12);
    expect(loaded?.mode).toBe("plan");
    expect(loaded?.revision).toBe(1);
    expect(loaded?.integrity).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resumes through a different OS alias for the same physical workspace", async () => {
    const alias = `${root}-alias`;
    try {
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Some locked-down Windows environments do not permit links.
    }
    try {
      const saved = record({ root: alias });
      await saveSession(saved);
      expect((await loadSession(root, saved.id))?.title).toBe("Add a health check");
    } finally {
      await fs.unlink(alias).catch(() => undefined);
    }
  });

  it("writes atomically and rejects a stale writer instead of losing a newer turn", async () => {
    const first = record({ id: "shared" });
    await saveSession(first);
    const stale = { ...first, revision: 0 };
    first.title = "newer state";
    await saveSession(first);

    await expect(saveSession(stale)).rejects.toThrow(/revision conflict/);
    expect((await loadSession(root, "shared"))?.title).toBe("newer state");
    expect((await fs.readdir(path.join(root, ".nova", "sessions"))).some((file) => file.endsWith(".tmp"))).toBe(false);
  });

  it("fails closed when a saved session is tampered with", async () => {
    const saved = record({ id: "tampered" });
    const file = await saveSession(saved);
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as SessionRecord;
    raw.totalRwf += 1;
    await fs.writeFile(file, JSON.stringify(raw));
    expect(await loadSession(root, "tampered")).toBeNull();
    await expect(saveSession(saved)).rejects.toThrow(/refusing to overwrite/);
  });

  it("rejects path traversal in session ids", async () => {
    await expect(loadSession(root, "../outside")).resolves.toBeNull();
    await expect(saveSession(record({ id: "../outside" }))).rejects.toThrow(/unsafe/);
  });

  it("lists sessions newest first and survives a corrupt file", async () => {
    await saveSession(record({ id: "older", title: "First", updatedAt: 1 }));
    await saveSession(record({ id: "newer", title: "Second", updatedAt: 2 }));
    await fs.writeFile(path.join(root, ".nova", "sessions", "broken.json"), "{ not json");

    const sessions = await listSessions(root);
    expect(sessions.map((session) => session.title)).toEqual(["Second", "First"]);
  });

  it("returns null for an unknown session instead of throwing", async () => {
    expect(await loadSession(root, "missing")).toBeNull();
    expect(await listSessions(path.join(root, "nowhere"))).toEqual([]);
  });

  it("titles a session by its opening request", () => {
    expect(titleFromObjective("add a health check\nwith tests")).toBe("add a health check");
    expect(titleFromObjective("   ")).toBe("Untitled session");
  });
});

describe("context compaction", () => {
  const long = (label: string) => ({ role: "assistant" as const, content: `${label} ${"word ".repeat(2_000)}` });

  it("does nothing while the conversation fits", () => {
    const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
    expect(planCompaction(messages, { contextLimit: 200_000, outputBudget: 8_000 })).toBeNull();
  });

  it("counts large tool-call arguments even when the assistant text is empty", () => {
    const plain = estimateMessageTokens([{ role: "assistant", content: "" }]);
    const structured = estimateMessageTokens([{
      role: "assistant",
      content: "",
      toolCalls: [{ id: "write_1", name: "write_file", arguments: { path: "large.ts", content: "x".repeat(40_000) } }],
    }]);
    expect(structured - plain).toBeGreaterThan(10_000);
  });

  it("keeps the system prompt and the original request, and summarizes the middle", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "the original request" },
      ...Array.from({ length: 20 }, (_, index) => long(`turn${index}`)),
    ];
    const plan = planCompaction(messages, { contextLimit: 10_000, outputBudget: 1_000, keepRecent: 4 });
    expect(plan).not.toBeNull();
    expect(plan!.toSummarize[0]).toEqual({ role: "system", content: "sys" });
    expect(plan!.toSummarize[1]).toEqual({ role: "user", content: "the original request" });
    expect(plan!.toKeep).toHaveLength(4);
  });

  it("never cuts a tool result away from the call that produced it", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      ...Array.from({ length: 10 }, (_, index) => long(`turn${index}`)),
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] },
      { role: "tool", content: "file contents", toolCallId: "c1", name: "read_file" },
      { role: "tool", content: "more contents", toolCallId: "c2", name: "read_file" },
    ];
    const plan = planCompaction(messages, { contextLimit: 10_000, outputBudget: 1_000, keepRecent: 2 });
    expect(plan).not.toBeNull();
    // The kept tail must not begin with an orphaned tool result.
    expect(plan!.toKeep[0].role).not.toBe("tool");
  });

  it("rebuilds the conversation with the summary standing in for what was dropped", () => {
    const plan = {
      toSummarize: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "old" }],
      toKeep: [{ role: "user" as const, content: "recent" }],
    };
    const rebuilt = buildCompactedMessages("We added the flag and tests pass.", plan);
    expect(rebuilt[0]).toEqual({ role: "system", content: "sys" });
    expect(rebuilt[1].content).toContain("[Earlier conversation, summarized]");
    expect(rebuilt[1].content).toContain("tests pass");
    expect(rebuilt[2]).toEqual({ role: "user", content: "recent" });
  });

  it("grades pressure in three bands, and only the top one compacts mid-task", () => {
    const fits: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "hi" }];
    const budgets = { contextLimit: 10_000, outputBudget: 1_000 };
    // Grown a little at a time rather than guessed at, so the fixtures land in the intended band
    // whatever the token estimator's constants happen to be.
    const grow = (until: "advisable" | "required"): AgentMessage[] => {
      const messages: AgentMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "go" }];
      while (compactionUrgency(messages, budgets) !== until) {
        if (messages.length > 500) throw new Error(`never reached ${until}`);
        messages.push({ role: "assistant", content: `turn${messages.length} ${"word ".repeat(50)}` });
      }
      return messages;
    };
    const filling = grow("advisable");
    const full = grow("required");

    expect(compactionUrgency(fits, budgets)).toBe("none");
    expect(compactionUrgency(filling, budgets)).toBe("advisable");
    expect(compactionUrgency(full, budgets)).toBe("required");

    // Advisable is a boundary decision; required is not a decision at all.
    expect(planCompaction(filling, { ...budgets, keepRecent: 2, boundary: "mid-task" })).toBeNull();
    expect(planCompaction(filling, { ...budgets, keepRecent: 2, boundary: "safe" })).not.toBeNull();
    expect(planCompaction(full, { ...budgets, keepRecent: 2, boundary: "mid-task" })).not.toBeNull();
  });

  it("calls a concluded turn a safe boundary, and anything unfinished not one", () => {
    const concluded: AgentMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "Done." }];
    const suspended: AgentMessage[] = [{ role: "user", content: "go" }, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: {} }] }];
    const awaitingResult: AgentMessage[] = [...suspended, { role: "tool", content: "x", toolCallId: "c1", name: "read_file" }];

    expect(atSafeBoundary(concluded)).toBe(true);
    expect(atSafeBoundary(suspended)).toBe(false);
    expect(atSafeBoundary(awaitingResult)).toBe(false);
    expect(atSafeBoundary([])).toBe(false);
    // A plan the agent believes it is halfway through is mid-task wherever the turn ended.
    expect(atSafeBoundary(concluded, { workInProgress: true })).toBe(false);
  });

  it("restates the governing facts verbatim rather than leaving them to the summary", () => {
    const constraints = {
      mode: "build",
      objective: "Migrate the billing module, and never touch the production database",
      approvals: { "run_command:bun test": "allow" as const, "run_command:rm -rf /": "deny" as const },
      openTodos: ["port the invoice tests"],
    };
    const block = standingConstraintsBlock(constraints);

    expect(block.startsWith(STANDING_CONSTRAINTS_HEADING)).toBe(true);
    expect(block).toContain("Permission mode: build");
    expect(block).toContain("never touch the production database");
    expect(block).toContain("run_command:bun test");
    expect(block).toContain("run_command:rm -rf /");
    expect(block).toContain("port the invoice tests");
  });

  it("survives repeated compaction: the constraints are rebuilt from state, never from the last summary", () => {
    const constraints = {
      mode: "auto",
      objective: "Refactor the parser",
      approvals: { "write_file:src/parser.ts": "allow" as const },
      openTodos: [],
    };
    const plan = { toSummarize: [{ role: "system" as const, content: "sys" }, { role: "user" as const, content: "old" }], toKeep: [{ role: "user" as const, content: "recent" }] };

    let messages = buildCompactedMessages("first summary", plan, constraints);
    for (let round = 0; round < 5; round += 1) {
      // Each round summarizes away everything the previous round produced, which is precisely how a
      // constraint that lives only inside a summary disappears. Rebuilt from state, it cannot.
      messages = buildCompactedMessages(`summary ${round} of a transcript that mentions no rules`, { toSummarize: messages, toKeep: [] }, constraints);
      expect(messages.some((message) => message.content.includes("write_file:src/parser.ts"))).toBe(true);
      expect(messages.some((message) => message.content.includes("Permission mode: auto"))).toBe(true);
    }
    // Constraints lead: they are what the model reasons within, not one more historical detail.
    const constraintIndex = messages.findIndex((message) => message.content.startsWith(STANDING_CONSTRAINTS_HEADING));
    const summaryIndex = messages.findIndex((message) => message.content.startsWith("[Earlier conversation, summarized]"));
    expect(constraintIndex).toBeLessThan(summaryIndex);
  });

  it("asks the summarizer to reproduce standing instructions rather than condense them", () => {
    expect(COMPACTION_INSTRUCTION).toMatch(/verbatim/);
    expect(COMPACTION_INSTRUCTION).toMatch(/prohibition/);
  });
});

describe("checkpoints", () => {
  function fakeGit(script: Record<string, { exitCode: number; stdout: string }>): { git: GitRunner; calls: string[][] } {
    const calls: string[][] = [];
    const git: GitRunner = async (args) => {
      calls.push(args);
      const scripted = script[args[0]];
      return { stdout: scripted?.stdout ?? "", stderr: "", exitCode: scripted?.exitCode ?? 0 };
    };
    return { git, calls };
  }

  it("snapshots into a private index so the user's staged changes are untouched", async () => {
    const { git, calls } = fakeGit({ "write-tree": { exitCode: 0, stdout: "abc123\n" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);

    const checkpoint = await store.capture("add a flag", "turn_1", 0);
    expect(checkpoint?.tree).toBe("abc123");
    // Nova's own directory is excluded: staging it corrupts the very index git is writing.
    expect(calls[0]).toEqual(["add", "--all", "--", ".", ":(exclude).nova"]);
    expect(calls[1]).toEqual(["write-tree"]);
    expect(store.list()).toHaveLength(1);
  });

  it("stages before restoring, so files created after the snapshot are removed by the undo", async () => {
    const { git, calls } = fakeGit({ "write-tree": { exitCode: 0, stdout: "tree1\n" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    await store.capture("before", "turn_1", 0);

    expect(await store.restore("tree1")).toBe(true);
    // Without the staging call, `--reset` leaves newly created files behind and the workspace
    // lands in a state that never existed.
    expect(calls.at(-2)).toEqual(["add", "--all", "--", ".", ":(exclude).nova"]);
    expect(calls.at(-1)).toEqual(["read-tree", "-u", "--reset", "tree1"]);
  });

  it("degrades to no undo rather than failing the task when git is unavailable", async () => {
    const { git } = fakeGit({ add: { exitCode: 127, stdout: "" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    expect(await store.capture("anything", "turn_1", 0)).toBeUndefined();
    expect(store.latest()).toBeUndefined();
  });

  it("records no checkpoint when write-tree itself fails", async () => {
    const { git } = fakeGit({ "write-tree": { exitCode: 128, stdout: "" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    expect(await store.capture("anything", "turn_1", 0)).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("records no checkpoint when write-tree exits clean but names no tree", async () => {
    // An empty tree id is not a smaller checkpoint; it is not a checkpoint at all.
    const { git } = fakeGit({ "write-tree": { exitCode: 0, stdout: "\n" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    expect(await store.capture("anything", "turn_1", 0)).toBeUndefined();
  });

  it("refuses to restore when staging the current tree fails", async () => {
    const { git } = fakeGit({ "write-tree": { exitCode: 0, stdout: "tree1\n" }, add: { exitCode: 1, stdout: "" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    expect(await store.restore("tree1")).toBe(false);
  });

  it("reports no diff when git itself fails, the same as when there is nothing to compare", async () => {
    const { git } = fakeGit({ "write-tree": { exitCode: 0, stdout: "tree1\n" }, diff: { exitCode: 128, stdout: "" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    await store.capture("before", "turn_1", 0);
    expect(await store.diffStat()).toBe("");
  });
});

describe("checkpoints against a real repository", () => {
  it("detects a git repository, and reports its absence rather than failing", async () => {
    // `isAvailable` gates whether undo is offered at all, so a wrong answer either hides a working
    // feature or promises one that cannot work.
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "nova-git-"));
    try {
      const outside = new CheckpointStore(repo, path.join(repo, ".nova", "index"));
      expect(await outside.isAvailable()).toBe(false);

      await runGit(["init", "-q"], { cwd: repo });
      expect(await new CheckpointStore(repo, path.join(repo, ".nova", "index")).isAvailable()).toBe(true);
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("captures and restores real files through git plumbing", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "nova-git-"));
    try {
      await runGit(["init", "-q"], { cwd: repo });
      await runGit(["config", "core.autocrlf", "false"], { cwd: repo });
      await runGit(["config", "user.email", "nova@test"], { cwd: repo });
      await runGit(["config", "user.name", "Nova"], { cwd: repo });
      await fs.writeFile(path.join(repo, "app.ts"), "export const port = 3000;\n");
      await runGit(["add", "-A"], { cwd: repo });
      await runGit(["commit", "-qm", "init"], { cwd: repo });

      const store = new CheckpointStore(repo, path.join(repo, ".nova", "checkpoint-index"));
      const checkpoint = await store.capture("before", "turn_1", 0);
      expect(checkpoint?.tree).toMatch(/^[0-9a-f]{40}$/);

      await fs.writeFile(path.join(repo, "app.ts"), "// destroyed\n");
      await fs.writeFile(path.join(repo, "stray.ts"), "agent wrote this\n");
      await fs.mkdir(path.join(repo, ".nova"), { recursive: true });
      await fs.writeFile(path.join(repo, ".nova", "session.json"), "{}");

      const patch = await store.diffPatch();
      expect(patch).toContain("diff --git a/app.ts b/app.ts");
      expect(patch).toContain("+// destroyed");

      expect(await store.restore(checkpoint!.tree)).toBe(true);
      // Modified files revert, files the agent created are removed, and Nova's own state survives.
      expect(await fs.readFile(path.join(repo, "app.ts"), "utf8")).toBe("export const port = 3000;\n");
      expect(await fs.stat(path.join(repo, "stray.ts")).catch(() => null)).toBeNull();
      expect(await fs.readFile(path.join(repo, ".nova", "session.json"), "utf8")).toBe("{}");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });

  it("carries the turn it was captured for and the conversation length at that moment", async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), "nova-git-"));
    try {
      await runGit(["init", "-q"], { cwd: repo });
      await runGit(["config", "user.email", "nova@test"], { cwd: repo });
      await runGit(["config", "user.name", "Nova"], { cwd: repo });
      await fs.writeFile(path.join(repo, "app.ts"), "x");
      await runGit(["add", "-A"], { cwd: repo });
      await runGit(["commit", "-qm", "init"], { cwd: repo });

      const store = new CheckpointStore(repo, path.join(repo, ".nova", "checkpoint-index"));
      const checkpoint = await store.capture("before", "turn_42", 6);
      expect(checkpoint).toMatchObject({ turnId: "turn_42", messageCount: 6 });
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});

describe("what compaction keeps verbatim", () => {
  const budgets = { contextLimit: 200_000, outputBudget: 16_000 };

  /** A transcript that has grown past the point where compaction is required. */
  function transcript(tail: AgentMessage[]): AgentMessage[] {
    const bulk: AgentMessage[] = [
      { role: "system", content: "You are Nova." },
      { role: "user", content: "Fix the failing build." },
    ];
    for (let index = 0; index < 40; index += 1) {
      bulk.push({ role: "assistant", content: "x".repeat(20_000) });
      bulk.push({ role: "user", content: "keep going" });
    }
    return [...bulk, ...tail];
  }

  it("keeps fewer huge messages than small ones, because the point was always a size", () => {
    // The old rule kept six messages either way: ~60,000 tokens of test logs, or 300 tokens of
    // acknowledgements. Neither is what "leave enough recent context to continue" meant.
    const huge = planCompaction(transcript(Array.from({ length: 8 }, () => ({ role: "assistant", content: "y".repeat(60_000) } as AgentMessage))), budgets);
    const small = planCompaction(transcript(Array.from({ length: 8 }, () => ({ role: "assistant", content: "ok" } as AgentMessage))), budgets);

    expect(huge).not.toBeNull();
    expect(small).not.toBeNull();
    expect(huge!.toKeep.length).toBeLessThan(small!.toKeep.length);
  });

  it("never keeps more than its share of the usable window", () => {
    const plan = planCompaction(transcript(Array.from({ length: 8 }, () => ({ role: "assistant", content: "y".repeat(60_000) } as AgentMessage))), budgets);
    const keptTokens = estimateMessageTokens(plan!.toKeep);
    // A fifth of what is usable, with one exchange of slack for the floor below.
    expect(keptTokens).toBeLessThan((budgets.contextLimit - budgets.outputBudget) * 0.3);
  });

  it("always keeps at least one complete exchange, however large it is", () => {
    // A kept tail of nothing is a compaction the agent cannot continue from.
    const enormous = Array.from({ length: 3 }, () => ({ role: "assistant", content: "z".repeat(400_000) } as AgentMessage));
    const plan = planCompaction(transcript(enormous), budgets);
    expect(plan!.toKeep.length).toBeGreaterThanOrEqual(2);
  });

  it("still refuses to strand a tool result whose call it summarized away", () => {
    const plan = planCompaction(
      transcript([
        { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "read_file", arguments: {} }] },
        { role: "tool", content: "file contents", toolCallId: "call-1", name: "read_file" },
        { role: "assistant", content: "Done." },
      ]),
      budgets,
    );
    // If the tail begins with a tool result, its call is in the summarized half and the provider
    // rejects the request outright.
    expect(plan!.toKeep[0].role).not.toBe("tool");
  });

  it("lets an explicit keepRecent override the measurement", () => {
    const plan = planCompaction(transcript([{ role: "assistant", content: "done" }]), { ...budgets, keepRecent: 3 });
    expect(plan!.toKeep).toHaveLength(3);
  });
});
