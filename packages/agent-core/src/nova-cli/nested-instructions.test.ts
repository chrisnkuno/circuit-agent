import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { NestedInstructionTracker } from "./nested-instructions";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-nested-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(relativePath: string, content: string): Promise<void> {
  const absolute = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, "utf8");
}

describe("discovering instructions below the root", () => {
  it("finds an instruction file in the directory a touched file lives in", async () => {
    await write("src/api/AGENTS.md", "Use snake_case for API field names.");
    await write("src/api/handler.ts", "export const handler = () => {};");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));

    const found = await tracker.discover("src/api/handler.ts");
    expect(found).toEqual([{ path: "src/api/AGENTS.md", content: "Use snake_case for API field names." }]);
  });

  it("shows every directory in the chain, broad to specific, on the first touch that deep", async () => {
    await write("src/AGENTS.md", "General src rules.");
    await write("src/api/AGENTS.md", "API-specific rules.");
    await write("src/api/v2/handler.ts", "x");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));

    const found = await tracker.discover("src/api/v2/handler.ts");
    expect(found.map((item) => item.path)).toEqual(["src/AGENTS.md", "src/api/AGENTS.md"]);
  });

  it("shows a directory's instructions only once, however many times it is reached again", async () => {
    await write("src/api/AGENTS.md", "API rules.");
    await write("src/api/a.ts", "a");
    await write("src/api/b.ts", "b");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));

    expect(await tracker.discover("src/api/a.ts")).toHaveLength(1);
    // A second file in the same already-shown directory finds nothing new.
    expect(await tracker.discover("src/api/b.ts")).toHaveLength(0);
    // Reaching the exact same file again is equally silent.
    expect(await tracker.discover("src/api/a.ts")).toHaveLength(0);
  });

  it("does not re-show a shared ancestor once a sibling directory has already surfaced it", async () => {
    await write("src/AGENTS.md", "shared");
    await write("src/api/x.ts", "x");
    await write("src/web/y.ts", "y");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));

    expect((await tracker.discover("src/api/x.ts")).map((item) => item.path)).toEqual(["src/AGENTS.md"]);
    // src/ was already shown while descending into api/; web/ only adds what's new about itself.
    expect(await tracker.discover("src/web/y.ts")).toEqual([]);
  });

  it("finds nothing when there is nothing to find, without error", async () => {
    await write("src/plain/file.ts", "x");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    expect(await tracker.discover("src/plain/file.ts")).toEqual([]);
  });

  it("never surfaces anything at or above the workspace root — that is the static chain's territory", async () => {
    await write("AGENTS.md", "root-level instructions, already in the system prompt");
    await write("src/file.ts", "x");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    const found = await tracker.discover("src/file.ts");
    expect(found.some((item) => item.path === "AGENTS.md")).toBe(false);
  });

  it("respects the same one-file-per-directory precedence collectProjectContext uses", async () => {
    // AGENTS.override.md outranks NOVA.md outranks AGENTS.md — only the highest-precedence file
    // present in a directory is shown, not all of them.
    await write("src/api/AGENTS.md", "lowest precedence, should not appear");
    await write("src/api/NOVA.md", "should win");
    await write("src/api/file.ts", "x");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    const found = await tracker.discover("src/api/file.ts");
    expect(found).toHaveLength(1);
    expect(found[0].content).toBe("should win");
  });

  it("accepts a directory path directly, for list/glob-style callers", async () => {
    await write("src/api/AGENTS.md", "api rules");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    const found = await tracker.discover("src/api");
    expect(found.map((item) => item.path)).toEqual(["src/api/AGENTS.md"]);
  });

  it("does not throw when the touched path does not exist yet, and still finds ancestor instructions", async () => {
    // write_file's target does not exist until after the write — discovery still has to work for
    // a file that is about to be created, not only one already on disk.
    await write("src/api/AGENTS.md", "api rules");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    const found = await tracker.discover("src/api/not-yet-created.ts");
    expect(found.map((item) => item.path)).toEqual(["src/api/AGENTS.md"]);
  });

  it("tracks what has been discovered, for inspection", async () => {
    await write("src/api/AGENTS.md", "x");
    await write("src/api/file.ts", "x");
    const tracker = new NestedInstructionTracker(new LocalWorkspace(root));
    await tracker.discover("src/api/file.ts");
    expect(tracker.discovered).toEqual(["src", "src/api"]);
  });
});

describe("rendering discovered instructions into a tool result", () => {
  it("renders nothing for an empty list", () => {
    expect(NestedInstructionTracker.render([])).toBe("");
  });

  it("labels each block with its path and separates it clearly from the tool's own output", () => {
    const rendered = NestedInstructionTracker.render([{ path: "src/api/AGENTS.md", content: "Use snake_case." }]);
    expect(rendered).toContain("src/api/AGENTS.md");
    expect(rendered).toContain("Use snake_case.");
    expect(rendered.startsWith("\n\n")).toBe(true); // never fused onto the preceding line
  });
});
