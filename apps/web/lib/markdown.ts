/**
 * The small subset of Markdown a chat reply actually uses, parsed into a structure a React tree
 * can render directly.
 *
 * Deliberately not a general Markdown implementation, and deliberately not HTML: the renderer
 * builds elements, so model output can never inject markup. Anything unrecognised survives as
 * plain text rather than disappearing.
 */
export type Span =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; text: string }
  | { type: "em"; text: string }
  | { type: "link"; text: string; href: string };

export type Block =
  | { type: "code"; language?: string; text: string }
  | { type: "heading"; level: 1 | 2 | 3; spans: Span[] }
  | { type: "list"; ordered: boolean; items: Span[][] }
  | { type: "quote"; spans: Span[] }
  | { type: "paragraph"; spans: Span[] }
  | { type: "rule" };

// Code first: a span inside backticks is literal, so nothing else may match within it.
const INLINE = /(`[^`\n]+`)|(\[[^\]\n]+\]\([^)\s]+\))|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*|_[^_\n]+_)|(https?:\/\/[^\s<>()]+)/g;

export function parseInline(text: string): Span[] {
  const spans: Span[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    if (index > lastIndex) spans.push({ type: "text", text: text.slice(lastIndex, index) });
    const [token] = match;
    if (match[1]) spans.push({ type: "code", text: token.slice(1, -1) });
    else if (match[2]) {
      const split = token.indexOf("](");
      spans.push({ type: "link", text: token.slice(1, split), href: token.slice(split + 2, -1) });
    } else if (match[3]) spans.push({ type: "strong", text: token.slice(2, -2) });
    else if (match[4]) spans.push({ type: "em", text: token.slice(1, -1) });
    else spans.push({ type: "link", text: token, href: token });
    lastIndex = index + token.length;
  }
  if (lastIndex < text.length) spans.push({ type: "text", text: text.slice(lastIndex) });
  return spans;
}

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", spans: parseInline(paragraph.join(" ").trim()) });
    paragraph = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*```(\S*)\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const body: string[] = [];
      index += 1;
      // An unterminated fence still renders as code: truncated model output is common, and
      // showing the code beats showing backticks.
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        body.push(lines[index]);
        index += 1;
      }
      blocks.push({ type: "code", language: fence[1] || undefined, text: body.join("\n") });
      continue;
    }
    if (/^\s*$/.test(line)) { flushParagraph(); continue; }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) { flushParagraph(); blocks.push({ type: "rule" }); continue; }

    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, spans: parseInline(heading[2].trim()) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) { flushParagraph(); blocks.push({ type: "quote", spans: parseInline(quote[1]) }); continue; }

    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const ordered = Boolean(numbered);
      const previous = blocks.at(-1);
      const item = parseInline((bullet ?? numbered)![1]);
      if (previous?.type === "list" && previous.ordered === ordered) previous.items.push(item);
      else blocks.push({ type: "list", ordered, items: [item] });
      continue;
    }
    paragraph.push(line.trim());
  }
  flushParagraph();
  return blocks;
}
