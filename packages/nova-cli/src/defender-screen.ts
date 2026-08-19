import type { PlacedSecretFinding } from "@circuit-nova/nova-core/nova-cli/tools";
import { barChart } from "./charts";
import { clipTo } from "./chooser";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import type { KeypressEvent } from "./keybindings";
import { visibleWidth } from "./markdown";
import { note, panel, rule, type SectionStyle } from "./sections";
import { padToWidth, stepProgress } from "./tui";
import { applyViewport, newViewport, scrollFraction, visibleLines } from "./viewport";
import { scrollIndicator } from "./tui";

/**
 * Defender's triage screen.
 *
 * A scanner's output is not the hard part and never was. Every security tool in 2026 makes the same
 * observation about itself: detection is cheap, and the bottleneck moved to deciding what to fix
 * first and doing something about it. `/scan` printed a flat list ordered by severity — correct,
 * and still a wall of forty lines that a person reads once, resolves to deal with later, and does
 * not deal with later.
 *
 * So this is a queue with a decision attached to each item. One finding at a time, the evidence
 * that produced it beside it — not just a severity word, which is the other thing that list was
 * missing — and three keys: fix it, ignore it with a reason, or move on. Progress is counted,
 * because a triage pass you cannot see the end of is one nobody starts.
 *
 * Pure: state in, rows out, no I/O and no keyboard. The loop that drives it lives with the other
 * borrowed-keyboard surfaces, and the screen itself can be tested by posing a situation.
 */

export type Triage = "open" | "fixing" | "fixed" | "ignored";

export type TriageFinding = PlacedSecretFinding & {
  triage: Triage;
  /** The line the match was found on, and its neighbours — the evidence, already masked. */
  evidence?: readonly string[];
};

export type DefenderFilter = "all" | "open" | "critical" | "high" | "medium";

export type DefenderState = {
  findings: readonly TriageFinding[];
  /** Index into the *filtered* list, which is what the cursor moves through. */
  selected: number;
  filter: DefenderFilter;
  /** Rows scrolled into the detail pane. */
  detailScroll: number;
  columns: number;
  rows: number;
};

export const SEVERITY_ORDER = ["critical", "high", "medium"] as const;

export function newDefenderState(findings: readonly PlacedSecretFinding[], columns: number, rows: number): DefenderState {
  return {
    findings: findings.map((finding) => ({ ...finding, triage: "open" as const })),
    selected: 0,
    filter: "all",
    detailScroll: 0,
    columns,
    rows,
  };
}

export function visibleFindings(state: DefenderState): TriageFinding[] {
  return state.findings.filter((finding) => {
    if (state.filter === "all") return true;
    if (state.filter === "open") return finding.triage === "open";
    return finding.severity === state.filter;
  });
}

export function selectedFinding(state: DefenderState): TriageFinding | undefined {
  const list = visibleFindings(state);
  return list[Math.max(0, Math.min(state.selected, list.length - 1))];
}

/** How the queue stands: what is in it, and how much of it has been dealt with. */
export function posture(state: DefenderState): {
  counts: Array<{ severity: (typeof SEVERITY_ORDER)[number]; count: number }>;
  total: number;
  triaged: number;
  worst?: (typeof SEVERITY_ORDER)[number];
} {
  const counts = SEVERITY_ORDER.map((severity) => ({ severity, count: state.findings.filter((finding) => finding.severity === severity).length }));
  const open = state.findings.filter((finding) => finding.triage === "open");
  return {
    counts,
    total: state.findings.length,
    triaged: state.findings.length - open.length,
    worst: SEVERITY_ORDER.find((severity) => open.some((finding) => finding.severity === severity)),
  };
}

export type DefenderAction =
  | { kind: "move"; step: number }
  | { kind: "scroll"; rows: number }
  | { kind: "filter"; value: DefenderFilter }
  | { kind: "mark"; triage: Triage }
  | { kind: "fix" }
  | { kind: "exit" }
  | { kind: "none" };

/**
 * Keys, chosen so the two destructive-ish decisions are never adjacent to movement.
 *
 * `f` fixes and `i` ignores; both are deliberate letters rather than Enter, because Enter is what a
 * person presses to see something and must not be the key that spends a model turn.
 */
export function keyToDefenderAction(key: KeypressEvent, character?: string): DefenderAction {
  const name = key.name;
  if (name === "escape" || name === "q" || (key.ctrl && name === "c")) return { kind: "exit" };
  if (name === "up" || name === "k") return { kind: "move", step: -1 };
  if (name === "down" || name === "j") return { kind: "move", step: 1 };
  if (name === "pageup") return { kind: "move", step: -8 };
  if (name === "pagedown") return { kind: "move", step: 8 };
  if (name === "left") return { kind: "scroll", rows: -1 };
  if (name === "right") return { kind: "scroll", rows: 1 };
  if (character === "f") return { kind: "fix" };
  if (character === "i") return { kind: "mark", triage: "ignored" };
  if (character === "o") return { kind: "mark", triage: "open" };
  if (character === "a") return { kind: "filter", value: "all" };
  if (character === "n") return { kind: "filter", value: "open" };
  if (character === "1") return { kind: "filter", value: "critical" };
  if (character === "2") return { kind: "filter", value: "high" };
  if (character === "3") return { kind: "filter", value: "medium" };
  return { kind: "none" };
}

export function detailHeight(rows: number): number {
  // Header, posture bar, the rule between panes, and the footer legend.
  return Math.max(3, Math.floor((rows - 6) / 2));
}

export function listHeight(rows: number): number {
  return Math.max(3, rows - 6 - detailHeight(rows));
}

export function applyDefenderAction(state: DefenderState, action: DefenderState extends never ? never : DefenderAction): DefenderState {
  switch (action.kind) {
    case "move": {
      const list = visibleFindings(state);
      if (list.length === 0) return state;
      const next = Math.max(0, Math.min(state.selected + action.step, list.length - 1));
      // A different finding starts at the top of its own evidence: a scroll offset measured against
      // another finding's detail means nothing here.
      return { ...state, selected: next, detailScroll: next === state.selected ? state.detailScroll : 0 };
    }
    case "scroll": {
      const finding = selectedFinding(state);
      if (!finding) return state;
      const lines = detailLines(finding, state.columns);
      const viewport = { ...newViewport(lines, detailHeight(state.rows)), top: state.detailScroll };
      return { ...state, detailScroll: applyViewport(viewport, action.rows > 0 ? { kind: "down", rows: action.rows } : { kind: "up", rows: -action.rows }).top };
    }
    case "filter": {
      // The cursor follows the finding it was on wherever the new filter puts it, rather than
      // staying at its index — an index is a position in a list that no longer exists.
      const current = selectedFinding(state);
      const next = { ...state, filter: action.value, detailScroll: 0 };
      const moved = current ? visibleFindings(next).findIndex((finding) => finding === current) : -1;
      return { ...next, selected: moved >= 0 ? moved : 0 };
    }
    case "mark": {
      const current = selectedFinding(state);
      if (!current) return state;
      const findings = state.findings.map((finding) => (finding === current ? { ...finding, triage: action.triage } : finding));
      const next = { ...state, findings };
      // Marking under a filter that hides the result would otherwise leave the cursor on whatever
      // slid into the gap, which is how a triage pass silently skips an item.
      const list = visibleFindings(next);
      return { ...next, selected: Math.max(0, Math.min(state.selected, list.length - 1)) };
    }
    case "fix": {
      const current = selectedFinding(state);
      if (!current) return state;
      return { ...state, findings: state.findings.map((finding) => (finding === current ? { ...finding, triage: "fixing" as const } : finding)) };
    }
    default:
      return state;
  }
}

const SEVERITY_MARK: Record<string, string> = { critical: "!!", high: "! ", medium: "~ " };
const TRIAGE_MARK: Record<Triage, string> = { open: " ", fixing: ">", fixed: "+", ignored: "-" };

/** What the detail pane says about one finding: what it is, where, the evidence, and what to do. */
/**
 * The mask marker as *this* terminal can draw it.
 *
 * `maskSecret` puts a real ellipsis in the middle of the masked value, which is right for data —
 * it travels through a journal, a transcript and an API — and wrong for a terminal that was told
 * to use ASCII, where it arrives as a replacement box in the one field a person is reading
 * character by character to recognise which key it is.
 */
export function displayMask(masked: string, glyphs: GlyphSet): string {
  return masked.replace(/\u2026/g, glyphs.ellipsis);
}

export function detailLines(finding: TriageFinding, columns: number, glyphs: GlyphSet = UNICODE_GLYPHS): string[] {
  const width = Math.max(20, columns - 6);
  const wrap = (text: string): string[] => {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      if (current && visibleWidth(`${current} ${word}`) > width) { lines.push(current); current = word; }
      else current = current ? `${current} ${word}` : word;
    }
    if (current) lines.push(current);
    return lines;
  };
  return [
    `${finding.path}:${finding.line}`,
    `${finding.severity} ${glyphs.middot} ${finding.kind}`,
    `matched: ${displayMask(finding.masked, glyphs)}`,
    "",
    ...(finding.evidence && finding.evidence.length > 0
      ? ["evidence", ...finding.evidence.map((line) => `  ${line}`), ""]
      : []),
    ...wrap(REMEDIATION[finding.severity]),
    "",
    ...wrap(`A pattern match is a lead, not proof ${glyphs.middot} read the surrounding code before acting. If it is real, the credential is already compromised: rotate it, then remove it from the tree and from git history.`),
  ];
}

const REMEDIATION: Record<string, string> = {
  critical: "Treat as live and compromised. Rotate the credential first, then replace the literal with an environment variable read at startup, and confirm the env file is covered by .gitignore.",
  high: "Rotate if this key reaches anything real, then move it out of the tree into the environment or a secrets manager. Check whether it was ever committed — deleting it from HEAD does not remove it from history.",
  medium: "Confirm what this actually is: a placeholder and a live credential look identical to a pattern. If it is real, treat it as high; if it is a fixture, make it obviously fake so the next scan does not stop here.",
};

/** The prompt handed to the agent when someone presses `f` — specific, and honest about proof. */
export function fixObjective(finding: TriageFinding): string {
  return [
    `Fix the ${finding.severity} secret finding at ${finding.path}:${finding.line} — ${finding.kind}.`,
    "First read the surrounding code and say whether it is a real credential or a placeholder; if it is a placeholder, say so and stop.",
    "If it is real: replace the literal with a value read from the environment at startup, keep the code working, confirm .gitignore covers the env file, and state plainly that the credential must be rotated because it is already compromised.",
    "Do not print the secret itself at any point.",
  ].join(" ");
}

export function composeDefenderFrame(state: DefenderState, style: SectionStyle): string[] {
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(30, state.columns);
  const shape = posture(state);
  const list = visibleFindings(state);
  const selected = Math.max(0, Math.min(state.selected, list.length - 1));
  const rows: string[] = [];

  rows.push(rule({ ...style, width }, { label: `defender ${glyphs.middot} triage`, tone: shape.worst === "critical" ? "bad" : "accent" }));
  const counted = shape.counts.filter((entry) => entry.count > 0);
  if (counted.length > 0) {
    // Bars, not a heat strip. A strip shades every row to full width and encodes magnitude as
    // intensity, which is right when the rows are a scale and wrong when they are severities: two
    // criticals and fourteen mediums drew the mediums as the darkest row, and "the worst thing here
    // is the least serious one" is the single most damaging thing a security summary can imply.
    // Length answers "how many"; the label and the frame's own colour answer "how bad".
    for (const line of barChart(counted.map((entry) => ({ label: entry.severity, value: entry.count })), { width: Math.min(48, Math.max(24, width - 20)), depth: style.depth, glyphs, max: shape.total })) {
      rows.push(`  ${line}`);
    }
  }
  rows.push(`  ${stepProgress(shape.triaged, shape.total, { label: "triaged", width: Math.min(20, Math.max(0, width - 40)), depth: style.depth, glyphs })}   ${state.filter === "all" ? "" : `filter: ${state.filter}`}`);

  // The queue, windowed so the cursor is always on screen.
  const height = listHeight(state.rows);
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), Math.max(0, list.length - height)));
  const queue: string[] = [];
  for (let offset = 0; offset < height; offset += 1) {
    const finding = list[start + offset];
    if (!finding) { queue.push(""); continue; }
    const active = start + offset === selected;
    const mark = `${SEVERITY_MARK[finding.severity] ?? "  "}${TRIAGE_MARK[finding.triage]}`;
    const label = `${finding.path}:${finding.line}  ${finding.kind}`;
    // Padded to the panel's own width so the queue and the detail below it share an edge; a panel
    // sized to its longest row makes the two frames disagree every time the filter changes.
    queue.push(padToWidth(clipTo(`${active ? glyphs.prompt : " "} ${mark} ${label}`, width - 6, glyphs), width - 6));
  }
  rows.push(panel(queue, { ...style, width }, { title: list.length === 0 ? "nothing to triage" : `${list.length} finding${list.length === 1 ? "" : "s"}`, badge: shape.worst ? `worst open: ${shape.worst}` : "all triaged", tone: "accent" }));

  const finding = list[selected];
  if (finding) {
    const lines = detailLines(finding, width, glyphs);
    const viewport = { ...newViewport(lines, detailHeight(state.rows)), top: state.detailScroll };
    const shown = visibleLines(viewport).map((line) => padToWidth(clipTo(line, width - 6, glyphs), width - 6));
    rows.push(panel(shown, { ...style, width }, { title: "what it is, and what to do", badge: scrollIndicator(scrollFraction(viewport)), tone: finding.severity === "critical" ? "bad" : "warn" }));
  }

  // Least important hint dropped first, whole, until the legend fits. Clipping it instead would
  // cut a key name in half, and a legend that ends "Esc lea…" teaches the wrong key.
  const hints = [
    `${glyphs.arrowUp}${glyphs.arrowDown} move`,
    "f fix it",
    "i ignore",
    "Esc leave",
    `${glyphs.arrowLeft}${glyphs.arrowRight} scroll detail`,
    "o reopen",
    "a/n/1/2/3 filter",
  ];
  const separator = ` ${glyphs.middot} `;
  const legend = [...hints];
  while (legend.length > 1 && visibleWidth(legend.join(separator)) > width - 4) legend.pop();
  rows.push(note(legend.join(separator), { ...style, width }));
  return rows;
}

export type DefenderOutcome = {
  /** Findings the user asked the agent to fix, in the order they picked them. */
  toFix: TriageFinding[];
  /** The whole queue as it stood when they left, so a later pass can resume the same decisions. */
  findings: readonly TriageFinding[];
};

export type RunDefenderOptions = {
  width: number;
  rows: number;
  style: Omit<SectionStyle, "width">;
  /** Re-read before every frame so a resize cannot leave stale geometry behind. */
  getSize?: () => { width?: number; height?: number };
  /**
   * The lines around a finding, loaded on demand.
   *
   * Lazy because evidence is a file read per finding and most findings are never looked at: a scan
   * with sixty hits would otherwise pay sixty reads before drawing anything, and the person is
   * going to look at four of them.
   */
  loadEvidence?: (finding: TriageFinding) => Promise<readonly string[] | undefined>;
};

/**
 * The triage loop: draw, wait for a key, apply it, draw again.
 *
 * Returns what the user decided rather than acting on it. Pressing `f` marks a finding and moves
 * on — it does not start a turn under the screen, because a model call that begins while a
 * full-screen surface owns the terminal has nowhere to print and no way to be interrupted.
 */
export async function runDefenderTriage(
  keys: AsyncIterable<{ str?: string; key: KeypressEvent }>,
  findings: readonly PlacedSecretFinding[],
  paint: (frame: string) => void,
  options: RunDefenderOptions,
): Promise<DefenderOutcome> {
  const size = () => {
    const live = options.getSize?.();
    return { columns: live?.width ?? options.width, rows: live?.height ?? options.rows };
  };
  let state = newDefenderState(findings, size().columns, size().rows);
  const toFix: TriageFinding[] = [];
  const evidenceLoaded = new Set<string>();

  const draw = () => {
    const { columns, rows } = size();
    state = { ...state, columns, rows };
    paint(composeDefenderFrame(state, { ...options.style, width: columns }).join("\n"));
  };
  const loadSelected = async () => {
    const current = selectedFinding(state);
    if (!current || !options.loadEvidence) return;
    const key = `${current.path}:${current.line}`;
    if (evidenceLoaded.has(key)) return;
    evidenceLoaded.add(key);
    const evidence = await options.loadEvidence(current).catch(() => undefined);
    if (!evidence) return;
    state = { ...state, findings: state.findings.map((finding) => (finding.path === current.path && finding.line === current.line ? { ...finding, evidence } : finding)) };
  };

  await loadSelected();
  draw();
  for await (const input of keys) {
    const action = keyToDefenderAction(input.key, input.str);
    if (action.kind === "exit") break;
    if (action.kind === "none") continue;
    if (action.kind === "fix") {
      const current = selectedFinding(state);
      if (current && !toFix.some((finding) => finding.path === current.path && finding.line === current.line)) toFix.push(current);
    }
    state = applyDefenderAction(state, action);
    await loadSelected();
    draw();
  }
  return { toFix, findings: state.findings };
}
