import type { ColorDepth } from "./banner";
import { BOLD, CYAN, DIM, GREEN, MAGENTA, RED, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { visibleWidth } from "./markdown";
import { GUTTER, clip, panel, type SectionStyle } from "./sections";

/**
 * The code the agent actually wrote, shown where it happened.
 *
 * Until now a write was one line in the transcript: `✓ write_file  src/app.ts · Wrote src/app.ts
 * (812 bytes)`. That is an accurate receipt and a useless one — the single question a person
 * watching an agent edit their repository has is *what did it put in there*, and answering it meant
 * leaving the session to run `git diff`. Every capable terminal agent shows the change inline; this
 * is that, for `write_file` (the content, numbered) and `edit_file` (the replacement, as a diff).
 *
 * The content comes from the tool *call*, not from re-reading the file: it is what was actually
 * sent, it is already in memory, and it costs no round trip to a sandbox that may be remote.
 */

export type DiffKind = "add" | "remove" | "context";
export type DiffLine = { kind: DiffKind; text: string };

/**
 * A line diff of two texts, by longest common subsequence.
 *
 * Quadratic, and deliberately bounded: `edit_file`'s two sides are a snippet being replaced, not
 * two revisions of a large file, so the sizes here are tens of lines. Past the cap the honest thing
 * is to stop computing and show the two sides whole — a diff that took a second to render is worse
 * than no diff, and a wrong one worse still.
 */
const MAX_DIFF_CELLS = 250_000;

export function diffLines(before: string, after: string): DiffLine[] {
  const left = before === "" ? [] : before.split("\n");
  const right = after === "" ? [] : after.split("\n");
  if (left.length * right.length > MAX_DIFF_CELLS) {
    return [
      ...left.map((text) => ({ kind: "remove" as const, text })),
      ...right.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  // lengths[i][j] = LCS length of left[i..] and right[j..]
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j]
        ? lengths[i + 1][j + 1] + 1
        : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { result.push({ kind: "context", text: left[i] }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { result.push({ kind: "remove", text: left[i] }); i += 1; }
    else { result.push({ kind: "add", text: right[j] }); j += 1; }
  }
  while (i < left.length) { result.push({ kind: "remove", text: left[i] }); i += 1; }
  while (j < right.length) { result.push({ kind: "add", text: right[j] }); j += 1; }
  return result;
}

export function diffStat(diff: readonly DiffLine[]): { added: number; removed: number } {
  return {
    added: diff.filter((line) => line.kind === "add").length,
    removed: diff.filter((line) => line.kind === "remove").length,
  };
}

/**
 * Drops long runs of unchanged lines, keeping a few either side of each change.
 *
 * The same reason `git diff` has `-U3`: unchanged context is what makes a change locatable, and
 * more than a few lines of it is what makes a change hard to find.
 */
export function condenseDiff(diff: readonly DiffLine[], context = 2): (DiffLine | { kind: "gap"; text: string })[] {
  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let offset = -context; offset <= context; offset += 1) {
      const target = index + offset;
      if (target >= 0 && target < diff.length) keep[target] = true;
    }
  });

  const result: (DiffLine | { kind: "gap"; text: string })[] = [];
  let skipped = 0;
  diff.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        result.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
        skipped = 0;
      }
      result.push(line);
      return;
    }
    skipped += 1;
  });
  if (skipped > 0) result.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
  return result;
}

/** The language label for a path, used for the panel badge and for highlighting. */
export function languageOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? "";
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const byExtension: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", mjs: "javascript", cjs: "javascript",
    py: "python", rb: "ruby", go: "go", rs: "rust", java: "java", kt: "kotlin", swift: "swift",
    c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php",
    sh: "shell", bash: "shell", zsh: "shell", fish: "shell",
    json: "json", yml: "yaml", yaml: "yaml", toml: "toml", ini: "ini", xml: "xml", html: "html",
    css: "css", scss: "scss", sql: "sql", md: "markdown", mdx: "markdown", txt: "text",
  };
  if (byExtension[extension]) return byExtension[extension];
  if (/^(?:dockerfile|makefile|justfile)$/i.test(name)) return name.toLowerCase();
  return extension || "text";
}

const KEYWORDS = new Set([
  "async", "await", "break", "case", "catch", "class", "const", "continue", "def", "default",
  "elif", "else", "end", "enum", "export", "extends", "finally", "fn", "for", "from", "func",
  "function", "if", "impl", "import", "in", "interface", "let", "match", "mod", "new", "package",
  "private", "public", "pub", "raise", "return", "static", "struct", "switch", "throw", "trait",
  "try", "type", "use", "var", "void", "while", "with", "yield",
]);

const LITERALS = new Set(["true", "false", "null", "nil", "None", "True", "False", "undefined", "self", "this"]);

/**
 * A deliberately small highlighter: strings, comments, numbers, keywords, and nothing else.
 *
 * A real grammar-driven highlighter is a dependency, a language matrix and a maintenance surface;
 * what a transcript needs is only enough colour to tell prose-in-a-string from code and to make the
 * shape of a line scannable. Four categories does that, in one pass, for every language at once —
 * and being approximate is safe here because it colours a *quotation*, never a decision.
 */
export function highlightCode(line: string, depth: ColorDepth): string {
  if (depth === "none") return line;
  const commentAt = findCommentStart(line);
  const code = commentAt === -1 ? line : line.slice(0, commentAt);
  const comment = commentAt === -1 ? "" : paint(line.slice(commentAt), DIM, depth);

  const painted = code.replace(
    /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g,
    (whole, text: string | undefined, numeric: string | undefined, word: string | undefined) => {
      if (text !== undefined) return paint(text, GREEN, depth);
      if (numeric !== undefined) return paint(numeric, MAGENTA, depth);
      if (word !== undefined && KEYWORDS.has(word)) return paint(word, CYAN, depth);
      if (word !== undefined && LITERALS.has(word)) return paint(word, MAGENTA, depth);
      return whole;
    },
  );
  return `${painted}${comment}`;
}

/** Where a line comment starts, ignoring `//` and `#` that live inside a string. */
function findCommentStart(line: string): number {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === "\\") { index += 1; continue; }
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'" || character === "`") { quote = character; continue; }
    if (character === "#") return index;
    if (character === "/" && line[index + 1] === "/") return index;
    if (character === "-" && line[index + 1] === "-") return index;
  }
  return -1;
}

export type CodeViewOptions = {
  /** Rows shown before the rest is folded away; the caller offers the remainder behind `/expand`. */
  maxLines?: number;
  /** 1-based line number the first rendered line carries. */
  startLine?: number;
  language?: string;
  highlight?: boolean;
};

export type RenderedBlock = {
  /** Ready to print. */
  text: string;
  /** Lines withheld, which is what makes a block worth offering an expansion for. */
  hidden: number;
  /** The whole thing, unfolded — what `/expand` prints. */
  full: string;
};

/**
 * A file's contents, numbered, folded to a readable height.
 *
 * Numbered because the very next thing anyone says about written code is a line number, and a
 * transcript that cannot be pointed at is a transcript people screenshot instead of quoting.
 */
export function renderCode(content: string, style: SectionStyle, options: CodeViewOptions = {}): RenderedBlock {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const lines = content.replace(/\n$/, "").split("\n");
  const maxLines = options.maxLines ?? 16;
  const start = options.startLine ?? 1;
  const numberWidth = String(start + lines.length - 1).length;
  const bodyWidth = Math.max(8, style.width - GUTTER.length - numberWidth - 4);

  const render = (from: number, to: number) => lines.slice(from, to).map((line, index) => {
    const number = paint(String(start + from + index).padStart(numberWidth), DIM, style.depth);
    const painted = options.highlight === false ? line : highlightCode(line, style.depth);
    return `${number} ${clip(painted, bodyWidth, glyphs)}`;
  });

  const hidden = Math.max(0, lines.length - maxLines);
  const shown = render(0, hidden > 0 ? maxLines : lines.length);
  return {
    text: shown.join("\n"),
    hidden,
    full: render(0, lines.length).join("\n"),
  };
}

/** A diff, `+`/`-` gutter and all, folded the same way. */
export function renderDiff(diff: readonly DiffLine[], style: SectionStyle, options: CodeViewOptions = {}): RenderedBlock {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const maxLines = options.maxLines ?? 16;
  const condensed = condenseDiff(diff);
  const bodyWidth = Math.max(8, style.width - GUTTER.length - 4);

  const row = (line: DiffLine | { kind: "gap"; text: string }): string => {
    if (line.kind === "gap") return paint(`${glyphs.middot.repeat(3)} ${line.text}`, DIM, style.depth);
    const mark = line.kind === "add" ? glyphs.plus : line.kind === "remove" ? glyphs.minus : " ";
    const code = line.kind === "add" ? GREEN : line.kind === "remove" ? RED : DIM;
    const body = line.kind === "context" ? paint(line.text, DIM, style.depth) : highlightCode(line.text, style.depth);
    return `${paint(mark, code, style.depth)} ${clip(body, bodyWidth, glyphs)}`;
  };

  const rows = condensed.map(row);
  const hidden = Math.max(0, rows.length - maxLines);
  return {
    text: (hidden > 0 ? rows.slice(0, maxLines) : rows).join("\n"),
    hidden,
    full: diff.map(row).join("\n"),
  };
}

/**
 * The complete inline view of one file-writing tool call: a titled panel, the change, and — when
 * something was folded — the one line telling the reader how to see the rest.
 */
export function renderFileChange(
  change: { path: string; kind: "write" | "edit"; content?: string; before?: string; after?: string },
  style: SectionStyle,
  options: { maxLines?: number; expandHint?: string } = {},
): RenderedBlock {
  const language = languageOf(change.path);
  const block = change.kind === "edit"
    ? renderDiff(diffLines(change.before ?? "", change.after ?? ""), style, { maxLines: options.maxLines })
    : renderCode(change.content ?? "", style, { maxLines: options.maxLines, language });

  const badge = change.kind === "edit"
    ? (() => {
      const stat = diffStat(diffLines(change.before ?? "", change.after ?? ""));
      return `+${stat.added} -${stat.removed}`;
    })()
    : `${(change.content ?? "").split("\n").length} lines · ${language}`;

  const body = block.text.split("\n");
  const foot = block.hidden > 0 && options.expandHint
    ? [paint(`${(style.glyphs ?? UNICODE_GLYPHS).collapsed} ${block.hidden} more line${block.hidden === 1 ? "" : "s"} — ${options.expandHint}`, DIM, style.depth)]
    : [];

  return {
    text: panel([...body, ...foot], style, { title: `${change.kind === "edit" ? "diff" : "new file"} · ${change.path}`, badge, tone: change.kind === "edit" ? "accent" : "good" }),
    hidden: block.hidden,
    full: panel(block.full.split("\n"), style, { title: `${change.kind === "edit" ? "diff" : "new file"} · ${change.path}`, badge, tone: change.kind === "edit" ? "accent" : "good" }),
  };
}

/** A one-line header for a code answer inside prose, used by the markdown renderer's fenced blocks. */
export function fenceHeader(language: string, style: SectionStyle): string {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const label = language ? ` ${language} ` : glyphs.boxHorizontal.repeat(4);
  const width = Math.max(0, style.width - GUTTER.length - visibleWidth(label) - 3);
  return `${GUTTER}${paint(glyphs.boxTopLeft + glyphs.boxHorizontal, DIM, style.depth)}${paintAll(label, [CYAN, BOLD], style.depth)}${paint(glyphs.boxHorizontal.repeat(Math.max(0, width)), DIM, style.depth)}`;
}

/** How a diff of a file reads in one line, for the status line and for tool summaries. */
export function describeChange(stat: { added: number; removed: number }, depth: ColorDepth): string {
  return `${paint(`+${stat.added}`, GREEN, depth)} ${paint(`-${stat.removed}`, RED, depth)}`;
}
