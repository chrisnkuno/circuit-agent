import { GUTTER, note, panel, rule, type SectionStyle } from "./sections";
import { UNICODE_GLYPHS } from "./glyphs";
import { BOLD, DIM, GREEN, RED, REVERSE, paint, paintAll } from "./ansi";
import { pairHunkLines, type Segment } from "./intraline";
import { describeChange, highlightCode, type DiffLine } from "./code-view";
import { visibleWidth } from "./markdown";

/**
 * A unified diff, read back into something worth looking at.
 *
 * `/diff` used to print `git diff --stat` — a list of filenames and a column of plus signs, which
 * answers "how much changed" and never "what changed". That is the wrong half: an agent that edited
 * four files has already told you it edited four files. What a reviewer needs is the lines.
 *
 * The parser is deliberately tolerant. A patch that this does not fully understand still renders —
 * unknown lines pass through as context rather than being dropped — because a diff viewer that
 * silently omits a line it could not classify is worse than one that shows it plainly. The failure
 * mode of a review tool must never be "quietly showed you less than there was".
 */

export type PatchHunk = {
  /** The `@@ … @@` header's own text, minus the markers — usually the enclosing function. */
  heading: string;
  /** First line number on the new side, for numbering the rendered rows. */
  newStart: number;
  lines: DiffLine[];
};

export type PatchFile = {
  path: string;
  /** Where the file went, when a patch renames it. */
  previousPath?: string;
  kind: "added" | "removed" | "renamed" | "modified" | "binary";
  hunks: PatchHunk[];
  added: number;
  removed: number;
};

const FILE_HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/**
 * Splits a `git diff` into files and hunks.
 *
 * Reads `diff --git` rather than the `---`/`+++` pair as the file boundary: the pair is absent for
 * a pure rename and carries `/dev/null` for an add or delete, so the `a/… b/…` line is the only one
 * always present and always naming both sides.
 */
export function parsePatch(patch: string): PatchFile[] {
  const files: PatchFile[] = [];
  let file: PatchFile | undefined;
  let hunk: PatchHunk | undefined;

  const closeHunk = () => {
    if (file && hunk && hunk.lines.length > 0) file.hunks.push(hunk);
    hunk = undefined;
  };

  // A patch ends with a newline, and the empty string after it is not a line of the file — read as
  // one it becomes a phantom blank context row at the end of the last hunk.
  const lines = patch.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    const header = FILE_HEADER.exec(line);
    if (header) {
      closeHunk();
      file = { path: header[2], kind: "modified", hunks: [], added: 0, removed: 0 };
      files.push(file);
      continue;
    }
    if (!file) continue;

    if (line.startsWith("new file mode")) { file.kind = "added"; continue; }
    if (line.startsWith("deleted file mode")) { file.kind = "removed"; continue; }
    if (line.startsWith("rename from ")) { file.previousPath = line.slice("rename from ".length); file.kind = "renamed"; continue; }
    if (line.startsWith("rename to ")) { file.path = line.slice("rename to ".length); file.kind = "renamed"; continue; }
    if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) { file.kind = "binary"; closeHunk(); continue; }
    // The metadata lines carry no content; `---`/`+++` in particular would otherwise be read as a
    // removed and an added line, which is how a naive parser reports every file as ±1.
    if (line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
      || line.startsWith("old mode") || line.startsWith("new mode") || line.startsWith("similarity index")) continue;

    const hunkHeader = HUNK_HEADER.exec(line);
    if (hunkHeader) {
      closeHunk();
      hunk = { heading: hunkHeader[2].trim(), newStart: Number.parseInt(hunkHeader[1], 10) || 1, lines: [] };
      continue;
    }
    if (!hunk) continue;

    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line.startsWith("+")) { hunk.lines.push({ kind: "add", text: line.slice(1) }); file.added += 1; continue; }
    if (line.startsWith("-")) { hunk.lines.push({ kind: "remove", text: line.slice(1) }); file.removed += 1; continue; }
    // A context line starts with a space; anything else is malformed, and is shown rather than lost.
    hunk.lines.push({ kind: "context", text: line.startsWith(" ") ? line.slice(1) : line });
  }
  closeHunk();
  return files;
}

export function patchTotals(files: readonly PatchFile[]): { files: number; added: number; removed: number } {
  return {
    files: files.length,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

const KIND_LABEL: Record<PatchFile["kind"], string> = {
  added: "new",
  removed: "deleted",
  renamed: "renamed",
  modified: "",
  binary: "binary",
};

/**
 * One file's changes, as a panel of numbered rows.
 *
 * Removed lines are not numbered on the new side, because they have no line there — a number in
 * that column would name a line that does not exist, which is exactly the mistake that makes people
 * mis-report where a bug is. Added and context lines carry the number they will have after the
 * change lands, since that is the file everyone will open next.
 */
export function renderPatchFile(file: PatchFile, style: SectionStyle, options: { maxLines?: number } = {}): { text: string; hidden: number; full: string } {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const depth = style.depth;
  const maxLines = options.maxLines ?? Number.POSITIVE_INFINITY;

  if (file.kind === "binary" || file.hunks.length === 0) {
    const label = file.kind === "binary" ? "binary file changed" : `${KIND_LABEL[file.kind] || "changed"} — no textual change`;
    const rendered = `${GUTTER}${file.path}\n${note(label, style)}`;
    return { text: rendered, hidden: 0, full: rendered };
  }

  const rows: string[] = [];
  for (const [index, hunk] of file.hunks.entries()) {
    // A hunk boundary is a jump in the file; without a marker the rows either side read as
    // consecutive, which silently misrepresents the distance between two changes.
    if (index > 0 || hunk.heading) {
      rows.push(paint(`${glyphs.ellipsis}${hunk.heading ? ` ${hunk.heading}` : ""}`, DIM, depth));
    }
    let lineNumber = hunk.newStart;
    // Paired first, so a removal and the addition that replaced it can be compared token by token
    // before either is painted. Order is untouched — this only annotates.
    for (const line of pairHunkLines(hunk.lines)) {
      const number = line.kind === "remove" ? "" : `${lineNumber}`;
      if (line.kind !== "remove") lineNumber += 1;
      const gutterNumber = paint(number.padStart(5), DIM, depth);
      const marker = line.kind === "add" ? paint("+", GREEN, depth) : line.kind === "remove" ? paint("-", RED, depth) : " ";
      // Syntax highlighting only on the surviving text: colouring a removed line the same as a
      // kept one makes the two hard to tell apart at a glance, which is the whole job here.
      const body = line.kind === "remove"
        ? paintSegments(line.text, line.segments, RED, depth)
        : line.kind === "add"
          ? paintSegments(line.text, line.segments, GREEN, depth)
          : highlightCode(line.text, depth);
      rows.push(`${gutterNumber} ${marker} ${body}`);
    }
  }

  const badge = `${describeChange({ added: file.added, removed: file.removed }, depth)}${KIND_LABEL[file.kind] ? `  ${KIND_LABEL[file.kind]}` : ""}`;
  const title = file.previousPath ? `${file.previousPath} ${glyphs.arrowRight} ${file.path}` : file.path;
  const shown = rows.slice(0, maxLines === Number.POSITIVE_INFINITY ? rows.length : maxLines);
  return {
    text: panel(shown, style, { title, badge, tone: "accent" }),
    hidden: Math.max(0, rows.length - shown.length),
    full: panel(rows, style, { title, badge, tone: "accent" }),
  };
}

/**
 * The whole patch: a rule, then every file, then a total.
 *
 * Files are shown in the order the patch lists them, which is git's own alphabetical order, rather
 * than sorted by size. A reviewer reading a diff twice needs the same file in the same place both
 * times more than they need the biggest change first.
 */
export function renderPatch(
  patch: string,
  style: SectionStyle,
  options: { maxLinesPerFile?: number; title?: string } = {},
): { text: string; files: PatchFile[]; totals: ReturnType<typeof patchTotals> } {
  const files = parsePatch(patch);
  const totals = patchTotals(files);
  if (files.length === 0) {
    return { text: note("nothing changed", style), files, totals };
  }

  const parts = [rule(style, { label: options.title ?? "diff", tone: "accent" })];
  for (const file of files) {
    parts.push(renderPatchFile(file, style, options.maxLinesPerFile ? { maxLines: options.maxLinesPerFile } : {}).text);
  }
  parts.push(rule(style, {
    trailing: `${totals.files} file${totals.files === 1 ? "" : "s"} ${style.glyphs?.middot ?? "·"} ${describeChange({ added: totals.added, removed: totals.removed }, style.depth)}`,
  }));
  return { text: parts.join("\n"), files, totals };
}

/** How wide the rendered rows are, for a caller deciding whether to fold. */
export function widestRow(text: string): number {
  return text.split("\n").reduce((widest, line) => Math.max(widest, visibleWidth(line)), 0);
}

/**
 * A changed line, with the part that actually changed standing out from the part that did not.
 *
 * Reverse video for the changed run rather than a second colour: the line already carries its
 * red or green, and a third hue inside it competes with that signal instead of refining it.
 * Reversing keeps the same colour and changes only the emphasis, which is what the mark means.
 *
 * Falls back to the plain painted line whenever there is nothing to mark or the terminal has no
 * colour at all — a no-colour terminal must never receive escape codes, and inserting visible
 * markers around the changed run instead would corrupt anything copied out of the diff.
 */
export function paintSegments(text: string, segments: readonly Segment[] | undefined, colour: string, depth: SectionStyle["depth"]): string {
  if (!segments || depth === "none") return paint(text, colour, depth);
  return segments
    .map((segment) => (segment.changed ? paintAll(segment.text, [colour, BOLD, REVERSE], depth) : paint(segment.text, colour, depth)))
    .join("");
}
