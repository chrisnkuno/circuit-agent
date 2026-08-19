import type { DiffLine } from "./code-view";

/**
 * Which *characters* changed, not merely which lines.
 *
 * A unified diff says a line was removed and another added. When the two are a renamed variable or
 * a flipped comparison, that is technically true and practically useless: the reviewer's eye has to
 * scan two nearly identical eighty-column lines to find the one token that differs, and that scan
 * is where a wrong review comes from. Every graphical diff viewer solves this the same way — mark
 * the differing run inside the line — and it is the single thing people say they miss most when
 * they move from an editor's diff to a terminal one.
 *
 * Two deliberate refusals keep the marking honest. Lines that are not really versions of each other
 * are left alone, because highlighting 90% of a rewritten line marks nothing and costs the eye
 * everything. And the pairing is positional within a run of changes rather than a global search for
 * the best match, so what is compared to what stays predictable as the surrounding hunk changes.
 */

export type Segment = { text: string; changed: boolean };

export type IntralineDiff = { before: Segment[]; after: Segment[] };

/** Longest line pair worth comparing. Past this the cost is real and the payoff is not. */
const MAX_LINE_LENGTH = 1_000;
const MAX_TOKEN_CELLS = 40_000;

/**
 * Below this share of shared tokens, two lines are a rewrite rather than an edit.
 *
 * Chosen so `const total = a + b` versus `const total = a - b` is marked (high overlap) while an
 * entirely different statement that happens to share `const` and `=` is not.
 */
const MIN_SIMILARITY = 0.4;

/**
 * Splits a line into the units a person compares.
 *
 * Identifiers and numbers stay whole — the interesting change is `oldName` → `newName`, and a
 * character diff would mark the three letters they happen not to share, which reads as noise.
 * Whitespace runs are their own tokens so indentation changes are visible rather than absorbed
 * into the token beside them.
 */
export function tokenize(line: string): string[] {
  return line.match(/[A-Za-z0-9_$]+|\s+|[^A-Za-z0-9_$\s]/g) ?? [];
}

/** Share of tokens the two lines have in common, counting duplicates only as often as both have them. */
export function similarity(before: string, after: string): number {
  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length === 0 && right.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const token of left) counts.set(token, (counts.get(token) ?? 0) + 1);
  let shared = 0;
  for (const token of right) {
    const available = counts.get(token) ?? 0;
    if (available > 0) { shared += 1; counts.set(token, available - 1); }
  }
  return (2 * shared) / (left.length + right.length);
}

/**
 * The changed runs on each side, or `null` when marking would not help.
 *
 * `null` rather than "everything changed" on purpose: the caller renders a plain removed/added
 * pair in that case, which is the correct rendering for two lines that share nothing.
 */
export function intralineDiff(before: string, after: string): IntralineDiff | null {
  if (before === after) return null;
  if (before.length > MAX_LINE_LENGTH || after.length > MAX_LINE_LENGTH) return null;
  if (before.trim() === "" || after.trim() === "") return null;
  if (similarity(before, after) < MIN_SIMILARITY) return null;

  const left = tokenize(before);
  const right = tokenize(after);
  if (left.length * right.length > MAX_TOKEN_CELLS) return null;

  // lengths[i][j] = LCS length of left[i..] and right[j..] — the same shape as the line diff, one
  // level down. Tokens rather than characters, for the reason `tokenize` exists.
  const lengths: number[][] = Array.from({ length: left.length + 1 }, () => new Array<number>(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const beforeSegments: Segment[] = [];
  const afterSegments: Segment[] = [];
  const push = (segments: Segment[], text: string, changed: boolean) => {
    const last = segments.at(-1);
    if (last && last.changed === changed) last.text += text;
    else segments.push({ text, changed });
  };

  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push(beforeSegments, left[i], false);
      push(afterSegments, right[j], false);
      i += 1;
      j += 1;
    } else if (lengths[i + 1][j] >= lengths[i][j + 1]) {
      push(beforeSegments, left[i], true);
      i += 1;
    } else {
      push(afterSegments, right[j], true);
      j += 1;
    }
  }
  while (i < left.length) { push(beforeSegments, left[i], true); i += 1; }
  while (j < right.length) { push(afterSegments, right[j], true); j += 1; }

  return { before: beforeSegments, after: afterSegments };
}

export type PairedRow =
  | { kind: "context"; text: string }
  | { kind: "remove"; text: string; segments?: Segment[] }
  | { kind: "add"; text: string; segments?: Segment[] };

/**
 * Walks a hunk and matches each removed line with the added line that replaced it.
 *
 * Runs are paired by position: the first removal with the first addition, the second with the
 * second, and any surplus on either side left unpaired. Positional pairing is what a reader already
 * assumes when they look at a block of `-` lines above a block of `+` lines, and matching that
 * assumption matters more than finding a cleverer alignment — a pairing that reshuffles itself
 * because a neighbouring line changed is one the reader cannot learn to trust.
 *
 * Line order is preserved exactly: this annotates, it never reorders.
 */
export function pairHunkLines(lines: readonly DiffLine[]): PairedRow[] {
  const rows: PairedRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].kind !== "remove") {
      rows.push({ kind: lines[index].kind, text: lines[index].text } as PairedRow);
      continue;
    }
    let removeEnd = index;
    while (removeEnd < lines.length && lines[removeEnd].kind === "remove") removeEnd += 1;
    let addEnd = removeEnd;
    while (addEnd < lines.length && lines[addEnd].kind === "add") addEnd += 1;

    const removed = lines.slice(index, removeEnd);
    const added = lines.slice(removeEnd, addEnd);
    const paired = Math.min(removed.length, added.length);
    const marks = Array.from({ length: paired }, (_, offset) => intralineDiff(removed[offset].text, added[offset].text));

    removed.forEach((line, offset) => rows.push({ kind: "remove", text: line.text, ...(marks[offset] ? { segments: marks[offset]!.before } : {}) }));
    added.forEach((line, offset) => rows.push({ kind: "add", text: line.text, ...(marks[offset] ? { segments: marks[offset]!.after } : {}) }));
    index = addEnd - 1;
  }
  return rows;
}
