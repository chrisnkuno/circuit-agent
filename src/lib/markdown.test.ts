import { describe, expect, it } from "vitest";
import { isSafeHref, parseInline, parseMarkdown, type Block, type Inline } from "./markdown";

/** Flattens a tree back to its visible text, which is what a reader actually sees. */
function textOf(nodes: readonly Inline[]): string {
  return nodes.map((node) => (node.kind === "text" || node.kind === "code" ? node.text : textOf(node.children))).join("");
}

const kinds = (blocks: readonly Block[]) => blocks.map((block) => block.kind);

describe("inline markdown", () => {
  it("marks up bold, italic, code and links", () => {
    expect(parseInline("**bold**")).toEqual([{ kind: "strong", children: [{ kind: "text", text: "bold" }] }]);
    expect(parseInline("_soft_")).toEqual([{ kind: "em", children: [{ kind: "text", text: "soft" }] }]);
    expect(parseInline("`x = 1`")).toEqual([{ kind: "code", text: "x = 1" }]);
    expect(parseInline("[docs](https://example.com)")).toEqual([
      { kind: "link", href: "https://example.com", children: [{ kind: "text", text: "docs" }] },
    ]);
  });

  /**
   * The precedence rule that matters most. Scanning emphasis before code spans is the single most
   * common way a hand-rolled renderer mangles code — `**kwargs` in a code span is not bold.
   */
  it("never re-interprets the inside of a code span", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ kind: "code", text: "**not bold**" }]);
    expect(parseInline("use `_x_` here")).toEqual([
      { kind: "text", text: "use " },
      { kind: "code", text: "_x_" },
      { kind: "text", text: " here" },
    ]);
  });

  it("prefers bold over italic, so ** is not two empty italics", () => {
    expect(parseInline("**x**")).toEqual([{ kind: "strong", children: [{ kind: "text", text: "x" }] }]);
  });

  it("keeps surrounding text, in order", () => {
    const nodes = parseInline("a **b** c `d` e");
    expect(textOf(nodes)).toBe("a b c d e");
    expect(nodes.map((node) => node.kind)).toEqual(["text", "strong", "text", "code", "text"]);
  });

  it("leaves plain text entirely alone", () => {
    expect(parseInline("nothing special here")).toEqual([{ kind: "text", text: "nothing special here" }]);
    // An unmatched marker is literal, not the start of emphasis that never ends.
    expect(textOf(parseInline("2 * 3 * 4"))).toBe("2 * 3 * 4");
  });

  it("nests emphasis inside a link label", () => {
    const [link] = parseInline("[**bold** link](https://example.com)");
    expect(link.kind).toBe("link");
    expect(textOf([link])).toBe("bold link");
  });
});

describe("block markdown", () => {
  it("parses the constructs an answer actually contains", () => {
    const source = [
      "# Title",
      "",
      "A paragraph with **bold**.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> quoted",
      "",
      "---",
      "",
      "```ts",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(kinds(parseMarkdown(source))).toEqual(["heading", "paragraph", "list", "list", "quote", "rule", "code"]);
  });

  it("reads heading levels, and keeps their text", () => {
    const blocks = parseMarkdown("## Two\n\n#### Four");
    expect(blocks.map((block) => (block.kind === "heading" ? block.level : 0))).toEqual([2, 4]);
    expect(blocks[0].kind === "heading" && textOf(blocks[0].children)).toBe("Two");
  });

  it("separates a bulleted list from a numbered one instead of merging them", () => {
    const blocks = parseMarkdown("- a\n- b\n1. c\n2. d");
    expect(kinds(blocks)).toEqual(["list", "list"]);
    expect(blocks[0].kind === "list" && blocks[0].ordered).toBe(false);
    expect(blocks[1].kind === "list" && blocks[1].ordered).toBe(true);
    expect(blocks[1].kind === "list" && blocks[1].items).toHaveLength(2);
  });

  it("accepts every bullet and ordered marker people actually type", () => {
    for (const source of ["- a", "* a", "+ a", "1. a", "1) a"]) {
      expect(kinds(parseMarkdown(source)), source).toEqual(["list"]);
    }
  });

  it("joins consecutive quote lines into one block", () => {
    const blocks = parseMarkdown("> one\n> two");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind === "quote" && textOf(blocks[0].children)).toBe("one two");
  });

  it("keeps fenced code verbatim, with its language", () => {
    const blocks = parseMarkdown("```python\nif x:\n    # **not bold**\n    pass\n```");
    expect(blocks[0]).toEqual({ kind: "code", language: "python", text: "if x:\n    # **not bold**\n    pass" });
  });

  /**
   * A half-arrived answer ends mid-fence on every streamed turn. Treating the tail as code is what
   * stops a partially-streamed code block from being rendered as prose and then reflowing when the
   * closing fence lands.
   */
  it("treats an unterminated fence as code to the end of the document", () => {
    const blocks = parseMarkdown("text\n\n```js\nconst a = 1;");
    expect(kinds(blocks)).toEqual(["paragraph", "code"]);
    expect(blocks[1].kind === "code" && blocks[1].text).toBe("const a = 1;");
  });

  it("parses a table only when its delimiter row is present", () => {
    const table = parseMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |");
    expect(kinds(table)).toEqual(["table"]);
    expect(table[0].kind === "table" && table[0].header.map(textOf)).toEqual(["a", "b"]);
    expect(table[0].kind === "table" && table[0].rows[0].map(textOf)).toEqual(["1", "2"]);

    // Without the delimiter these are just lines containing pipes — ASCII art, a shell pipeline —
    // and rendering them as a table wrecks them.
    expect(kinds(parseMarkdown("| a | b |\n| 1 | 2 |"))).toEqual(["paragraph"]);
  });

  it("joins wrapped lines into one paragraph and splits on a blank line", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(kinds(blocks)).toEqual(["paragraph", "paragraph"]);
    expect(blocks[0].kind === "paragraph" && textOf(blocks[0].children)).toBe("one two");
  });

  it("produces nothing from nothing", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });

  /**
   * The property that matters for a chat transcript: whatever the model emits, the words survive.
   * A renderer that drops text on an unusual input is worse than one that renders it unstyled.
   */
  it("never loses the words, whatever the markup", () => {
    for (const source of [
      "plain text",
      "# heading\n\nbody",
      "- alpha\n- beta",
      "> quote\n\nafter",
      "a **b** _c_ `d` [e](https://x.com)",
      "| h |\n| --- |\n| cell |",
      "***",
      "unclosed **bold",
    ]) {
      // Link *targets* are not visible text, so they are stripped before the comparison — the
      // property is about the words a reader sees, and the href is shown only as the label.
      const visible = source.replace(/\]\([^)]*\)/g, "]");
      const words = parseMarkdown(source)
        .flatMap((block) => (block.kind === "code" ? [block.text]
          : block.kind === "rule" ? []
          : block.kind === "list" ? block.items.map(textOf)
          : block.kind === "table" ? [...block.header.map(textOf), ...block.rows.flatMap((row) => row.map(textOf))]
          : [textOf(block.children)]))
        .join(" ");
      for (const word of visible.match(/[A-Za-z]{2,}/g) ?? []) {
        expect(words, `${source} → ${words}`).toContain(word);
      }
    }
  });
});

describe("link safety", () => {
  /**
   * Message content is model output, which routinely quotes whatever it just read out of the user's
   * files. A `javascript:` URL rendered as an anchor is script execution one click away.
   */
  it("permits ordinary web links and refuses script-bearing schemes", () => {
    for (const href of ["https://example.com", "http://example.com", "mailto:a@b.com", "/local", "#anchor"]) {
      expect(isSafeHref(href), href).toBe(true);
    }
    for (const href of ["javascript:alert(1)", "data:text/html,<script>", "vbscript:x", " javascript:alert(1)"]) {
      expect(isSafeHref(href), href).toBe(false);
    }
  });
});
