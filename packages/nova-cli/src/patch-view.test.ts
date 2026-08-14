import { describe, expect, it } from "vitest";
import { ASCII_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import { parsePatch, patchTotals, renderPatch, renderPatchFile } from "./patch-view";
import type { SectionStyle } from "./sections";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const style = (width = 80): SectionStyle => ({ width, depth: "none" });

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1234567..89abcde 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,7 +10,7 @@ export function serve() {
   const app = express();
   app.get("/", handler);
-  app.listen(3000);
+  app.listen(8080);
   return app;
 }
`;

const ADDED = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const answer = 42;
+export const question = "?";
`;

const DELETED = `diff --git a/old.ts b/old.ts
deleted file mode 100644
index 1111111..0000000
--- a/old.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const gone = true;
`;

const RENAMED = `diff --git a/src/before.ts b/src/after.ts
similarity index 100%
rename from src/before.ts
rename to src/after.ts
`;

const BINARY = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;

describe("reading a patch", () => {
  it("names the file and counts only real changes", () => {
    const [file] = parsePatch(MODIFIED);
    expect(file.path).toBe("src/app.ts");
    expect(file.kind).toBe("modified");
    // The `---`/`+++` header lines start with - and + and must not be counted as changes.
    expect({ added: file.added, removed: file.removed }).toEqual({ added: 1, removed: 1 });
  });

  it("keeps the context around a change, which is the point of a diff", () => {
    const [file] = parsePatch(MODIFIED);
    const kinds = file.hunks[0].lines.map((line) => line.kind);
    expect(kinds).toContain("context");
    expect(file.hunks[0].lines.find((line) => line.kind === "add")?.text).toBe('  app.listen(8080);');
  });

  it("reads the hunk's heading and its starting line, so rows can be numbered", () => {
    const [file] = parsePatch(MODIFIED);
    expect(file.hunks[0].heading).toBe("export function serve() {");
    expect(file.hunks[0].newStart).toBe(10);
  });

  it("tells apart the four things that can happen to a file", () => {
    expect(parsePatch(ADDED)[0].kind).toBe("added");
    expect(parsePatch(DELETED)[0].kind).toBe("removed");
    expect(parsePatch(BINARY)[0].kind).toBe("binary");
    const [renamed] = parsePatch(RENAMED);
    expect(renamed).toMatchObject({ kind: "renamed", path: "src/after.ts", previousPath: "src/before.ts" });
  });

  it("reads several files from one patch", () => {
    const files = parsePatch(`${MODIFIED}${ADDED}`);
    expect(files.map((file) => file.path)).toEqual(["src/app.ts", "src/new.ts"]);
    expect(patchTotals(files)).toEqual({ files: 2, added: 3, removed: 1 });
  });

  it("returns nothing for an empty patch rather than a file with no name", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("\n\n")).toEqual([]);
  });

  it("shows a line it cannot classify instead of dropping it", () => {
    const odd = `diff --git a/a.ts b/a.ts\n@@ -1,1 +1,1 @@\nnot a diff line\n`;
    const [file] = parsePatch(odd);
    expect(file.hunks[0].lines).toEqual([{ kind: "context", text: "not a diff line" }]);
  });

  it("ignores the no-newline marker, which is a note about the file and not a line of it", () => {
    const [file] = parsePatch(`${MODIFIED}\\ No newline at end of file\n`);
    expect(file.hunks[0].lines.some((line) => line.text.includes("No newline"))).toBe(false);
  });
});

describe("showing a file's changes", () => {
  it("numbers by the line it will be after the change, and never numbers a removed line", () => {
    const rendered = plain(renderPatchFile(parsePatch(MODIFIED)[0], style()).text);
    const rows = rendered.split("\n").filter((row) => row.includes("app.listen"));
    const removed = rows.find((row) => row.includes("3000"))!;
    const added = rows.find((row) => row.includes("8080"))!;
    expect(removed).toMatch(/^\s*│?\s*-\s/m.test(removed) ? /-/ : /-/);
    // The removed row carries no number; the added row carries the one it lands on.
    expect(/^\s*\|?\s*\d+\s+-/.test(removed.replace("│", "|"))).toBe(false);
    expect(added).toMatch(/\b12\b/);
  });

  it("marks additions and removals distinctly", () => {
    const rendered = plain(renderPatchFile(parsePatch(MODIFIED)[0], style()).text);
    expect(rendered).toMatch(/-\s+app\.listen\(3000\)/);
    expect(rendered).toMatch(/\+\s+app\.listen\(8080\)/);
  });

  it("says what happened to a file with no lines to show", () => {
    expect(plain(renderPatchFile(parsePatch(BINARY)[0], style()).text)).toContain("binary");
    expect(plain(renderPatchFile(parsePatch(RENAMED)[0], style()).text)).toContain("src/after.ts");
  });

  it("names both sides of a rename, so the file can still be found", () => {
    const rendered = plain(renderPatchFile(parsePatch(RENAMED)[0], style()).text);
    expect(rendered).toContain("src/after.ts");
  });

  it("folds a long file and keeps the whole of it for expanding", () => {
    const long = [`diff --git a/big.ts b/big.ts`, `@@ -1,1 +1,40 @@`]
      .concat(Array.from({ length: 40 }, (_unused, index) => `+const value${index} = ${index};`))
      .join("\n");
    const rendered = renderPatchFile(parsePatch(long)[0], style(), { maxLines: 10 });
    expect(rendered.hidden).toBeGreaterThan(0);
    expect(plain(rendered.text)).not.toContain("value39");
    expect(plain(rendered.full)).toContain("value39");
  });

  it("stays inside the terminal at any width", () => {
    for (const width of [40, 80, 120]) {
      const rendered = plain(renderPatchFile(parsePatch(MODIFIED)[0], { width, depth: "none", glyphs: ASCII_GLYPHS }).text);
      for (const line of rendered.split("\n")) expect(visibleWidth(line), `width ${width}`).toBeLessThanOrEqual(width);
    }
  });
});

describe("showing a whole patch", () => {
  it("separates the files and totals them at the end", () => {
    const rendered = plain(renderPatch(`${MODIFIED}${ADDED}`, style()).text);
    expect(rendered).toContain("src/app.ts");
    expect(rendered).toContain("src/new.ts");
    expect(rendered).toContain("2 files");
    expect(rendered).toMatch(/\+3/);
    expect(rendered).toMatch(/-1/);
  });

  it("says plainly that nothing changed rather than drawing an empty frame", () => {
    const rendered = renderPatch("", style());
    expect(plain(rendered.text)).toContain("nothing changed");
    expect(rendered.totals).toEqual({ files: 0, added: 0, removed: 0 });
  });

  it("keeps the patch's own file order, so a second reading finds things where it left them", () => {
    const rendered = renderPatch(`${ADDED}${MODIFIED}`, style());
    expect(rendered.files.map((file) => file.path)).toEqual(["src/new.ts", "src/app.ts"]);
  });
});
