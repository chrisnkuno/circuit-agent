import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool, AgentToolCall } from "../agent-runtime";
import { E2BWorkspace, LocalWorkspace } from "./backends";
import { isFindDelete, isRecursiveForceRemoval } from "./command";
import { actionDigest, NOVA_CAPABILITIES } from "./permissions";
import { assessToolSafety } from "./safety";
import { isRefusedCommand } from "./tools";

/**
 * Deliberate attempts to defeat Nova's own defenses, run against the real functions rather than a
 * model of them.
 *
 * Every other test file in this package asks "does this work correctly." This one asks a different
 * question: "can this be gotten around," and answers it by actually trying — reordering flags,
 * spelling them differently, walking a symlink out of the workspace, mutating a nested argument
 * — because a defense that has only ever been tested against the input its own author imagined is
 * a defense that has only ever been tested against a cooperative adversary.
 *
 * Two of the findings below were real, live bugs this suite exists because of: `rm --recursive
 * --force /` and `find . -delete` both reached auto mode's silent fast path with no confirmation
 * at all, discovered by literally running them against `assessToolSafety` and reading the answer.
 * They are fixed in `command.ts` (`isRecursiveForceRemoval`, `isFindDelete`); the tests below are
 * what stops them from coming back unnoticed.
 */

const tool = (overrides: Partial<AgentTool> & { name: string }): AgentTool => ({
  description: "",
  inputSchema: {},
  capabilityId: NOVA_CAPABILITIES.terminal,
  effect: "workspace",
  requiresApproval: true,
  parallelSafe: false,
  execute: async () => ({ content: "" }),
  ...overrides,
});

const call = (name: string, args: Record<string, unknown> = {}): AgentToolCall => ({ id: "call_1", name, arguments: args });

describe("destructive-command refusal survives reordering and respelling", () => {
  it("catches recursive-force removal regardless of flag order or GNU spelling", () => {
    for (const command of [
      "rm -rf /workspace",
      "rm -fr /workspace",
      "rm -Rf /workspace",
      "rm -r -f /workspace",
      "rm --recursive --force /workspace",
      "rm --force --recursive /workspace",
      "rm -r --force /workspace",
      "sudo rm -rf /workspace",
    ]) {
      expect(isRefusedCommand(command), command).toBe(true);
      expect(isRecursiveForceRemoval(command), command).toBe(true);
    }
  });

  it("catches find -delete, a full tree wipe under a name with no 'rm' in it", () => {
    for (const command of ["find . -delete", "find /workspace -name '*' -delete", "sudo find / -delete"]) {
      expect(isRefusedCommand(command), command).toBe(true);
      expect(isFindDelete(command), command).toBe(true);
    }
  });

  it("does not flag git's own rm subcommand, which removes a tracked file, not a filesystem tree", () => {
    // The false positive the token-based check almost shipped with: `rm` appearing anywhere in the
    // token list matched `git rm -rf dir` as if it were the destructive filesystem `rm`. It is a
    // different program entirely — git's `rm -r -f` deletes from the index, fully recoverable from
    // history — and refusing it outright would refuse an ordinary, safe, common operation.
    for (const command of ["git rm -rf old-directory", "git rm -r --force old-directory", "git rm --cached -rf build/"]) {
      expect(isRecursiveForceRemoval(command), command).toBe(false);
    }
  });

  it("does not flag find without -delete, or a filename that merely contains 'find'", () => {
    for (const command of ["find . -name '*.log'", "find . -type f -print", "npm run find-and-report"]) {
      expect(isFindDelete(command), command).toBe(false);
    }
  });

  it("does not flag a plain, unforced, non-recursive rm", () => {
    for (const command of ["rm one-file.txt", "rm -i confirm-first.txt"]) {
      expect(isRecursiveForceRemoval(command), command).toBe(false);
    }
  });

  it("falls back to not-a-match on a command it cannot tokenize, rather than throwing", () => {
    expect(() => isRecursiveForceRemoval("rm -rf 'unbalanced")).not.toThrow();
    expect(isRecursiveForceRemoval("rm -rf 'unbalanced")).toBe(false);
  });
});

describe("auto mode's sensitivity check catches the same bypasses", () => {
  // The more severe half of the same bug: `isRefusedCommand` is a hard, mode-independent block,
  // but a command that slips past `assessToolSafety` specifically reaches auto mode's silent
  // pre-approval fast path — meaning it would have run with no confirmation shown to anyone.
  it("flags recursive-force removal and find -delete as sensitive, spelled any of the usual ways", () => {
    for (const command of ["rm -rf /workspace", "rm --recursive --force /workspace", "rm -fr /workspace", "find /workspace -delete"]) {
      const assessment = assessToolSafety(call("run_command", { command }), tool({ name: "run_command" }));
      expect(assessment.sensitive, command).toBe(true);
      expect(assessment.categories).toContain("destructive");
    }
  });

  it("does not flag ordinary commands as destructive", () => {
    for (const command of ["npm test", "git status", "git rm -rf old-directory", "ls -la"]) {
      expect(assessToolSafety(call("run_command", { command }), tool({ name: "run_command" })).sensitive, command).toBe(false);
    }
  });
});

describe("known, deliberate gaps in the denylist", () => {
  // A denylist is inherently incomplete — there is no finite pattern set that recognizes every
  // destructive command ever written. These were tried, found to slip through, and left that way
  // on purpose: the real boundary for local, unattended work is that build mode asks a human before
  // any of these run at all, and auto mode is an explicit opt-in the user made. This test exists so
  // that fact is a documented decision the next reader can evaluate, not a gap nobody noticed.
  it("records what current probing does not catch, so a future fix has a starting list", () => {
    const uncaught = ["truncate -s 0 /dev/sda", "rsync -a --delete / /dev/null/", "shred -u important.txt", "chmod -R 000 /"];
    for (const command of uncaught) {
      expect(isRefusedCommand(command), `${command} — if this now fails, the denylist grew; update this test, don't just delete the assertion`).toBe(false);
    }
  });
});

describe("path confinement holds under real adversarial input", () => {
  async function withWorkspace(run: (workspace: LocalWorkspace, root: string, outside: string) => Promise<void>): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "adversarial-root-"));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "adversarial-outside-"));
    try {
      await fs.writeFile(path.join(root, "safe.txt"), "safe");
      await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
      await run(new LocalWorkspace(root), root, outside);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  }

  it("refuses every relative and absolute traversal attempt tried", async () => {
    await withWorkspace(async (workspace, rootPath) => {
      for (const candidate of [
        "../outside.txt",
        "./safe.txt/../../outside.txt",
        "safe.txt/../../../outside.txt",
        "/etc/passwd",
        `${rootPath}/../outside.txt`,
        "....//....//outside.txt",
      ]) {
        await expect(workspace.readFile(candidate), candidate).rejects.toThrow();
      }
    });
  });

  it("refuses a symlink planted inside the root that points outside it", async () => {
    await withWorkspace(async (workspace, rootPath, outsidePath) => {
      await fs.symlink(outsidePath, path.join(rootPath, "escape-link"), "dir");
      await expect(workspace.readFile("escape-link/secret.txt")).rejects.toThrow(/outside the workspace root/);
    });
  });

  it("holds the same confinement in the sandbox backend, whose path logic is a separate implementation", async () => {
    // Local uses fs.realpath; the sandbox backend hand-rolls segment resolution against a string
    // root because there is no real filesystem to ask. Two independent implementations of "stay
    // inside the root" is two chances for only one of them to have the bug — checked here directly
    // rather than assumed from Local's test passing.
    const files: Record<string, string> = { "/workspace/repo/safe.txt": "safe", "/etc/passwd": "root:x:0:0" };
    const sandbox = {
      createSandbox: async () => ({ sandboxId: "s", status: "created" as const }),
      suspendSandbox: async () => {}, stopSandbox: async () => {},
      writeFile: async (_id: string, filePath: string, content: string) => { files[filePath] = content; },
      readFile: async (_id: string, filePath: string) => { if (!(filePath in files)) throw new Error("no such file"); return files[filePath]; },
      runCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    const workspace = new E2BWorkspace({ sandbox, sandboxId: "s", workspaceRoot: "/workspace/repo" });
    for (const candidate of ["../../../etc/passwd", "/etc/passwd", "safe.txt/../../etc/passwd"]) {
      await expect(workspace.readFile(candidate), candidate).rejects.toThrow(/escapes the workspace root/);
    }
  });
});

describe("approval digests resist tampering", () => {
  it("changes when a nested argument value changes, not just a top-level one", () => {
    const editTool = tool({ name: "edit_file", capabilityId: NOVA_CAPABILITIES.write });
    const base = actionDigest(call("edit_file", { path: "a.ts", context: { line: 10, hint: { column: 2 } } }), editTool);
    const mutatedNested = actionDigest(call("edit_file", { path: "a.ts", context: { line: 10, hint: { column: 3 } } }), editTool);
    expect(mutatedNested).not.toBe(base);
  });

  it("changes when an array argument's contents or order changes", () => {
    const grepTool = tool({ name: "grep_files", capabilityId: NOVA_CAPABILITIES.read });
    const base = actionDigest(call("grep_files", { include: ["a.ts", "b.ts"] }), grepTool);
    const reordered = actionDigest(call("grep_files", { include: ["b.ts", "a.ts"] }), grepTool);
    const changed = actionDigest(call("grep_files", { include: ["a.ts", "c.ts"] }), grepTool);
    // Array order is meaningful (unlike object key order, which the digest already normalizes) —
    // a glob pattern list applied in a different order is not guaranteed to mean the same thing.
    expect(reordered).not.toBe(base);
    expect(changed).not.toBe(base);
  });

  it("never lets two different tools with identical arguments collide onto the same digest", () => {
    // The scenario this closes: approving one write_file call must not silently also approve an
    // edit_file call that happens to carry the exact same { path } argument.
    const args = { path: "a.ts" };
    const writeDigest = actionDigest(call("write_file", args), tool({ name: "write_file" }));
    const editDigest = actionDigest(call("edit_file", args), tool({ name: "edit_file" }));
    expect(writeDigest).not.toBe(editDigest);
  });

  it("never lets the same tool and arguments collide across different capability scopes", () => {
    const args = { command: "npm test" };
    const asTerminal = actionDigest(call("run_command", args), tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.terminal }));
    const asWrite = actionDigest(call("run_command", args), tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.write }));
    expect(asTerminal).not.toBe(asWrite);
  });

  it("changes when a key is added or removed, not only when a value changes", () => {
    const base = actionDigest(call("write_file", { path: "a.ts", content: "x" }), tool({ name: "write_file" }));
    const extraKey = actionDigest(call("write_file", { path: "a.ts", content: "x", encoding: "utf8" }), tool({ name: "write_file" }));
    expect(extraKey).not.toBe(base);
  });
});
