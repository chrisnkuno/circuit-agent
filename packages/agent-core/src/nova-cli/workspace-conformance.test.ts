import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InteractiveCodingSandboxProvider, SandboxCommand } from "../providers/contracts";
import { DockerWorkspace, E2BWorkspace, LocalWorkspace, type NovaWorkspace } from "./backends";
import { NestedInstructionTracker } from "./nested-instructions";

/**
 * One behavioural contract, checked against every backend that claims to implement it.
 *
 * `NovaWorkspace` is the interface the tool layer is written against, and the model is shown the
 * same eleven tools regardless of which backend answers them — so a model's experience of "read a
 * missing file" or "edit with an ambiguous match" is supposed to be the same sentence whichever
 * backend is running. It never was checked as one thing: `LocalWorkspace` and `E2BWorkspace` each
 * had their own test file, each asserting its own backend behaves sensibly in isolation, and
 * nothing ever asserted the two *agree*. That gap is exactly how `readTextFile` came to leak a raw
 * `ENOENT: ... /home/user/project/missing.txt` for a missing file locally, while the sandboxed
 * backends already said the clean `missing.txt does not exist` — both individually correct, and
 * silently different from each other, invisible until compared directly.
 *
 * This file is that comparison, and it is deliberately not a byte-for-byte string match: the three
 * backends are three different subsystems (real fs calls, a fake sandbox provider standing in for
 * E2B, the same fake standing in for Docker), and demanding identical exception text down to the
 * word would only ever be true by accident. What has to be identical is the *shape* of the
 * result — the relative path involved, never the machine's absolute layout, the same category of
 * failure — checked as a property every backend must satisfy, not a fixture every backend must
 * happen to reproduce.
 */

function fakeSandbox(): InteractiveCodingSandboxProvider & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  const commands: SandboxCommand[] = [];
  return {
    files,
    createSandbox: async () => ({ sandboxId: "sbx_1", status: "created" }),
    suspendSandbox: async () => {},
    stopSandbox: async () => {},
    writeFile: async (_id, filePath, content) => { files[filePath] = content; },
    readFile: async (_id, filePath) => {
      if (!(filePath in files)) throw new Error(`No such file: ${filePath}`);
      return files[filePath];
    },
    runCommand: async (_id, command) => {
      commands.push(command);
      if (command.program === "find") {
        // Honours `-not -path <glob>` the way real find does. The fake used to return every file
        // regardless, which quietly made the ignored-directory filtering untestable on the sandbox
        // backends: `listSandboxFiles` passes those exclusions and a fake that drops them cannot
        // tell a backend that filters correctly from one that does not filter at all.
        const excluded: string[] = [];
        for (let index = 0; index < command.args.length; index += 1) {
          if (command.args[index] === "-not" && command.args[index + 1] === "-path") excluded.push(command.args[index + 2]);
        }
        const searchRoot = command.args[0];
        const matches = Object.keys(files)
          .filter((filePath) => filePath === searchRoot || filePath.startsWith(`${searchRoot}/`))
          .filter((filePath) => !excluded.some((pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(filePath)))
          .sort();
        // Real find exits 1 when the search root does not exist, which is how "nothing configured"
        // is distinguished from "an empty directory exists".
        if (!Object.keys(files).some((filePath) => filePath.startsWith(`${searchRoot}/`))) return { exitCode: 1, stdout: "", stderr: "No such file or directory" };
        return { exitCode: 0, stdout: matches.join("\n"), stderr: "" };
      }
      if (command.program === "rg") {
        const query = command.args.at(-2) ?? "";
        const lines: string[] = [];
        for (const [filePath, content] of Object.entries(files)) {
          content.split("\n").forEach((line, index) => { if (line.includes(query)) lines.push(`${filePath}:${index + 1}:${line}`); });
        }
        return { exitCode: lines.length > 0 ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
}

type Backend = { name: string; workspace: NovaWorkspace; seed(path: string, content: string): Promise<void>; cleanup(): Promise<void> };

async function localBackend(): Promise<Backend> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-conformance-"));
  return {
    name: "local",
    workspace: new LocalWorkspace(root),
    seed: async (relativePath, content) => {
      await fs.mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
      await fs.writeFile(path.join(root, relativePath), content, "utf8");
    },
    cleanup: async () => { await fs.rm(root, { recursive: true, force: true }); },
  };
}

function e2bBackend(): Backend {
  const sandbox = fakeSandbox();
  return {
    name: "e2b",
    workspace: new E2BWorkspace({ sandbox, sandboxId: "sbx_1", workspaceRoot: "/workspace/repo" }),
    seed: async (relativePath, content) => { sandbox.files[`/workspace/repo/${relativePath}`] = content; },
    cleanup: async () => {},
  };
}

function dockerBackend(): Backend {
  const sandbox = fakeSandbox();
  return {
    name: "docker",
    workspace: new DockerWorkspace({ sandbox, sandboxId: "cnt_1", workspaceRoot: "/workspace/repo" }),
    seed: async (relativePath, content) => { sandbox.files[`/workspace/repo/${relativePath}`] = content; },
    cleanup: async () => {},
  };
}

const backends: Array<() => Backend | Promise<Backend>> = [localBackend, e2bBackend, dockerBackend];

describe.each(backends.map((factory) => [factory]))("workspace conformance", (factory) => {
  it("writes then reads back the exact content, under the same relative path", async () => {
    const backend = await factory();
    try {
      const written = await backend.workspace.writeFile("notes.txt", "hello world");
      expect(written.path).toBe("notes.txt");
      expect(written.bytesWritten).toBe(11);
      const read = await backend.workspace.readFile("notes.txt");
      expect(read.content).toBe("hello world");
      expect(read.path).toBe("notes.txt");
    } finally {
      await backend.cleanup();
    }
  });

  it("reading a missing file fails, naming the relative path and leaking no absolute one", async () => {
    const backend = await factory();
    try {
      await expect(backend.workspace.readFile("missing.txt")).rejects.toThrow();
      const error = await backend.workspace.readFile("missing.txt").catch((caught: Error) => caught);
      expect((error as Error).message).toContain("missing.txt");
      // The one invariant that matters most: no backend may put this machine's own filesystem
      // layout into a message a model reads and might repeat back to a user.
      expect((error as Error).message).not.toMatch(/\/(home|Users|tmp|var)\//);
    } finally {
      await backend.cleanup();
    }
  });

  it("refuses a write over the byte limit, identically across backends", async () => {
    const backend = await factory();
    try {
      const oversized = "x".repeat(11 * 1024 * 1024); // default maxWriteBytes is 10 MiB
      await expect(backend.workspace.writeFile("big.txt", oversized)).rejects.toThrow(/byte write limit/);
    } finally {
      await backend.cleanup();
    }
  });

  it("edits exactly one occurrence and reports it", async () => {
    const backend = await factory();
    try {
      await backend.seed("app.ts", "const port = 3000;\n");
      const result = await backend.workspace.editFile("app.ts", "3000", "8080");
      expect(result.replacements).toBe(1);
      expect((await backend.workspace.readFile("app.ts")).content).toBe("const port = 8080;\n");
    } finally {
      await backend.cleanup();
    }
  });

  it("refuses an edit whose oldText does not appear, naming the file", async () => {
    const backend = await factory();
    try {
      await backend.seed("app.ts", "const port = 3000;\n");
      await expect(backend.workspace.editFile("app.ts", "9999", "x")).rejects.toThrow(/not found/);
    } finally {
      await backend.cleanup();
    }
  });

  it("refuses an ambiguous edit unless replaceAll is set, and reports how many matches", async () => {
    const backend = await factory();
    try {
      await backend.seed("app.ts", "let a = 1; let a2 = 1;\n");
      await expect(backend.workspace.editFile("app.ts", "= 1", "= 2")).rejects.toThrow(/appears 2 times/);
      const replaced = await backend.workspace.editFile("app.ts", "= 1", "= 2", { replaceAll: true });
      expect(replaced.replacements).toBe(2);
    } finally {
      await backend.cleanup();
    }
  });

  it("lists, globs and greps the same fixture to the same relative results", async () => {
    const backend = await factory();
    try {
      await backend.seed("src/app.ts", "export const x = 1;\n");
      await backend.seed("src/util.ts", "export const y = 2;\n");
      await backend.seed("README.md", "# hi\n");

      const listed = await backend.workspace.list("", 2);
      expect(listed).toContain("src/");
      expect(listed).toContain("README.md");

      const globbed = await backend.workspace.glob("**/*.ts");
      expect([...globbed].sort()).toEqual(["src/app.ts", "src/util.ts"]);

      const matches = await backend.workspace.grep("export const");
      expect(matches.map((match) => match.path).sort()).toEqual(["src/app.ts", "src/util.ts"]);
    } finally {
      await backend.cleanup();
    }
  });

  it("refuses a path that escapes the workspace root", async () => {
    const backend = await factory();
    try {
      await expect(backend.workspace.readFile("../outside.txt")).rejects.toThrow();
    } finally {
      await backend.cleanup();
    }
  });

  it("finds Nova's own config under .nova, which the agent-facing search deliberately hides", async () => {
    // The property that makes skills, hooks and plugins work off this machine at all. `.nova` is in
    // every backend's ignored-directory list so the *agent's* searches are not cluttered by Nova's
    // bookkeeping — which is right, and which also meant config discovery routed through
    // `list`/`glob` silently found nothing on every backend. These must disagree, in this exact
    // direction, on every backend equally.
    const backend = await factory();
    try {
      await backend.seed(".nova/skills/greet/skill.json", "{}");
      await backend.seed("src/app.ts", "export const port = 3000;");

      const config = await backend.workspace.listConfigFiles(".nova/skills");
      expect(config).toContain(".nova/skills/greet/skill.json");

      // ...and the agent-facing search still does not see it, on every backend.
      const globbed = await backend.workspace.glob("**/*.json");
      expect(globbed).not.toContain(".nova/skills/greet/skill.json");
    } finally {
      await backend.cleanup();
    }
  });

  it("reports a missing config directory as nothing configured, never as a failure", async () => {
    const backend = await factory();
    try {
      await expect(backend.workspace.listConfigFiles(".nova/skills")).resolves.toEqual([]);
    } finally {
      await backend.cleanup();
    }
  });

  it("surfaces a subdirectory's own AGENTS.md on every backend, not only locally", async () => {
    const backend = await factory();
    try {
      await backend.seed("src/api/AGENTS.md", "Use snake_case for API field names.");
      await backend.seed("src/api/handler.ts", "export const handler = 1;");
      const tracker = new NestedInstructionTracker(backend.workspace);

      const found = await tracker.discover("src/api/handler.ts");
      expect(found.map((instruction) => instruction.path)).toEqual(["src/api/AGENTS.md"]);
      expect(found[0].content).toContain("snake_case");

      // Shown once per directory per session, whichever backend is answering.
      expect(await tracker.discover("src/api/handler.ts")).toEqual([]);
    } finally {
      await backend.cleanup();
    }
  });
});
