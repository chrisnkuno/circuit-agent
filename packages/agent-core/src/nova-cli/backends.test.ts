import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { InteractiveCodingSandboxProvider, SandboxCommand } from "../providers/contracts";
import { validateSandboxCommand } from "../sandbox-policy";
import { downloadProject, E2BWorkspace, hasShellSyntax, LocalWorkspace, tokenizeCommand, uploadProject } from "./backends";

let root: string;

/**
 * An in-memory sandbox that enforces the real policy.
 *
 * Calling `validateSandboxCommand` — the same function `E2BSandboxProvider` calls — is the point:
 * a fake that accepts anything would let the E2B backend pass its tests while failing against a
 * real sandbox on the first `rm` or pipe.
 */
function fakeSandbox(files: Record<string, string> = {}): InteractiveCodingSandboxProvider & { files: Record<string, string>; commands: SandboxCommand[] } {
  const commands: SandboxCommand[] = [];
  return {
    files,
    commands,
    createSandbox: async () => ({ sandboxId: "sbx_1", status: "created" }),
    suspendSandbox: async () => {},
    stopSandbox: async () => {},
    writeFile: async (_id, filePath, content) => { files[filePath] = content; },
    readFile: async (_id, filePath) => {
      if (!(filePath in files)) throw new Error(`No such file: ${filePath}`);
      return files[filePath];
    },
    runCommand: async (_id, command) => {
      validateSandboxCommand(command);
      commands.push(command);
      if (command.program === "find") {
        return { exitCode: 0, stdout: Object.keys(files).sort().join("\n"), stderr: "" };
      }
      if (command.program === "rg") {
        const query = command.args[command.args.length - 2];
        const lines: string[] = [];
        for (const [filePath, content] of Object.entries(files)) {
          content.split("\n").forEach((line, index) => {
            if (line.includes(query)) lines.push(`${filePath}:${index + 1}:${line}`);
          });
        }
        return { exitCode: lines.length > 0 ? 0 : 1, stdout: lines.join("\n"), stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
}

function e2b(files: Record<string, string> = {}) {
  const sandbox = fakeSandbox(files);
  return { sandbox, workspace: new E2BWorkspace({ sandbox, sandboxId: "sbx_1", workspaceRoot: "/workspace/repo" }) };
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-backend-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("command tokenization", () => {
  it("splits argv the way a shell would, honouring quotes", () => {
    expect(tokenizeCommand("npm test")).toEqual(["npm", "test"]);
    expect(tokenizeCommand('git commit -m "a message here"')).toEqual(["git", "commit", "-m", "a message here"]);
    expect(tokenizeCommand("  python3   -m  pytest  ")).toEqual(["python3", "-m", "pytest"]);
    expect(() => tokenizeCommand('git commit -m "unbalanced')).toThrow(/Unbalanced quote/);
    expect(() => tokenizeCommand("   ")).toThrow(/empty/);
  });

  it("detects shell syntax only outside quotes", () => {
    expect(hasShellSyntax("cat a | grep b")).toBe(true);
    expect(hasShellSyntax("npm test && npm run lint")).toBe(true);
    expect(hasShellSyntax("echo hi > out.txt")).toBe(true);
    expect(hasShellSyntax("npm test")).toBe(false);
    // A literal argument that happens to contain an operator is not shell syntax.
    expect(hasShellSyntax('git commit -m "fix a && b"')).toBe(false);
  });
});

describe("E2B workspace", () => {
  it("reports that host-reachable application previews are unsupported instead of inventing a localhost URL", async () => {
    const { workspace } = e2b();
    await expect(workspace.startApplication({ command: "npm run dev", port: 3000 })).rejects.toThrow(/not host-reachable.*local workspace/i);
    expect(await workspace.applicationStatus()).toEqual([]);
    await expect(workspace.stopApplication("app-1")).rejects.toThrow(/not available/);
  });

  it("confines paths to the sandbox workspace root", async () => {
    const { workspace } = e2b({ "/workspace/repo/app.py": "print(1)\n" });
    await expect(workspace.readFile("../../etc/passwd")).rejects.toThrow(/escapes the workspace root/);
    await expect(workspace.readFile("/etc/passwd")).rejects.toThrow(/escapes the workspace root/);
    expect((await workspace.readFile("app.py")).content).toBe("print(1)\n");
  });

  it("reads, writes and edits with the same semantics as the local backend", async () => {
    const files: Record<string, string> = { "/workspace/repo/app.py": "port = 3000\nport = 3000\n" };
    const { workspace } = e2b(files);

    const written = await workspace.writeFile("new.py", "x = 1\n");
    expect(written).toEqual({ path: "new.py", bytesWritten: 6 });
    expect(files["/workspace/repo/new.py"]).toBe("x = 1\n");

    // Ambiguity is an error in both backends, not a coin flip.
    await expect(workspace.editFile("app.py", "port = 3000", "port = 8080")).rejects.toThrow(/appears 2 times/);
    const edited = await workspace.editFile("app.py", "port = 3000", "port = 8080", { replaceAll: true });
    expect(edited.replacements).toBe(2);
    expect(files["/workspace/repo/app.py"]).toBe("port = 8080\nport = 8080\n");

    await expect(workspace.editFile("app.py", "absent", "x")).rejects.toThrow(/was not found/);
  });

  it("lists a directory to a bounded depth, implying directories from the file paths beneath them", async () => {
    const { workspace } = e2b({
      "/workspace/repo/README.md": "a",
      "/workspace/repo/src/main.ts": "b",
      "/workspace/repo/src/deep/util.ts": "c",
    });
    // find -type f never lists directories themselves — E2BWorkspace has to imply "src/" from
    // seeing a file underneath it, the same way the local backend's real directory walk does.
    expect(await workspace.list("", 1)).toEqual(["README.md", "src/"]);
    expect(await workspace.list("", 2)).toEqual(["README.md", "src/", "src/deep/", "src/main.ts"]);
  });

  it("lists only inside the given prefix, not the whole workspace", async () => {
    const { workspace } = e2b({
      "/workspace/repo/src/main.ts": "a",
      "/workspace/repo/README.md": "b",
    });
    expect(await workspace.list("src", 1)).toEqual(["src/main.ts"]);
  });

  it("globs remotely using the same matcher the local backend uses", async () => {
    const { workspace } = e2b({
      "/workspace/repo/src/main.ts": "a",
      "/workspace/repo/src/deep/util.ts": "b",
      "/workspace/repo/README.md": "c",
    });
    expect(await workspace.glob("**/*.ts")).toEqual(["src/deep/util.ts", "src/main.ts"]);
    expect(await workspace.glob("*.md")).toEqual(["README.md"]);
  });

  it("greps through ripgrep and parses its output into matches", async () => {
    const { workspace, sandbox } = e2b({ "/workspace/repo/a.py": "value = 1\nother = 2\n" });
    const matches = await workspace.grep("value");
    expect(matches).toEqual([{ path: "a.py", line: 1, text: "value = 1" }]);
    expect(sandbox.commands.at(-1)?.program).toBe("rg");
    // Fixed-string by default; the model opts into regex explicitly.
    expect(sandbox.commands.at(-1)?.args).toContain("--fixed-strings");
  });

  it("falls back to reading files when the image has no ripgrep", async () => {
    // E2B's stock `base` image ships no rg, and `grep` is not allowlisted — verified live. Without
    // this fallback, content search is unavailable on the default backend.
    const sandbox = fakeSandbox({ "/workspace/repo/a.py": "value = 1\nother = 2\n", "/workspace/repo/b.md": "value again\n" });
    const original = sandbox.runCommand;
    sandbox.runCommand = async (id, command) => (command.program === "rg" ? { exitCode: 127, stdout: "", stderr: "rg: not found" } : original(id, command));
    const workspace = new E2BWorkspace({ sandbox, sandboxId: "sbx_1", workspaceRoot: "/workspace/repo" });

    expect(await workspace.grep("value")).toEqual([
      { path: "a.py", line: 1, text: "value = 1" },
      { path: "b.md", line: 1, text: "value again" },
    ]);
    // The include glob must mean the same thing on both paths.
    expect(await workspace.grep("value", { include: "**/*.py" })).toEqual([{ path: "a.py", line: 1, text: "value = 1" }]);
  });

  it("skips a file it cannot read during the fallback search, rather than failing the whole search", async () => {
    // Exactly what ripgrep itself does with a binary file — skip it and keep going — so the
    // fallback path (used when the image has no rg at all) has to behave the same way.
    const sandbox = fakeSandbox({ "/workspace/repo/a.py": "value = 1\n", "/workspace/repo/photo.png": "value in binary\n" });
    const original = sandbox.runCommand;
    sandbox.runCommand = async (id, command) => (command.program === "rg" ? { exitCode: 127, stdout: "", stderr: "rg: not found" } : original(id, command));
    const originalRead = sandbox.readFile;
    sandbox.readFile = async (id, filePath) => {
      if (filePath.endsWith(".png")) throw new Error("EISDIR or binary content");
      return originalRead(id, filePath);
    };
    const workspace = new E2BWorkspace({ sandbox, sandboxId: "sbx_1", workspaceRoot: "/workspace/repo" });

    expect(await workspace.grep("value")).toEqual([{ path: "a.py", line: 1, text: "value = 1" }]);
  });

  it("reports no matches as an empty result rather than an error", async () => {
    const { workspace } = e2b({ "/workspace/repo/a.py": "nothing here\n" });
    expect(await workspace.grep("absent")).toEqual([]);
  });

  it("explains that shell syntax is unavailable instead of passing it through as an argument", async () => {
    const { workspace, sandbox } = e2b();
    const result = await workspace.runCommand("cat a.txt | grep x", 10_000);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("argv, not through a shell");
    expect(sandbox.commands).toHaveLength(0);
  });

  it("turns a sandbox policy refusal into a result the model can act on", async () => {
    const { workspace } = e2b();
    // `rm` is not on the allowlist, so the real provider throws; the run must not die with it.
    const result = await workspace.runCommand("rm file.txt", 10_000);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("not allowed");
  });

  it("runs an allowlisted command as argv in the workspace root", async () => {
    const { workspace, sandbox } = e2b();
    const result = await workspace.runCommand("python3 -m pytest", 30_000);
    expect(result.exitCode).toBe(0);
    expect(sandbox.commands.at(-1)).toMatchObject({ program: "python3", args: ["-m", "pytest"], cwd: "/workspace/repo" });
  });

  it("names itself so the prompt and the header can say where files are going", () => {
    const { workspace } = e2b();
    expect(workspace.kind).toBe("e2b");
    expect(workspace.label).toBe("e2b:sbx_1:/workspace/repo");
    expect(workspace.commandGuidance).toContain("isolated remote sandbox");
  });

  it("stops the sandbox when disposed", async () => {
    const sandbox = fakeSandbox();
    const stopped: string[] = [];
    const workspace = new E2BWorkspace({
      sandbox,
      sandboxId: "sbx_1",
      workspaceRoot: "/workspace/repo",
      onDispose: async (id) => { stopped.push(id); },
    });
    await workspace.dispose();
    expect(stopped).toEqual(["sbx_1"]);
  });
});

describe("moving a project between backends", () => {
  it("uploads a local project into the sandbox, skipping vendored and binary files", async () => {
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "main.ts"), "export const x = 1;\n");
    await fs.writeFile(path.join(root, "README.md"), "# hi\n");
    await fs.writeFile(path.join(root, "node_modules", "dep.js"), "vendored\n");
    await fs.writeFile(path.join(root, "logo.bin"), Buffer.from([0x00, 0x01, 0x02]));

    const { workspace, sandbox } = e2b();
    const result = await uploadProject(workspace, root);

    expect(result.uploaded.sort()).toEqual(["README.md", "src/main.ts"]);
    expect(result.skipped).toContain("logo.bin");
    expect(sandbox.files["/workspace/repo/src/main.ts"]).toBe("export const x = 1;\n");
    expect(Object.keys(sandbox.files).some((file) => file.includes("node_modules"))).toBe(false);
  });

  it("downloads sandbox work back to a local directory so it can be kept", async () => {
    const { workspace } = e2b({
      "/workspace/repo/out/result.md": "# findings\n",
      "/workspace/repo/main.py": "print('done')\n",
    });
    const destination = path.join(root, "pulled");
    const result = await downloadProject(workspace, destination);

    expect(result.written.sort()).toEqual(["main.py", "out/result.md"]);
    expect(await fs.readFile(path.join(destination, "out", "result.md"), "utf8")).toBe("# findings\n");
  });

  it("skips a file it cannot read during download, rather than failing the whole pull", async () => {
    const sandbox = fakeSandbox({ "/workspace/repo/a.py": "ok\n", "/workspace/repo/broken.py": "irrelevant\n" });
    const originalRead = sandbox.readFile;
    sandbox.readFile = async (id, filePath) => {
      if (filePath.endsWith("broken.py")) throw new Error("read failed");
      return originalRead(id, filePath);
    };
    const workspace = new E2BWorkspace({ sandbox, sandboxId: "sbx_1", workspaceRoot: "/workspace/repo" });
    const result = await downloadProject(workspace, path.join(root, "pulled"));
    expect(result.written).toEqual(["a.py"]);
    expect(result.failed).toEqual(["broken.py"]);
  });
});

describe("LocalWorkspace", () => {
  it("presents the same interface, labelled as the real directory", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "hello\n");
    const workspace = new LocalWorkspace(root);
    expect(workspace.kind).toBe("local");
    expect(workspace.label).toBe(root);
    expect((await workspace.readFile("a.txt")).content).toBe("hello\n");
    expect(await workspace.glob("*.txt")).toEqual(["a.txt"]);
  });
});
