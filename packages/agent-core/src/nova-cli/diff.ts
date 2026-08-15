/**
 * A small, dependency-free line diff for approval previews.
 *
 * Nova has no diff package in the tree, and pulling one in only to show a capped preview under an
 * approval prompt is not worth the dependency. A classic LCS over lines is O(n·m) — cheap for the
 * write_file/edit_file payloads this actually runs against — bounded below so a huge file cannot
 * turn an approval prompt into a multi-second pause.
 */

/** Above this many lines on either side, the table itself (not just the render) gets too big to bother. */
const MAX_DIFF_LINES = 2_000;
/** How many +/- lines an approval prompt shows before summarizing the rest. */
const MAX_PREVIEW_LINES = 40;
/** Unchanged lines kept on each side of a change, so a diff reads as "here" rather than as a flood. */
const CONTEXT_LINES = 2;

type DiffOp = { kind: "add" | "remove" | "context"; line: string };

/** Splits on the exact line boundary; an empty string is zero lines, not one blank line. */
function toLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

function lcsOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i][j] = oldLines[i] === newLines[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "context", line: oldLines[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ kind: "remove", line: oldLines[i] });
      i += 1;
    } else {
      ops.push({ kind: "add", line: newLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ kind: "remove", line: oldLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ kind: "add", line: newLines[j] });
    j += 1;
  }
  return ops;
}

/**
 * Collapses runs of unchanged lines down to a couple of lines of context per side, the way a
 * unified diff's hunks do — otherwise a one-line change deep in a long file would spend the whole
 * preview budget on lines that did not change.
 */
function toHunks(ops: readonly DiffOp[]): DiffOp[] {
  const keep = new Array(ops.length).fill(false);
  for (let index = 0; index < ops.length; index += 1) {
    if (ops[index].kind === "context") continue;
    for (let near = Math.max(0, index - CONTEXT_LINES); near <= Math.min(ops.length - 1, index + CONTEXT_LINES); near += 1) {
      keep[near] = true;
    }
  }
  const result: DiffOp[] = [];
  let collapsing = false;
  for (let index = 0; index < ops.length; index += 1) {
    if (keep[index]) {
      result.push(ops[index]);
      collapsing = false;
    } else if (!collapsing) {
      result.push({ kind: "context", line: "⋯" });
      collapsing = true;
    }
  }
  return result;
}

/**
 * A capped, hunked, plain-text diff between two blobs — old file vs new file for `write_file`, or
 * `oldText` vs `newText` for `edit_file` (already exactly the changed region, so this doubles as
 * that tool's approval preview with no extra file read).
 */
export function computeDiffLines(oldText: string, newText: string, options: { maxPreviewLines?: number } = {}): string[] {
  if (oldText === newText) return [];
  const oldLines = toLines(oldText);
  const newLines = toLines(newText);
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [`(too large to preview — ${oldLines.length} → ${newLines.length} lines)`];
  }

  const hunks = toHunks(lcsOps(oldLines, newLines));
  const limit = options.maxPreviewLines ?? MAX_PREVIEW_LINES;
  const shown = hunks.slice(0, limit);
  const rendered = shown.map((op) => {
    if (op.kind === "context" && op.line === "⋯") return op.line;
    const mark = op.kind === "add" ? "+" : op.kind === "remove" ? "-" : " ";
    return `${mark} ${op.line}`;
  });
  if (hunks.length > limit) rendered.push(`… ${hunks.length - limit} more lines`);
  return rendered;
}
