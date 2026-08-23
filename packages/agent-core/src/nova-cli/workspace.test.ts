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
  walkWorkspace,
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

  it("reports paths relative to the spelling of an aliased workspace root", async () => {
    const alias = `${root}-alias`;
    try {
      await fs.symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    } catch {
      return; // Some locked-down Windows environments do not permit links.
    }
    try {
      expect((await readTextFile(alias, "src/main.ts")).path).toBe("src/main.ts");
    } finally {
      await fs.unlink(alias).catch(() => undefined);
    }
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

describe("walking and searching concurrently", () => {
  /** A tree wide and deep enough that a level-at-a-time walk actually has something to parallelize. */
  async function tree(base: string): Promise<void> {
    for (let directory = 0; directory < 12; directory += 1) {
      const nested = path.join(base, `pkg-${directory}`, "src");
      await fs.mkdir(nested, { recursive: true });
      for (let file = 0; file < 6; file += 1) {
        await fs.writeFile(path.join(nested, `mod-${file}.ts`), `export const marker = "needle-${directory}-${file}";\n`.repeat(4));
      }
    }
    // Generated output: present, and never searched.
    await fs.mkdir(path.join(base, "coverage"), { recursive: true });
    await fs.writeFile(path.join(base, "coverage", "report.ts"), 'export const marker = "needle-coverage";\n');
    await fs.mkdir(path.join(base, "node_modules", "left-pad"), { recursive: true });
    await fs.writeFile(path.join(base, "node_modules", "left-pad", "index.ts"), 'export const marker = "needle-vendor";\n');
  }

  it("yields the same entries in the same order on every run", async () => {
    // Determinism is the property a concurrent walk most easily loses, and losing it would make
    // glob_files return a different list each call for an unchanged tree.
    await tree(root);
    const runs: string[][] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const seen: string[] = [];
      for await (const entry of walkWorkspace(root)) seen.push(entry.relative);
      runs.push(seen);
    }
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
    expect(runs[0].length).toBeGreaterThan(70);
  });

  it("finds every match, in a stable order, and never searches generated output", async () => {
    await tree(root);
    // Above the 200 default, so the assertion is about what the search finds rather than where it stops.
    const first = await grepWorkspace(root, "needle-", { maxResults: 1_000 });
    const second = await grepWorkspace(root, "needle-", { maxResults: 1_000 });
    expect(second).toEqual(first);
    expect(first.length).toBe(12 * 6 * 4);
    expect(first.some((match) => match.path.includes("coverage"))).toBe(false);
    expect(first.some((match) => match.path.includes("node_modules"))).toBe(false);
    // Matches from one file stay together and in line order — the concurrent reads are reassembled
    // in walk order, not completion order.
    const firstFile = first.filter((match) => match.path === first[0].path);
    expect(firstFile.map((match) => match.line)).toEqual([...firstFile.map((match) => match.line)].sort((a, b) => a - b));
  });

  it("truncates at maxResults deterministically", async () => {
    await tree(root);
    const limited = await grepWorkspace(root, "needle-", { maxResults: 7 });
    expect(limited).toHaveLength(7);
    expect(limited).toEqual((await grepWorkspace(root, "needle-", { maxResults: 7 })));
    expect(limited).toEqual((await grepWorkspace(root, "needle-", { maxResults: 1_000 })).slice(0, 7));
  });

  it("still matches a regex query, where the byte prefilter cannot help", async () => {
    await tree(root);
    const found = await grepWorkspace(root, "needle-\\d+-[0-5]", { regex: true, maxResults: 1_000 });
    expect(found.length).toBe(12 * 6 * 4);
  });
});
