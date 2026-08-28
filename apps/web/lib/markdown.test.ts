import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "./markdown";

describe("chat markdown", () => {
  it("keeps a fenced code block intact, with its language and inner blank lines", () => {
    const [block] = parseMarkdown("```python\ndef add(a, b):\n\n    return a + b\n```");
    expect(block).toEqual({ type: "code", language: "python", text: "def add(a, b):\n\n    return a + b" });
  });

  it("renders an unterminated fence as code rather than backticks", () => {
    const [block] = parseMarkdown("```js\nconst x = 1;");
    expect(block).toMatchObject({ type: "code", text: "const x = 1;" });
  });

  it("never lets markup inside a code span be reinterpreted", () => {
    expect(parseInline("use `**not bold**` here")).toEqual([
      { type: "text", text: "use " },
      { type: "code", text: "**not bold**" },
      { type: "text", text: " here" },
    ]);
  });

  it("parses emphasis, links, and bare URLs", () => {
    expect(parseInline("**bold** and *soft* and [docs](https://example.com)")).toEqual([
      { type: "strong", text: "bold" },
      { type: "text", text: " and " },
      { type: "em", text: "soft" },
      { type: "text", text: " and " },
      { type: "link", text: "docs", href: "https://example.com" },
    ]);
    expect(parseInline("see https://example.com/x")).toEqual([
      { type: "text", text: "see " },
      { type: "link", text: "https://example.com/x", href: "https://example.com/x" },
    ]);
  });

  it("groups consecutive list items into one list and separates the two kinds", () => {
    const blocks = parseMarkdown("- one\n- two\n\n1. first\n2. second");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ type: "list", ordered: false });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[1]).toMatchObject({ type: "list", ordered: true });
  });

  it("reads headings, quotes, and rules", () => {
    const blocks = parseMarkdown("## Title\n\n> quoted\n\n---");
    expect(blocks[0]).toMatchObject({ type: "heading", level: 2 });
    expect(blocks[1]).toMatchObject({ type: "quote" });
    expect(blocks[2]).toEqual({ type: "rule" });
  });

  it("joins wrapped lines into one paragraph and splits on blank lines", () => {
    const blocks = parseMarkdown("first line\nstill first\n\nsecond");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: "paragraph", spans: [{ type: "text", text: "first line still first" }] });
  });

  it("loses no plain text, which is what most replies are", () => {
    const text = "Nothing special here at all.";
    expect(parseMarkdown(text)).toEqual([{ type: "paragraph", spans: [{ type: "text", text }] }]);
    expect(parseMarkdown("")).toEqual([]);
  });
});

describe("headings deeper than the bubble can style", () => {
  it("still reads as a heading rather than printing its hashes", () => {
    // A model writing #### means a heading; rendering "#### Notes" verbatim is the bug.
    for (const [hashes, expected] of [["#", 1], ["##", 2], ["###", 3], ["####", 3], ["######", 3]] as const) {
      const blocks = parseMarkdown(`${hashes} Notes`);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ type: "heading", level: expected });
      expect(blocks[0]).toMatchObject({ spans: [{ type: "text", text: "Notes" }] });
    }
  });

  it("leaves a bare hash with no text as ordinary prose", () => {
    expect(parseMarkdown("#hashtag")[0]).toMatchObject({ type: "paragraph" });
  });
});
