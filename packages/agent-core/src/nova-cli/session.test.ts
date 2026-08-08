import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMessage } from "../agent-runtime";
import { CheckpointStore, runGit, type GitRunner } from "./checkpoints";
import {
  buildCompactedMessages,
  listSessions,
  loadSession,
  newSessionId,
  planCompaction,
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
    const saved = record();
    await saveSession(saved);
    const loaded = await loadSession(root, saved.id);
    expect(loaded?.title).toBe("Add a health check");
    expect(loaded?.approvals).toEqual({ edit_file: "allow" });
    expect(loaded?.totalRwf).toBe(12);
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

    const checkpoint = await store.capture("add a flag");
    expect(checkpoint?.tree).toBe("abc123");
    // Nova's own directory is excluded: staging it corrupts the very index git is writing.
    expect(calls[0]).toEqual(["add", "--all", "--", ".", ":(exclude).nova"]);
    expect(calls[1]).toEqual(["write-tree"]);
    expect(store.list()).toHaveLength(1);
  });

  it("stages before restoring, so files created after the snapshot are removed by the undo", async () => {
    const { git, calls } = fakeGit({ "write-tree": { exitCode: 0, stdout: "tree1\n" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    await store.capture("before");

    expect(await store.restore("tree1")).toBe(true);
    // Without the staging call, `--reset` leaves newly created files behind and the workspace
    // lands in a state that never existed.
    expect(calls.at(-2)).toEqual(["add", "--all", "--", ".", ":(exclude).nova"]);
    expect(calls.at(-1)).toEqual(["read-tree", "-u", "--reset", "tree1"]);
  });

  it("degrades to no undo rather than failing the task when git is unavailable", async () => {
    const { git } = fakeGit({ add: { exitCode: 127, stdout: "" } });
    const store = new CheckpointStore(root, path.join(root, ".nova", "index"), git);
    expect(await store.capture("anything")).toBeUndefined();
    expect(store.latest()).toBeUndefined();
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
      await runGit(["config", "user.email", "nova@test"], { cwd: repo });
      await runGit(["config", "user.name", "Nova"], { cwd: repo });
      await fs.writeFile(path.join(repo, "app.ts"), "export const port = 3000;\n");
      await runGit(["add", "-A"], { cwd: repo });
      await runGit(["commit", "-qm", "init"], { cwd: repo });

      const store = new CheckpointStore(repo, path.join(repo, ".nova", "checkpoint-index"));
      const checkpoint = await store.capture("before");
      expect(checkpoint?.tree).toMatch(/^[0-9a-f]{40}$/);

      await fs.writeFile(path.join(repo, "app.ts"), "// destroyed\n");
      await fs.writeFile(path.join(repo, "stray.ts"), "agent wrote this\n");
      await fs.mkdir(path.join(repo, ".nova"), { recursive: true });
      await fs.writeFile(path.join(repo, ".nova", "session.json"), "{}");

      expect(await store.restore(checkpoint!.tree)).toBe(true);
      // Modified files revert, files the agent created are removed, and Nova's own state survives.
      expect(await fs.readFile(path.join(repo, "app.ts"), "utf8")).toBe("export const port = 3000;\n");
      expect(await fs.stat(path.join(repo, "stray.ts")).catch(() => null)).toBeNull();
      expect(await fs.readFile(path.join(repo, ".nova", "session.json"), "utf8")).toBe("{}");
    } finally {
      await fs.rm(repo, { recursive: true, force: true });
    }
  });
});
