import { describe, expect, it } from "vitest";
import { buildFileTree, directorySummary } from "./file-tree";

const PATHS = ["README.md", "src/index.ts", "src/deep/util.ts", "src/deep/other.ts", "package.json"];

describe("buildFileTree", () => {
  it("puts folders before files, each group alphabetical", () => {
    const tree = buildFileTree(PATHS);
    expect(tree.map((node) => node.kind)).toEqual(["dir", "file", "file"]);
    expect(tree[0].name).toBe("src");
  });

  it("nests a deep path under real intermediate folders, not one flat name", () => {
    const src = buildFileTree(PATHS).find((node) => node.name === "src")!;
    const deep = src.children.find((node) => node.name === "deep")!;
    expect(deep.kind).toBe("dir");
    expect(deep.path).toBe("src/deep");
    expect(deep.children.map((node) => node.name)).toEqual(["other.ts", "util.ts"]);
  });

  it("merges siblings into one folder node rather than one per file", () => {
    const src = buildFileTree(PATHS).find((node) => node.name === "src")!;
    expect(src.children.filter((node) => node.name === "deep")).toHaveLength(1);
  });

  it("handles an empty project, and ignores empty path segments", () => {
    expect(buildFileTree([])).toEqual([]);
    // A doubled slash is a path with an empty segment, not a folder called "" — the collapsed
    // form is what every backend's glob would have returned in the first place.
    const collapsed = buildFileTree(["a//b.ts"]);
    expect(collapsed[0].name).toBe("a");
    expect(collapsed[0].children[0].path).toBe("a/b.ts");
  });
});

describe("directorySummary", () => {
  it("counts nested contents, not just direct children", () => {
    const src = buildFileTree(PATHS).find((node) => node.name === "src")!;
    expect(directorySummary(src)).toEqual({ files: 3, dirs: 1 });
  });
});
