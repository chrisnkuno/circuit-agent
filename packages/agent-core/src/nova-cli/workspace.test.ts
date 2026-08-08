import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  editTextFile,
  globToRegExp,
  globWorkspace,
  grepWorkspace,
  looksBinary,
  readTextFile,
  resolveInWorkspace,
  writeTextFile,
  WorkspaceViolation,
} from "./workspace";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-workspace-"));
  await fs.mkdir(path.join(root, "src", "deep"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules", "pkg"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "main.ts"), "export const value = 1;\nconst other = 2;\n");
  await fs.writeFile(path.join(root, "src", "deep", "util.ts"), "export function help() { return 'value'; }\n");
  await fs.writeFile(path.join(root, "README.md"), "# Project\nvalue lives in src\n");
  await fs.writeFile(path.join(root, "node_modules", "pkg", "index.js"), "value\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("workspace confinement", () => {
  it("refuses paths that climb out of the project", () => {
    expect(() => resolveInWorkspace(root, "../secrets.txt")).toThrow(WorkspaceViolation);
    expect(() => resolveInWorkspace(root, "src/../../etc/passwd")).toThrow(WorkspaceViolation);
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(WorkspaceViolation);
    expect(resolveInWorkspace(root, "src/main.ts")).toBe(path.join(root, "src", "main.ts"));
  });

  it("refuses to read through a symlink that points outside the project", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nova-outside-"));
    await fs.writeFile(path.join(outside, "secret.txt"), "credentials\n");
    try {
      await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    } catch {
      return; // Symlinks unavailable on this platform; the lexical check above still applies.
    }
    await expect(readTextFile(root, "link.txt")).rejects.toThrow(/outside the workspace root/);
    await fs.rm(outside, { recursive: true, force: true });
  });

  it("refuses binary files and oversized reads rather than feeding them to the model", async () => {
    await fs.writeFile(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
    await expect(readTextFile(root, "image.bin")).rejects.toThrow(/binary/);
    expect(looksBinary(Buffer.from("plain text"))).toBe(false);

    await fs.writeFile(path.join(root, "big.txt"), "x".repeat(2_000));
    await expect(readTextFile(root, "big.txt", { limits: { maxReadBytes: 100, maxWriteBytes: 100, ignoredDirectories: [] } })).rejects.toThrow(/read limit/);
  });
});

describe("reading and editing", () => {
  it("returns a line window with an honest header when asked for one", async () => {
    const whole = await readTextFile(root, "src/main.ts");
    expect(whole.truncated).toBe(false);
    expect(whole.totalLines).toBe(3);

    const window = await readTextFile(root, "src/main.ts", { offset: 2, limit: 1 });
    expect(window.content).toBe("const other = 2;");
    expect(window.truncated).toBe(true);
  });

  it("replaces an exact string and refuses an ambiguous one", async () => {
    await fs.writeFile(path.join(root, "dup.ts"), "a();\nb();\na();\n");
    await expect(editTextFile(root, "dup.ts", "a();", "c();")).rejects.toThrow(/appears 2 times/);

    const all = await editTextFile(root, "dup.ts", "a();", "c();", { replaceAll: true });
    expect(all.replacements).toBe(2);
    expect(await fs.readFile(path.join(root, "dup.ts"), "utf8")).toBe("c();\nb();\nc();\n");
  });

  it("refuses an edit whose target text is absent, instead of writing something new", async () => {
    await expect(editTextFile(root, "src/main.ts", "not present", "x")).rejects.toThrow(/was not found/);
  });

  it("creates parent directories on write and reports the bytes written", async () => {
    const result = await writeTextFile(root, "src/new/nested.ts", "export const x = 1;\n");
    expect(result.path).toBe("src/new/nested.ts");
    expect(result.bytesWritten).toBe(20);
    expect(await fs.readFile(path.join(root, "src", "new", "nested.ts"), "utf8")).toContain("export const x");
  });
});

describe("search", () => {
  it("translates the glob syntax people actually type", () => {
    expect(globToRegExp("**/*.ts").test("src/deep/util.ts")).toBe(true);
    expect(globToRegExp("src/**/*.ts").test("src/main.ts")).toBe(true);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/README.md")).toBe(false);
    expect(globToRegExp("**/*.{js,ts}").test("a/b.js")).toBe(true);
  });

  it("globs the project and skips vendored directories", async () => {
    const matches = await globWorkspace(root, "**/*.ts");
    expect(matches).toEqual(["src/deep/util.ts", "src/main.ts"]);
    expect(await globWorkspace(root, "**/*.js")).toEqual([]);
  });

  it("greps content with line numbers, honouring an include filter", async () => {
    const all = await grepWorkspace(root, "value");
    expect(all.map((match) => match.path).sort()).toEqual(["README.md", "src/deep/util.ts", "src/main.ts"]);
    expect(all.every((match) => match.line > 0)).toBe(true);

    const scoped = await grepWorkspace(root, "value", { include: "src/**/*.ts" });
    expect(scoped.map((match) => match.path).sort()).toEqual(["src/deep/util.ts", "src/main.ts"]);

    const pattern = await grepWorkspace(root, "^export", { regex: true, include: "**/*.ts" });
    expect(pattern).toHaveLength(2);
  });
});
