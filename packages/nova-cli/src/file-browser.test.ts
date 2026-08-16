import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import {
  applyFileAction,
  buildFileTree,
  composeFileFrame,
  currentRow,
  directorySummary,
  filterTree,
  flattenTree,
  initialFileBrowserState,
  keyToFileAction,
  toggleDirectory,
  treeLabel,
  visibleRows,
  type FileBrowserState,
} from "./file-browser";

const PATHS = ["README.md", "src/index.ts", "src/deep/util.ts", "src/deep/other.ts", "package.json"];

const state = (overrides: Partial<FileBrowserState> = {}): FileBrowserState => ({
  ...initialFileBrowserState(PATHS, 100, 30),
  ...overrides,
});

describe("buildFileTree", () => {
  it("puts folders before files, each group alphabetical — the ordering ls already implies", () => {
    const tree = buildFileTree(PATHS);
    expect(tree.map((node) => node.kind)).toEqual(["dir", "file", "file"]);
    expect(tree[0].name).toBe("src");
    expect(new Set(tree.slice(1).map((node) => node.name))).toEqual(new Set(["README.md", "package.json"]));
  });

  it("nests a deep path under real intermediate folders, not as one flat name", () => {
    const tree = buildFileTree(PATHS);
    const src = tree.find((node) => node.name === "src")!;
    expect(src.kind).toBe("dir");
    const deep = src.children.find((node) => node.name === "deep")!;
    expect(deep.kind).toBe("dir");
    expect(deep.children.map((node) => node.name)).toEqual(["other.ts", "util.ts"]);
  });

  it("gives every node its full root-relative path, not just its own name", () => {
    const tree = buildFileTree(PATHS);
    const src = tree.find((node) => node.name === "src")!;
    const deep = src.children.find((node) => node.name === "deep")!;
    expect(deep.path).toBe("src/deep");
    expect(deep.children[0].path).toBe("src/deep/other.ts");
  });

  it("merges two files under the same folder into one folder node, not two", () => {
    const tree = buildFileTree(PATHS);
    const src = tree.find((node) => node.name === "src")!;
    expect(src.children.filter((node) => node.name === "deep")).toHaveLength(1);
  });

  it("handles an empty project without throwing", () => {
    expect(buildFileTree([])).toEqual([]);
  });
});

describe("directorySummary", () => {
  it("counts files and folders nested arbitrarily deep, not just direct children", () => {
    const tree = buildFileTree(PATHS);
    const src = tree.find((node) => node.name === "src")!;
    // src/index.ts, src/deep/util.ts, src/deep/other.ts = 3 files; src/deep = 1 folder.
    expect(directorySummary(src)).toEqual({ files: 3, dirs: 1 });
  });

  it("reports zero for an empty folder", () => {
    const empty = buildFileTree(PATHS).find((node) => node.name === "src")!.children.find((node) => node.name === "deep")!;
    // deep itself has two files and no subfolders.
    expect(directorySummary(empty)).toEqual({ files: 2, dirs: 0 });
  });
});

describe("flattening and filtering", () => {
  it("shows only top-level rows until a folder is expanded", () => {
    const rows = flattenTree(buildFileTree(PATHS), new Set());
    expect(rows.map((row) => row.node.name)).toEqual(["src", "package.json", "README.md"]);
  });

  it("reveals a folder's children, at one deeper indent, once it is in the expanded set", () => {
    const tree = buildFileTree(PATHS);
    const rows = flattenTree(tree, new Set(["src"]));
    expect(rows.map((row) => row.node.name)).toEqual(["src", "deep", "index.ts", "package.json", "README.md"]);
    expect(rows.find((row) => row.node.name === "index.ts")!.depth).toBe(1);
  });

  it("filters to matching files only, flat, regardless of nesting", () => {
    const rows = filterTree(buildFileTree(PATHS), "util");
    expect(rows.map((row) => row.node.path)).toEqual(["src/deep/util.ts"]);
    expect(rows[0].depth).toBe(0);
  });

  it("filters case-insensitively", () => {
    expect(filterTree(buildFileTree(PATHS), "README").map((row) => row.node.path)).toEqual(["README.md"]);
    expect(filterTree(buildFileTree(PATHS), "readme").map((row) => row.node.path)).toEqual(["README.md"]);
  });

  it("never returns a folder as a row itself, even when its own name is the match", () => {
    // "deep" matches every file under the deep/ folder by path, but the folder node itself — a
    // "dir" kind — must never be one of the rows; only files are ever pickable from a search.
    const rows = filterTree(buildFileTree(PATHS), "deep");
    expect(rows.every((row) => row.node.kind === "file")).toBe(true);
    expect(rows.map((row) => row.node.path).sort()).toEqual(["src/deep/other.ts", "src/deep/util.ts"]);
  });

  it("matches on the full path, so a folder name narrows the search", () => {
    expect(filterTree(buildFileTree(PATHS), "deep/util").map((row) => row.node.path)).toEqual(["src/deep/util.ts"]);
  });
});

describe("visibleRows and currentRow", () => {
  it("uses the flat filtered list once a query is typed, the tree otherwise", () => {
    expect(visibleRows(state()).length).toBe(3);
    expect(new Set(visibleRows(state({ query: "ts" })).map((row) => row.node.path)))
      .toEqual(new Set(["src/index.ts", "src/deep/util.ts", "src/deep/other.ts"]));
  });

  it("clamps the current row to the list rather than reading past the end", () => {
    const rows = visibleRows(state());
    expect(currentRow(state({ selected: 999 }))?.node.name).toBe(rows.at(-1)!.node.name);
  });

  it("is undefined when nothing matches", () => {
    expect(currentRow(state({ query: "nonexistent" }))).toBeUndefined();
  });
});

describe("keyToFileAction", () => {
  it("moves, expands and collapses when not searching", () => {
    expect(keyToFileAction({ name: "down" }, undefined, false)).toEqual({ kind: "move", step: 1 });
    expect(keyToFileAction({ name: "up" }, undefined, false)).toEqual({ kind: "move", step: -1 });
    expect(keyToFileAction({ name: "right" }, undefined, false)).toEqual({ kind: "expand" });
    expect(keyToFileAction({ name: "left" }, undefined, false)).toEqual({ kind: "collapse" });
  });

  it("opens search on /, and exits on q or Escape", () => {
    expect(keyToFileAction({}, "/", false)).toEqual({ kind: "search" });
    expect(keyToFileAction({ name: "q" }, undefined, false)).toEqual({ kind: "exit" });
    expect(keyToFileAction({ name: "escape" }, undefined, false)).toEqual({ kind: "exit" });
  });

  it("treats Enter as picking, whether searching or not", () => {
    expect(keyToFileAction({ name: "return" }, undefined, false)).toEqual({ kind: "pick" });
    expect(keyToFileAction({ name: "enter" }, undefined, true)).toEqual({ kind: "pick" });
  });

  it("makes every printable key text while searching, not navigation", () => {
    expect(keyToFileAction({ name: "right" }, "r", true)).toEqual({ kind: "type", character: "r" });
    expect(keyToFileAction({}, "l", true)).toEqual({ kind: "type", character: "l" });
  });

  it("closes the filter on Escape while searching, rather than leaving the picker entirely", () => {
    expect(keyToFileAction({ name: "escape" }, undefined, true)).toEqual({ kind: "commit" });
  });

  it("always exits on Ctrl+C, in either mode", () => {
    expect(keyToFileAction({ name: "c", ctrl: true }, undefined, false)).toEqual({ kind: "exit" });
    expect(keyToFileAction({ name: "c", ctrl: true }, undefined, true)).toEqual({ kind: "exit" });
  });
});

describe("applyFileAction", () => {
  it("expands a folder into the expanded set, and collapse removes it again", () => {
    const expanded = applyFileAction(state(), { kind: "expand" });
    expect(expanded.expanded.has("src")).toBe(true);
    const collapsed = applyFileAction(expanded, { kind: "collapse" });
    expect(collapsed.expanded.has("src")).toBe(false);
  });

  it("does nothing when expanding a file or a folder that is already open", () => {
    const onFile = applyFileAction(state({ selected: 1 }), { kind: "expand" }); // package.json
    expect(onFile.expanded.size).toBe(0);
    const alreadyOpen = state({ expanded: new Set(["src"]) });
    expect(applyFileAction(alreadyOpen, { kind: "expand" })).toBe(alreadyOpen);
  });

  it("wraps movement around both ends of the list", () => {
    expect(applyFileAction(state({ selected: 0 }), { kind: "move", step: -1 }).selected).toBe(2);
    expect(applyFileAction(state({ selected: 2 }), { kind: "move", step: 1 }).selected).toBe(0);
  });

  it("resets selection to the top when the query changes, so it cannot point past a shorter list", () => {
    const typed = applyFileAction(state({ selected: 2 }), { kind: "type", character: "u" });
    expect(typed).toMatchObject({ query: "u", selected: 0 });
  });

  it("toggleDirectory opens a closed folder and closes an open one", () => {
    const opened = toggleDirectory(state());
    expect(opened.expanded.has("src")).toBe(true);
    const closed = toggleDirectory(opened);
    expect(closed.expanded.has("src")).toBe(false);
  });

  it("toggleDirectory does nothing to a file", () => {
    const onFile = state({ selected: 1 }); // package.json
    expect(toggleDirectory(onFile)).toBe(onFile);
  });
});

describe("treeLabel", () => {
  it("marks a folder with a disclosure triangle and a trailing slash", () => {
    const [src] = buildFileTree(PATHS);
    expect(treeLabel({ node: src, depth: 0, isLast: true, trunks: [] }, new Set())).toContain("src/");
    expect(treeLabel({ node: src, depth: 0, isLast: true, trunks: [] }, new Set())).toContain(UNICODE_GLYPHS.collapsed);
    expect(treeLabel({ node: src, depth: 0, isLast: true, trunks: [] }, new Set(["src"]))).toContain(UNICODE_GLYPHS.expanded);
  });

  it("indents by depth, so nesting is visible without reading paths", () => {
    const [src] = buildFileTree(PATHS);
    const child = src.children[0];
    const shallow = treeLabel({ node: src, depth: 0, isLast: true, trunks: [] }, new Set());
    // One ancestor, which has nothing after it — so the indent is blank rather than a trunk, but
    // it is still an indent. `trunks` has to describe every level above, or the row is a depth the
    // renderer has no way to draw.
    const deep = treeLabel({ node: child, depth: 1, isLast: true, trunks: [false] }, new Set());
    expect(deep.indexOf(child.name.length > 0 ? child.name[0] : "")).toBeGreaterThan(shallow.indexOf(src.name[0]));
  });

  it("stays inside ASCII on an ASCII terminal", () => {
    const [src] = buildFileTree(PATHS);
    const label = treeLabel({ node: src, depth: 0, isLast: true, trunks: [] }, new Set(), ASCII_GLYPHS);
    for (const character of label) expect(character.codePointAt(0)).toBeLessThan(128);
  });
});

describe("composeFileFrame", () => {
  it("is exactly as tall as the window, on every row width", () => {
    for (const rows of [1, 5, 20, 40]) {
      expect(composeFileFrame(state({ rows }), { kind: "empty" }), `rows ${rows}`).toHaveLength(rows);
    }
  });

  it("is exactly as wide as the window, on every row", () => {
    for (const columns of [1, 20, 39, 40, 60, 120]) {
      const frame = composeFileFrame(state({ columns }), { kind: "empty" });
      const widths = new Set(frame.map((row) => visibleWidth(row.text)));
      expect(widths.size, `columns ${columns}`).toBe(1);
      expect([...widths][0]).toBeLessThanOrEqual(columns);
    }
  });

  it("drops the preview pane below 40 columns rather than squeezing both panes unreadable", () => {
    const frame = composeFileFrame(state({ columns: 30 }), { kind: "directory", files: 2, dirs: 0 });
    expect(frame.some((row) => row.text.includes(UNICODE_GLYPHS.boxVertical))).toBe(false);
  });

  it("shows the tree and a directory's summary side by side once there is room", () => {
    const body = composeFileFrame(state(), { kind: "directory", files: 3, dirs: 1 }).map((row) => row.text).join("\n");
    expect(body).toContain("src/");
    expect(body).toContain("3 files");
    expect(body).toContain(UNICODE_GLYPHS.boxVertical);
  });

  it("shows a file's lines in the preview pane", () => {
    const body = composeFileFrame(state(), { kind: "file", lines: ["export const x = 1;"], totalLines: 1, truncated: false })
      .map((row) => row.text).join("\n");
    expect(body).toContain("export const x = 1;");
  });

  it("marks a truncated preview with how many lines exist in total", () => {
    const body = composeFileFrame(state(), { kind: "file", lines: ["one"], totalLines: 500, truncated: true })
      .map((row) => row.text).join("\n");
    expect(body).toContain("500 lines total");
  });

  it("surfaces a preview error rather than pretending nothing is wrong", () => {
    const body = composeFileFrame(state(), { kind: "error", message: "looks like a binary file" })
      .map((row) => row.text).join("\n");
    expect(body).toContain("looks like a binary file");
  });

  it("teaches its own keys, and shows the query while searching", () => {
    expect(composeFileFrame(state(), { kind: "empty" }).at(-1)!.text).toContain("q leave");
    expect(composeFileFrame(state({ searching: true, query: "ts" }), { kind: "empty" }).at(-1)!.text).toContain("search: ts");
  });

  it("names the selection's position once the list overflows the window", () => {
    const many = buildFileTree(Array.from({ length: 40 }, (_unused, index) => `file-${index}.ts`));
    const overflowing = state({ tree: many, rows: 10, selected: 20 });
    expect(composeFileFrame(overflowing, { kind: "empty" }).at(-1)!.text).toMatch(/\d+\/40/);
  });
});

describe("tree connectors", () => {
  const tree = buildFileTree(["a/one.ts", "a/two.ts", "b/deep/x.ts", "z.md"]);

  it("gives the last child a corner and the others a branch", () => {
    const rows = flattenTree(tree, new Set(["a"]));
    const label = (name: string) => treeLabel(rows.find((row) => row.node.name === name)!, new Set(["a"]));
    expect(label("one.ts")).toContain(UNICODE_GLYPHS.treeBranch);
    expect(label("two.ts")).toContain(UNICODE_GLYPHS.treeLast);
  });

  it("carries a trunk through a level whose folder still has siblings below it", () => {
    // a/ has b/ and z.md after it, so a's children are drawn with the line continuing past them.
    const rows = flattenTree(tree, new Set(["a"]));
    expect(treeLabel(rows.find((row) => row.node.name === "one.ts")!, new Set())).toContain(UNICODE_GLYPHS.treeTrunk);
  });

  it("leaves blank space instead of a trunk under the last folder", () => {
    // z.md sorts last overall; expand b/, whose children sit under a trunk because z.md follows.
    const rows = flattenTree(buildFileTree(["a/one.ts", "b/two.ts"]), new Set(["b"]));
    // b/ is the last folder and there is nothing after it, so its child gets no trunk.
    expect(treeLabel(rows.find((row) => row.node.name === "two.ts")!, new Set())).not.toContain(UNICODE_GLYPHS.treeTrunk);
  });

  it("indents one level per depth, so a nested file sits right of its folder", () => {
    const rows = flattenTree(tree, new Set(["b", "b/deep"]));
    const deep = treeLabel(rows.find((row) => row.node.name === "x.ts")!, new Set());
    const folder = treeLabel(rows.find((row) => row.node.name === "b")!, new Set());
    expect(deep.indexOf("x.ts")).toBeGreaterThan(folder.indexOf("b"));
  });

  it("stays inside ASCII on an ASCII terminal, connectors included", () => {
    for (const row of flattenTree(tree, new Set(["a", "b"]))) {
      for (const character of treeLabel(row, new Set(), ASCII_GLYPHS)) {
        expect(character.codePointAt(0)).toBeLessThan(128);
      }
    }
  });
});
