import { describe, expect, it } from "vitest";
import { ancestorsOf, buildFileTree, describeFolder, searchFiles } from "./files";

const PATHS = ["src/index.ts", "src/deep/util.ts", "src/deep/other.ts", "docs/guide.md", "README.md"];
const tree = buildFileTree(PATHS);

describe("searchFiles", () => {
  it("finds a file however deep it sits, and reports its full path", () => {
    expect(searchFiles(tree, "util").map((match) => match.path)).toEqual(["src/deep/util.ts"]);
  });

  it("matches case-insensitively", () => {
    expect(searchFiles(tree, "readme").map((match) => match.path)).toEqual(["README.md"]);
  });

  it("matches on the path, so a folder name narrows the search", () => {
    expect(searchFiles(tree, "deep/").map((match) => match.path).sort())
      .toEqual(["src/deep/other.ts", "src/deep/util.ts"]);
  });

  it("never returns a folder, since the panel exists to pick a file", () => {
    // "deep" matches both files under deep/ by path, but deep/ itself must not be offered.
    for (const match of searchFiles(tree, "deep")) expect(match.node.kind).toBe("file");
  });

  it("returns nothing for an empty or whitespace query rather than everything", () => {
    expect(searchFiles(tree, "")).toEqual([]);
    expect(searchFiles(tree, "   ")).toEqual([]);
  });

  it("caps its results rather than rendering an entire large repository", () => {
    const many = buildFileTree(Array.from({ length: 500 }, (_unused, index) => `src/file${index}.ts`));
    expect(searchFiles(many, "file", 50)).toHaveLength(50);
  });
});

describe("ancestorsOf", () => {
  it("lists every folder that has to be open for a file to be visible", () => {
    expect(ancestorsOf("src/deep/util.ts")).toEqual(["src", "src/deep"]);
  });

  it("returns nothing for a file at the root, which needs nothing expanded", () => {
    expect(ancestorsOf("README.md")).toEqual([]);
  });
});

describe("describeFolder", () => {
  it("counts nested contents, and gets the singulars right", () => {
    const src = tree.find((node) => node.name === "src")!;
    expect(describeFolder(src)).toBe("1 folder, 3 files");
    const docs = tree.find((node) => node.name === "docs")!;
    expect(describeFolder(docs)).toBe("1 file");
  });
});
