import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import type { GitRunner } from "./checkpoints";
import { NovaSessionDaemon } from "./daemon";
import {
  ChildBudgetError,
  ChildBudgetPool,
  ChildMailbox,
  ChildSessionRegistry,
  assertAttenuatedMode,
  createChildWorktree,
  removeChildWorktree,
} from "./child-session";

const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function scriptedModel(turns: Array<Partial<AgentModelTurn>>): AgentTurnProvider {
  let index = 0;
  return {
    async complete() {
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return { responseId: `r${index}`, model: "child-test", finishReason: "stop", content: "Done.", toolCalls: [], usage, ...turn } as AgentModelTurn;
    },
  };
}

const runGitReal: GitRunner = (args, options) =>
  new Promise((resolve) => {
    const child = spawn("git", args, { cwd: options.cwd, env: { ...process.env, ...options.env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ exitCode: code ?? 0, stdout, stderr }));
  });

async function initRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-child-repo-"));
  await runGitReal(["init", "-q"], { cwd: root });
  await runGitReal(["config", "user.email", "test@example.com"], { cwd: root });
  await runGitReal(["config", "user.name", "Test"], { cwd: root });
  await fs.writeFile(path.join(root, "shared.txt"), "original\n");
  await runGitReal(["add", "-A"], { cwd: root });
  await runGitReal(["commit", "-q", "-m", "init"], { cwd: root });
  return root;
}

describe("mailbox", () => {
  it("delivers messages in order and only once", () => {
    const mailbox = new ChildMailbox();
    mailbox.postToChild("c1", "first");
    mailbox.postToChild("c1", "second");
    expect(mailbox.drainToChild("c1").map((m) => m.body)).toEqual(["first", "second"]);
    // Drained once — reading again finds nothing left.
    expect(mailbox.drainToChild("c1")).toEqual([]);
  });

  it("keeps each direction and each child separate", () => {
    const mailbox = new ChildMailbox();
    mailbox.postToChild("c1", "to c1");
    mailbox.postToChild("c2", "to c2");
    mailbox.postToParent("c1", "from c1");

    expect(mailbox.drainToChild("c1").map((m) => m.body)).toEqual(["to c1"]);
    expect(mailbox.drainToChild("c2").map((m) => m.body)).toEqual(["to c2"]);
    expect(mailbox.drainToParent("c1").map((m) => m.body)).toEqual(["from c1"]);
    expect(mailbox.drainToParent("c2")).toEqual([]);
  });

  it("forgets a child's queues without touching another's", () => {
    const mailbox = new ChildMailbox();
    mailbox.postToChild("c1", "x");
    mailbox.postToChild("c2", "y");
    mailbox.forget("c1");
    expect(mailbox.drainToChild("c1")).toEqual([]);
    expect(mailbox.drainToChild("c2").map((m) => m.body)).toEqual(["y"]);
  });
});

describe("budget attenuation", () => {
  it("lets three children divide a pool exactly, and refuses what does not fit", () => {
    const pool = new ChildBudgetPool(300);
    pool.reserve("a", 100);
    pool.reserve("b", 100);
    pool.reserve("c", 100);
    expect(pool.remainingRwf).toBe(0);
    expect(() => pool.reserve("d", 1)).toThrow(ChildBudgetError);
  });

  it("cannot let siblings collectively outspend the parent's pool", () => {
    // The property this exists to guarantee: three children racing for a 1000 RWF pool cannot
    // collectively reserve more than 1000, regardless of what any of them individually asks for.
    const pool = new ChildBudgetPool(1_000);
    pool.reserve("a", 600);
    expect(() => pool.reserve("b", 600)).toThrow(/only 400 remains/);
    pool.reserve("b", 400);
    expect(pool.remainingRwf).toBe(0);
  });

  it("refunds only what a child did not actually spend", () => {
    const pool = new ChildBudgetPool(1_000);
    pool.reserve("a", 500);
    const refund = pool.settle("a", 120);
    expect(refund).toBe(380);
    expect(pool.remainingRwf).toBe(880); // 500 never reserved + 380 refunded
  });

  it("never refunds more than was reserved, even if reported spend overstates it", () => {
    // A defensive floor: a caller reporting a bogus spend figure larger than the reservation must
    // not be able to manufacture a refund bigger than what was actually set aside.
    const pool = new ChildBudgetPool(1_000);
    pool.reserve("a", 500);
    const refund = pool.settle("a", 9_999);
    expect(refund).toBe(0);
    expect(pool.remainingRwf).toBe(500);
  });

  it("refuses to reserve twice or settle twice for the same child", () => {
    const pool = new ChildBudgetPool(1_000);
    pool.reserve("a", 100);
    expect(() => pool.reserve("a", 100)).toThrow(/already has a reservation/);
    pool.settle("a", 0);
    expect(() => pool.settle("a", 0)).toThrow(/no reservation to settle/);
  });

  it("rejects a non-positive or non-integer reservation", () => {
    const pool = new ChildBudgetPool(1_000);
    expect(() => pool.reserve("a", 0)).toThrow(ChildBudgetError);
    expect(() => pool.reserve("a", -5)).toThrow(ChildBudgetError);
    expect(() => pool.reserve("a", 1.5)).toThrow(ChildBudgetError);
  });
});

describe("capability attenuation", () => {
  it("lets a mode parent an equally or less capable child", () => {
    expect(() => assertAttenuatedMode("plan", "plan")).not.toThrow();
    expect(() => assertAttenuatedMode("build", "plan")).not.toThrow();
    expect(() => assertAttenuatedMode("build", "build")).not.toThrow();
    // build and auto carry the identical capability set — they differ only in approval policy,
    // not in what they may do — so either may parent the other.
    expect(() => assertAttenuatedMode("build", "auto")).not.toThrow();
    expect(() => assertAttenuatedMode("auto", "build")).not.toThrow();
  });

  it("refuses a child that would be granted more than its parent has", () => {
    expect(() => assertAttenuatedMode("plan", "build")).toThrow(/workspace\.files/);
    expect(() => assertAttenuatedMode("plan", "auto")).toThrow(/workspace\.files/);
  });
});

describe("isolated worktrees, against a real repository", () => {
  let root: string;
  beforeEach(async () => { root = await initRepo(); });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

  it("creates a real, separate working directory sharing the same history", async () => {
    const worktree = await createChildWorktree(root, "c1", runGitReal);
    try {
      expect(await fs.readFile(path.join(worktree.path, "shared.txt"), "utf8")).toBe("original\n");
      const inside = await runGitReal(["rev-parse", "--is-inside-work-tree"], { cwd: worktree.path });
      expect(inside.stdout.trim()).toBe("true");
      const branch = await runGitReal(["branch", "--show-current"], { cwd: worktree.path });
      expect(branch.stdout.trim()).toBe(worktree.branch);
    } finally {
      await removeChildWorktree(root, worktree, runGitReal);
    }
  });

  it("isolates edits: a child's write never appears in the parent's directory", async () => {
    // The concrete property this feature exists for. Without a worktree, two agents in the same
    // directory editing the same file at the same time silently overwrite each other.
    const worktree = await createChildWorktree(root, "c1", runGitReal);
    try {
      await fs.writeFile(path.join(worktree.path, "shared.txt"), "changed by child\n");
      expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("original\n");
      // And a file the child creates does not appear in the parent's directory either.
      await fs.writeFile(path.join(worktree.path, "child-only.txt"), "x");
      await expect(fs.access(path.join(root, "child-only.txt"))).rejects.toThrow();
    } finally {
      await removeChildWorktree(root, worktree, runGitReal);
    }
  });

  it("removes the worktree and its branch cleanly", async () => {
    const worktree = await createChildWorktree(root, "c1", runGitReal);
    await removeChildWorktree(root, worktree, runGitReal);
    await expect(fs.access(worktree.path)).rejects.toThrow();
    const branches = await runGitReal(["branch", "--list", worktree.branch], { cwd: root });
    expect(branches.stdout.trim()).toBe("");
  });
});

describe("ChildSessionRegistry, a full parent/child lifecycle", () => {
  let root: string;
  let daemon: NovaSessionDaemon;
  let registry: ChildSessionRegistry;

  beforeEach(async () => {
    root = await initRepo();
    daemon = new NovaSessionDaemon();
    registry = new ChildSessionRegistry();
  });
  afterEach(async () => {
    await daemon.shutdown();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("two concurrent children editing the same filename never collide", async () => {
    // This is the whole point, proven end to end rather than assumed from the worktree tests
    // above: two children, same parent, same repo, both told to write shared.txt — real
    // NovaAgent instances through a real NovaSessionDaemon, actually running.
    const childA = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 10_000, maxRwf: 5_000,
      model: scriptedModel([
        { finishReason: "tool_calls", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "shared.txt", content: "written by A\n" } }] },
        { content: "Wrote A's version." },
      ]),
      prices,
    });
    const childB = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 10_000, maxRwf: 5_000,
      model: scriptedModel([
        { finishReason: "tool_calls", content: "", toolCalls: [{ id: "w1", name: "write_file", arguments: { path: "shared.txt", content: "written by B\n" } }] },
        { content: "Wrote B's version." },
      ]),
      prices,
    });

    await Promise.all([registry.send(childA.id, "write shared.txt"), registry.send(childB.id, "write shared.txt")]);

    expect(await fs.readFile(path.join(childA.worktree!.path, "shared.txt"), "utf8")).toBe("written by A\n");
    expect(await fs.readFile(path.join(childB.worktree!.path, "shared.txt"), "utf8")).toBe("written by B\n");
    // Neither touched the parent's own copy.
    expect(await fs.readFile(path.join(root, "shared.txt"), "utf8")).toBe("original\n");

    await registry.finish(childA.id);
    await registry.finish(childB.id);
  });

  it("refuses a child mode that exceeds the parent's, before spending anything", async () => {
    await expect(registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "plan", root, parentRemainingRwf: 10_000, maxRwf: 100,
      mode: "build", model: scriptedModel([{ content: "unreachable" }]), prices,
    })).rejects.toThrow(/would grant/);
    // Nothing was reserved for the rejected spawn.
    expect(registry.poolFor("parent-1", 10_000).remainingRwf).toBe(10_000);
  });

  it("refuses to spawn a child the parent's pool cannot afford, and leaves no worktree behind", async () => {
    await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 1_000, maxRwf: 900,
      model: scriptedModel([{ content: "ok" }]), prices,
    });
    await expect(registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 1_000, maxRwf: 200,
      model: scriptedModel([{ content: "unreachable" }]), prices,
    })).rejects.toThrow(ChildBudgetError);
    // The failed spawn's directory must not exist — a leaked worktree from a rejected reservation
    // would accumulate forever across retries.
    const leaked = await fs.readdir(path.join(root, ".nova", "children")).catch(() => []);
    expect(leaked).toHaveLength(1); // only the one that actually succeeded
  });

  it("settles real spend back to the pool when a child finishes", async () => {
    const child = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 1_000, maxRwf: 500,
      model: scriptedModel([{ content: "quick answer" }]),
      prices,
    });
    await registry.send(child.id, "answer quickly");
    const pool = registry.poolFor("parent-1", 1_000);
    const before = pool.remainingRwf;
    await registry.finish(child.id);
    // The turn actually cost something (real usage was priced), so the refund is less than the
    // full 500 reserved but still returns whatever the ceiling did not consume.
    expect(pool.remainingRwf).toBeGreaterThan(before);
    expect(pool.remainingRwf).toBeLessThanOrEqual(1_000);
  });

  it("cancelAll and disposeAll tear down every child of a parent, and only that parent's", async () => {
    const mineA = await registry.spawn({ daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 10_000, maxRwf: 1_000, model: scriptedModel([{ content: "a" }]), prices });
    const mineB = await registry.spawn({ daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 10_000, maxRwf: 1_000, model: scriptedModel([{ content: "b" }]), prices });
    const otherRoot = await initRepo();
    try {
      const theirs = await registry.spawn({ daemon, parentSessionId: "parent-2", parentMode: "build", root: otherRoot, parentRemainingRwf: 10_000, maxRwf: 1_000, model: scriptedModel([{ content: "c" }]), prices });

      registry.cancelAll("parent-1");
      await registry.disposeAll("parent-1");

      // parent-1's worktrees are gone.
      await expect(fs.access(mineA.worktree!.path)).rejects.toThrow();
      await expect(fs.access(mineB.worktree!.path)).rejects.toThrow();
      // parent-2's child is untouched.
      await expect(fs.access(theirs.worktree!.path)).resolves.toBeUndefined();
      await registry.finish(theirs.id);
    } finally {
      await fs.rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("denies anything that needs a human decision by default, since a child has no terminal", async () => {
    // A sensitive workspace change (matching safety.ts's rules) is exactly the case auto mode's
    // own fast path does not pre-approve — it must fail closed here, not hang forever waiting on
    // an approval nobody can ever deliver.
    const child = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "auto", root, parentRemainingRwf: 10_000, maxRwf: 1_000,
      model: scriptedModel([
        { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "git push" } }] },
        { content: "unreachable" },
      ]),
      prices,
    });
    const result = await registry.send(child.id, "push it");
    expect(result.status).toBe("blocked");
    await registry.finish(child.id);
  });

  it("lets a caller override the default deny with its own approval policy", async () => {
    const child = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "auto", root, parentRemainingRwf: 10_000, maxRwf: 1_000,
      model: scriptedModel([
        { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "git push" } }] },
        { content: "Pushed." },
      ]),
      prices,
      approve: () => "allow",
    });
    const result = await registry.send(child.id, "push it");
    // The point under test is narrow: an overridden policy actually reaches the tool call instead
    // of being denied before it runs. What git push itself does against a remote-less worktree
    // (fails) is not this test's concern.
    expect(result.status).not.toBe("blocked");
    await registry.finish(child.id);
  });

  it("delivers mailbox traffic between a parent and a specific child", async () => {
    const child = await registry.spawn({
      daemon, parentSessionId: "parent-1", parentMode: "build", root, parentRemainingRwf: 10_000, maxRwf: 500,
      model: scriptedModel([{ content: "ok" }]), prices,
    });
    registry.mailbox.postToChild(child.id, { instruction: "focus on shared.txt only" });
    expect(registry.mailbox.drainToChild(child.id)).toHaveLength(1);
    registry.mailbox.postToParent(child.id, { status: "found the issue" });
    expect(registry.mailbox.drainToParent(child.id)[0].body).toEqual({ status: "found the issue" });
    await registry.finish(child.id);
  });
});
