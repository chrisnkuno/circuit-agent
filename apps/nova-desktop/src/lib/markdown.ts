/**
 * Markdown, parsed to a tree the transcript can render as real elements.
 *
 * The transcript used to put every non-code segment into a single `<p>`, so a model that answered
 * with headings, a bullet list and some `**emphasis**` — which is how they answer — rendered as one
 * wall of text with the syntax visible in it. Fenced code was the only markup that survived.
 *
 * Parsed to a value rather than to HTML on purpose. Every "render markdown" shortcut ends at
 * `dangerouslySetInnerHTML`, and the text here is model output that routinely contains whatever it
 * just read out of the user's files — so a `<script>` or an `onerror=` in a source file being
 * discussed would execute. Returning a tree means React escapes every text node, and there is no
 * path from a document to markup at all.
 *
 * Deliberately a subset: headings, lists, block quotes, rules, tables, fenced and inline code,
 * bold, italic and links. That is what an answer actually contains. Reference links, footnotes,
 * HTML blocks and setext headings are not implemented — each would add parser states to support
 * something a coding agent does not emit.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "heading"; level: number; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] }
  | { kind: "quote"; children: Inline[] }
  | { kind: "code"; language?: string; text: string }
  | { kind: "table"; header: Inline[][]; rows: Inline[][][] }
  | { kind: "rule" };

/**
 * Splits a line into inline nodes.
 *
 * Code spans are matched *first* and their contents are never re-scanned, which is the rule that
 * makes `` `**not bold**` `` render as literal asterisks. Doing it the other way — emphasis first,
 * code after — is the single most common way a hand-rolled markdown renderer mangles code.
 *
 * Emphasis delimiters may not sit against whitespace, which is CommonMark's flanking rule and is
 * why `2 * 3 * 4` is arithmetic rather than an italic 3. Without it, any prose containing a pair of
 * bare asterisks or underscores — multiplication, a glob, a snake_case name split across words —
 * silently loses the characters between them.
 */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let rest = text;

  // Ordered by precedence. `code` leads; `link` precedes emphasis so a bracketed label containing
  // asterisks is still a link. Bold before italic, or `**x**` parses as two empty italics.
  const patterns: Array<{ kind: string; regex: RegExp }> = [
    { kind: "code", regex: /`([^`]+)`/ },
    { kind: "link", regex: /\[([^\]]*)\]\(([^)\s]+)\)/ },
    { kind: "strong", regex: /\*\*([^\s*](?:[^*]*[^\s*])?)\*\*/ },
    { kind: "strong", regex: /__([^\s_](?:[^_]*[^\s_])?)__/ },
    { kind: "em", regex: /\*([^\s*](?:[^*]*[^\s*])?)\*/ },
    { kind: "em", regex: /_([^\s_](?:[^_]*[^\s_])?)_/ },
  ];

  while (rest.length > 0) {
    let best: { index: number; length: number; node: Inline } | undefined;
    for (const { kind, regex } of patterns) {
      const match = regex.exec(rest);
      if (!match || (best && match.index >= best.index)) continue;
      const node: Inline = kind === "code"
        ? { kind: "code", text: match[1] }
        : kind === "link"
          ? { kind: "link", href: match[2], children: parseInline(match[1]) }
          : { kind: kind as "strong" | "em", children: parseInline(match[1]) };
      best = { index: match.index, length: match[0].length, node };
    }
    if (!best) { out.push({ kind: "text", text: rest }); break; }
    if (best.index > 0) out.push({ kind: "text", text: rest.slice(0, best.index) });
    out.push(best.node);
    rest = rest.slice(best.index + best.length);
  }
  return out.filter((node) => node.kind !== "text" || node.text.length > 0);
}

const splitRow = (line: string): string[] =>
  line.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());

/**
 * Parses a document into blocks.
 *
 * Line-based rather than a real block/inline two-pass parser, which is the right trade here: the
 * input is one chat answer, not a document tree, and the constructs that need genuine recursion
 * (nested lists, lazy continuation) are ones a model answer does not lean on.
 *
 * Fenced code is consumed greedily and never interpreted — an unterminated fence takes the rest of
 * the document, which is what a half-streamed answer produces and is exactly right: the tail is
 * code that has not finished arriving, not prose.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ kind: "code", ...(fence[1] ? { language: fence[1] } : {}), text: body.join("\n") });
      continue;
    }

    if (/^\s*$/.test(line)) { flush(); continue; }

    if (/^\s*(?:---+|\*\*\*+|___+)\s*$/.test(line)) { flush(); blocks.push({ kind: "rule" }); continue; }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flush();
      blocks.push({ kind: "heading", level: heading[1].length, children: parseInline(heading[2].trim()) });
      continue;
    }

    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      // Consecutive quote lines join into one block, so a multi-line quotation is one element.
      const body = [quote[1]];
      while (index + 1 < lines.length && /^\s*>\s?/.test(lines[index + 1])) {
        body.push(lines[index + 1].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", children: parseInline(body.join(" ").trim()) });
      continue;
    }

    // A table needs its delimiter row (`|---|---|`) to be a table at all; without it these are
    // just lines that happen to contain pipes, and treating them as a table wrecks ASCII art.
    if (/\|/.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[index + 1]) && /\|/.test(lines[index + 1])) {
      flush();
      const header = splitRow(line).map(parseInline);
      index += 2;
      const rows: Inline[][][] = [];
      while (index < lines.length && /\|/.test(lines[index]) && !/^\s*$/.test(lines[index])) {
        rows.push(splitRow(lines[index]).map(parseInline));
        index += 1;
      }
      index -= 1;
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== undefined;
      const items: Inline[][] = [parseInline(item[3])];
      while (index + 1 < lines.length) {
        const next = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(lines[index + 1]);
        // A list ends when the marker kind changes, so a bulleted list directly after a numbered
        // one renders as two lists rather than as one with mismatched markers.
        if (!next || (next[2] !== undefined) !== ordered) break;
        items.push(parseInline(next[3]));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return blocks;
}

/**
 * Whether a link may be rendered as a link.
 *
 * Model output is untrusted text, and `javascript:` and `data:` URLs in an anchor are script
 * execution one click away. Anything not plainly http(s) or a mail link renders as text instead.
 */
export function isSafeHref(href: string): boolean {
  return /^(https?:\/\/|mailto:|#|\/)/i.test(href.trim());
}
