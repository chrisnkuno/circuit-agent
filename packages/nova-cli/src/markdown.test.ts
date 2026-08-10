import { describe, expect, it } from "vitest";
import { newMarkdownState, parseInline, renderMarkdown, renderMarkdownLine, visibleWidth, wrapTokens } from "./markdown";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

describe("visibleWidth", () => {
  it("ignores escape codes, which occupy no columns", () => {
    expect(visibleWidth("\x1b[1mbold\x1b[0m")).toBe(4);
    expect(visibleWidth("plain")).toBe(5);
  });

  it("counts CJK and emoji as the two columns they actually occupy", () => {
    // Counting these as one is exactly what leaves a box border a character short of its corner.
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("✦")).toBe(1);
    expect(visibleWidth("🚀")).toBe(2);
  });

  it("gives combining marks no width of their own", () => {
    expect(visibleWidth("é")).toBe(1);
  });
});

describe("parseInline", () => {
  it("styles code spans, bold and italic, keeping the plain text between them", () => {
    expect(parseInline("run `npm test` when **done**").map((token) => token.text))
      .toEqual(["run ", "npm test", " when ", "done"]);
  });

  it("leaves markdown characters inside a code span literal", () => {
    // A coding agent quotes globs and pointers constantly; `**/*.ts` must survive intact.
    const tokens = parseInline("match `**/*.ts` exactly");
    expect(tokens.map((token) => token.text)).toEqual(["match ", "**/*.ts", " exactly"]);
  });

  it("reads both asterisk and underscore emphasis", () => {
    expect(parseInline("__strong__ and _soft_").map((token) => token.text)).toEqual(["strong", " and ", "soft"]);
  });

  it("formats links, images, autolinks and strikethrough without raw markdown punctuation", () => {
    const text = parseInline("See [docs](https://example.com), ![chart](https://example.com/chart.png), <https://openai.com> and ~~old~~.")
      .map((token) => token.text).join("");
    expect(text).toContain("docs (https://example.com)");
    expect(text).toContain("image: chart (https://example.com/chart.png)");
    expect(text).toContain("https://openai.com");
    expect(text).toContain("old");
    expect(text).not.toContain("~~");
  });

  it("keeps escaped markdown markers literal", () => {
    expect(parseInline(String.raw`\*not italic\* and \[not a link\]`).map((token) => token.text).join(""))
      .toBe("*not italic* and [not a link]");
  });

  it("leaves an unclosed marker alone rather than swallowing the rest of the line", () => {
    expect(parseInline("a ** dangling").map((token) => token.text)).toEqual(["a ** dangling"]);
  });

  it("drops nothing: the styled runs reassemble into the original text", () => {
    const line = "call `read_file` then **verify** it";
    expect(parseInline(line).map((token) => token.text).join("")).toBe("call read_file then verify it");
  });
});

describe("wrapTokens", () => {
  const tokens = (text: string) => [{ text, code: "" }];

  it("wraps at the width and never exceeds it", () => {
    const lines = wrapTokens(tokens("the quick brown fox jumps over the lazy dog"), 12, { depth: "none" });
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
    expect(lines.join(" ")).toContain("quick");
  });

  it("keeps a hanging indent under a list marker", () => {
    const lines = wrapTokens(tokens("alpha beta gamma delta"), 12, {
      firstPrefix: "• ", continuationPrefix: "  ", depth: "none",
    });
    expect(lines[0].startsWith("• ")).toBe(true);
    for (const line of lines.slice(1)) expect(line.startsWith("  ")).toBe(true);
  });

  it("breaks a word longer than the terminal instead of letting it overflow", () => {
    const lines = wrapTokens(tokens("x".repeat(30)), 10, { depth: "none" });
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    expect(lines.join("")).toBe("x".repeat(30));
  });

  it("leaves no trailing whitespace at a wrap point", () => {
    const lines = wrapTokens(tokens("alpha beta gamma delta epsilon"), 12, { depth: "none" });
    for (const line of lines) expect(line).toBe(line.replace(/\s+$/, ""));
  });

  it("paints each word so emphasis survives being wrapped across lines", () => {
    const lines = wrapTokens([{ text: "alpha beta gamma", code: "\x1b[1m" }], 8, { depth: "truecolor" });
    expect(lines.length).toBeGreaterThan(1);
    // Every line carries its own opening escape; none inherits one from the line above.
    for (const line of lines) expect(line).toContain("\x1b[1m");
  });

  it("emits no escape codes at all when colour is unwanted", () => {
    const lines = wrapTokens([{ text: "alpha beta", code: "\x1b[1m" }], 40, { depth: "none" });
    expect(lines.join("\n")).not.toMatch(/\x1b/);
  });

  it("returns a single empty line for empty input rather than nothing", () => {
    expect(wrapTokens([], 40, { depth: "none" })).toEqual([""]);
  });

  it("survives a width smaller than its own prefix without looping forever", () => {
    const lines = wrapTokens(tokens("alpha beta"), 2, { firstPrefix: "    ", continuationPrefix: "    ", depth: "none" });
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("renderMarkdownLine", () => {
  const options = { width: 60, depth: "none" as const };
  const render = (line: string, state = newMarkdownState()) => renderMarkdownLine(line, state, options);

  it("strips the hashes from a heading and leaves the text", () => {
    expect(render("## What changed")).toEqual(["What changed"]);
    expect(render("#### Deeper")).toEqual(["Deeper"]);
  });

  it("turns a dash bullet into a real bullet glyph", () => {
    expect(render("- first item")).toEqual(["• first item"]);
    expect(render("  * nested item")).toEqual(["  • nested item"]);
  });

  it("renders task-list controls distinctly", () => {
    expect(render("- [ ] pending")).toEqual(["☐ pending"]);
    expect(render("- [x] complete")).toEqual(["☑ complete"]);
  });

  it("renders pipe tables as aligned terminal rows and separators", () => {
    const rows = [render("| Name | Status |"), render("| --- | :---: |"), render("| API | ready |")].flat();
    expect(rows[0]).toMatch(/^│.*Name.*│.*Status.*│$/);
    expect(rows[1]).toMatch(/^├─+┼─+┤$/);
    expect(new Set(rows.map(visibleWidth)).size).toBe(1);
  });

  it("keeps a numbered list's own numbering", () => {
    expect(render("1. first")).toEqual(["1. first"]);
    expect(render("2) second")).toEqual(["2) second"]);
  });

  it("marks a blockquote with a gutter instead of a stray angle bracket", () => {
    expect(render("> quoted text")).toEqual(["│ quoted text"]);
  });

  it("draws a horizontal rule rather than printing three dashes", () => {
    const [rule] = render("---");
    expect(rule).toMatch(/^\s*─+$/);
  });

  it("keeps a blank line blank", () => {
    expect(render("")).toEqual([""]);
  });

  it("opens and closes a fence, and gutters the code between them verbatim", () => {
    const state = newMarkdownState();
    const open = renderMarkdownLine("```python", state, options);
    expect(state.inFence).toBe(true);
    expect(open[0]).toContain("python");

    // Inside a fence nothing is interpreted: this line is code, not a bullet and not emphasis.
    const code = renderMarkdownLine("  - x = **2**", state, options);
    expect(plain(code[0])).toBe("  │   - x = **2**");

    renderMarkdownLine("```", state, options);
    expect(state.inFence).toBe(false);
  });

  it("never re-wraps code, because a broken line of code misstates the file", () => {
    const state = newMarkdownState();
    renderMarkdownLine("```", state, options);
    const long = "x".repeat(200);
    expect(renderMarkdownLine(long, state, { width: 40, depth: "none" })).toHaveLength(1);
  });

  it("wraps ordinary prose to the width, with no line over it", () => {
    const lines = render("the quick brown fox jumps over the lazy dog and keeps on running past the end");
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
  });
});

describe("renderMarkdown", () => {
  it("renders a whole answer, carrying fence state across its lines", () => {
    const source = ["# Result", "", "Changed `port` to **8080**.", "", "```ts", "const port = 8080;", "```", "", "- verified with npm test"].join("\n");
    const rendered = plain(renderMarkdown(source, { width: 60, depth: "none" }));

    expect(rendered).toContain("Result");
    expect(rendered).not.toContain("# Result"); // the hash is consumed, not printed
    expect(rendered).toContain("Changed port to 8080.");
    expect(rendered).toContain("│ const port = 8080;"); // gutter, and the code kept verbatim
    expect(rendered).toContain("• verified with npm test");
  });

  it("visually closes an incomplete code fence at the end of an answer", () => {
    const rendered = renderMarkdown("```ts\nconst x = 1;", { width: 60, depth: "none" });
    expect(rendered).toContain("╭─ ts");
    expect(rendered).toContain("╰────");
  });

  it("emits colour when asked, and none when not", () => {
    const source = "**bold** and `code`";
    expect(renderMarkdown(source, { width: 60, depth: "truecolor" })).toMatch(/\x1b\[/);
    expect(renderMarkdown(source, { width: 60, depth: "none" })).not.toMatch(/\x1b\[/);
  });
});
