import { estimateTaskCost, formatRwf, type TaskKind } from "./task-cost";
import { capabilityRegistry } from "./capability-registry";

export type TerminalLineTone = "system" | "muted" | "agent" | "tool" | "success" | "warn" | "error" | "accent";

export type TerminalLine = {
  tone: TerminalLineTone;
  text: string;
  /** Delay in ms before this line is revealed, relative to the previous line. */
  delayMs: number;
  /** Whether the orbit/spinner glyph should animate while this line is the most recent one. */
  spinner?: boolean;
};

export type WanderCadenceCommand = "once" | "daily" | "weekly";

export type ParsedCommand =
  | { kind: "help" }
  | { kind: "about" }
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "run"; taskKind: TaskKind; objective: string }
  | { kind: "wander"; cadence: WanderCadenceCommand; topic: string | null }
  | { kind: "empty" }
  | { kind: "unknown"; raw: string };

export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export const ORBIT_FRAMES = [
  "(*        )",
  "(  *      )",
  "(    *    )",
  "(      *  )",
  "(        *)",
  "(      *  )",
  "(    *    )",
  "(  *      )",
];

const TASK_KIND_ALIASES: Record<string, TaskKind> = {
  coding: "coding", code: "coding", build: "coding",
  research: "research",
  writing: "writing", write: "writing",
  operations: "operations", ops: "operations",
};

const TASK_KIND_LIST: TaskKind[] = ["coding", "research", "writing", "operations"];

export type StageStatus = "pending" | "active" | "completed" | "failed";
export type Stage = { key: string; label: string; status: StageStatus };

/**
 * Reuses the same stage vocabulary the real workflows use (see taskWorkflows in
 * lib/agent-orchestration.ts) so the art reflects the product's actual steps rather than
 * inventing decorative ones. Coding is the only kind with a live worker today; the other
 * three back a simulated preview, but the labels still describe the real intended workflow.
 */
const STAGE_LABELS: Record<TaskKind, string[]> = {
  coding: ["inspect", "reproduce", "implement", "checks"],
  research: ["scope", "sources", "synthesis", "review"],
  writing: ["brief", "draft", "revise", "review"],
  operations: ["inspect", "propose", "approve", "execute"],
};

export function stageKeysFor(taskKind: TaskKind): string[] {
  return STAGE_LABELS[taskKind];
}

export function parseCommand(input: string): ParsedCommand {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  const [head, ...rest] = trimmed.split(/\s+/);
  const command = head.toLowerCase();
  if (command === "help" || command === "?") return { kind: "help" };
  if (command === "about") return { kind: "about" };
  if (command === "status") return { kind: "status" };
  if (command === "clear") return { kind: "clear" };
  if (command === "wander") {
    const maybeCadence = rest[0]?.toLowerCase();
    const cadence: WanderCadenceCommand =
      maybeCadence === "daily" || maybeCadence === "weekly" || maybeCadence === "once" ? maybeCadence : "once";
    const topicWords = maybeCadence === "daily" || maybeCadence === "weekly" || maybeCadence === "once" ? rest.slice(1) : rest;
    const topic = topicWords.join(" ").trim() || null;
    return { kind: "wander", cadence, topic };
  }
  if (command === "run") {
    const maybeKind = rest[0]?.toLowerCase();
    const alias = maybeKind ? TASK_KIND_ALIASES[maybeKind] : undefined;
    const taskKind: TaskKind = alias ?? "coding";
    const objectiveWords = alias ? rest.slice(1) : rest;
    const objective = objectiveWords.join(" ").trim();
    if (!objective) return { kind: "unknown", raw: input };
    return { kind: "run", taskKind, objective };
  }
  return { kind: "unknown", raw: input };
}

function boxLine(width: number, char: string): string {
  return char.repeat(width);
}

export function buildBanner(): string {
  const title = "CIRCUIT · NOVA  //  AGENT TERMINAL";
  const width = title.length + 4;
  return [`╔${boxLine(width, "═")}╗`, `║  ${title}  ║`, `╚${boxLine(width, "═")}╝`].join("\n");
}

export function buildHelpLines(): TerminalLine[] {
  return [
    { tone: "system", text: "Available commands:", delayMs: 0 },
    { tone: "muted", text: '  run coding <objective>          REAL agent run — real model, real E2B sandbox, real RWF cost', delayMs: 40 },
    { tone: "muted", text: "  wander [once|daily|weekly] [topic]   REAL — Exa briefing + contested research notebook in sandbox", delayMs: 40 },
    { tone: "muted", text: "  run research|writing|operations <objective>   simulated preview — no live worker exists for these yet", delayMs: 40 },
    { tone: "muted", text: "  status                                                  show capability + provider readiness", delayMs: 40 },
    { tone: "muted", text: "  about                                                    what this terminal is (and isn't)", delayMs: 40 },
    { tone: "muted", text: "  clear                                                    clear the screen", delayMs: 40 },
    { tone: "muted", text: "  help                                                     show this message", delayMs: 40 },
  ];
}

export function buildAboutLines(): TerminalLine[] {
  return [
    { tone: "system", text: '"run coding <objective>" is real: it creates an actual task and run in Convex, dispatches a real model, executes in a real E2B sandbox, and spends real (small) RWF against your workspace cap.', delayMs: 0 },
    { tone: "muted", text: "It only runs the steps that have a live worker today (inspect, reproduce, implement, checks) — the approval-gated review step is intentionally left out because no reviewer worker exists yet.", delayMs: 60 },
    { tone: "muted", text: '"wander" is also real: Exa scouts literature once on the control plane, then the coding sandbox writes a contested notebook (hypotheses, methods critique, rival view, graded consensus). The sandbox itself has no network.', delayMs: 60 },
    { tone: "muted", text: "Every other task kind (research, writing, operations) still plays back a scripted, clearly-labeled simulation, because those workers are not built.", delayMs: 60 },
  ];
}

export function buildStatusLines(): TerminalLine[] {
  const lines: TerminalLine[] = [{ tone: "system", text: "Capability registry (simulation reads the real manifest):", delayMs: 0 }];
  for (const taskKind of TASK_KIND_LIST) {
    const capabilities = capabilityRegistry.defaultsFor(taskKind);
    lines.push({ tone: "muted", text: `  ${taskKind.padEnd(11)} ${capabilities.map((c) => c.id).join(", ")}`, delayMs: 50 });
  }
  return lines;
}

export function buildUnknownCommandLines(raw: string): TerminalLine[] {
  return [{ tone: "error", text: `command not found: ${raw.trim() || "(empty)"} — type "help"`, delayMs: 0 }];
}

/** Deterministic per-input pseudo-random generator so a scripted session is reproducible for the same objective, yet varies across objectives. */
function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let index = 0; index < seed.length; index += 1) {
    h = Math.imul(h ^ seed.charCodeAt(index), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822519);
    h = Math.imul(h ^ (h >>> 13), 3266489917);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

type ToolStep = { name: string; args: string; result: string };

function buildToolPlan(taskKind: TaskKind, objective: string, rand: () => number): ToolStep[] {
  if (taskKind === "coding") {
    const fileName = slugForFile(objective);
    return [
      { name: "list_files", args: `"."`, result: "3 files in /workspace/repo" },
      { name: "read_file", args: `"package.json"`, result: "read 812 bytes" },
      { name: "write_file", args: `"${fileName}.js"`, result: `wrote ${60 + Math.floor(rand() * 400)} bytes` },
      { name: "write_file", args: `"${fileName}.test.js"`, result: `wrote ${80 + Math.floor(rand() * 300)} bytes` },
      { name: "run_command", args: `node --test`, result: "exit 0" },
    ];
  }
  if (taskKind === "research") {
    return [
      { name: "web_search", args: `"${clip(objective, 40)}"`, result: `${3 + Math.floor(rand() * 5)} sources found` },
      { name: "read_source", args: "source[1]", result: "extracted key claims + citation" },
      { name: "read_source", args: "source[2]", result: "extracted key claims + citation" },
      { name: "compose_summary", args: "provenance-checked", result: "draft recommendation ready" },
    ];
  }
  if (taskKind === "writing") {
    return [
      { name: "outline", args: `"${clip(objective, 40)}"`, result: "structured brief ready" },
      { name: "write_file", args: `"draft.md"`, result: `wrote ${300 + Math.floor(rand() * 900)} bytes` },
      { name: "revise", args: "voice + accuracy pass", result: "revision complete" },
    ];
  }
  return [
    { name: "inspect_state", args: "current policy + context", result: "baseline captured" },
    { name: "propose_action", args: `"${clip(objective, 40)}"`, result: "awaiting human approval" },
  ];
}

function slugForFile(objective: string): string {
  const slug = objective.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "task";
  return slug;
}

function clip(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

/**
 * Builds a full scripted agent session: quote, capability load, planner turns, tool calls,
 * verification, and settlement. Deliberately mirrors the real system's vocabulary (RWF
 * quoting, capability IDs, tool names, evidence kinds) and observed live-run shape rather
 * than inventing generic flavor text, while staying unmistakably a simulation.
 */
export function buildRunSessionLines(taskKind: TaskKind, objective: string): TerminalLine[] {
  const rand = seededRandom(`${taskKind}:${objective}`);
  const capabilities = capabilityRegistry.defaultsFor(taskKind);
  const quote = estimateTaskCost({ kind: taskKind, quality: "balanced", attachmentCount: 0, requiresBrowser: false, requiresSandbox: taskKind !== "writing" });

  const lines: TerminalLine[] = [];
  const push = (tone: TerminalLineTone, text: string, delayMs: number, spinner = false) => lines.push({ tone, text, delayMs, spinner });

  push("system", `New ${taskKind} run — objective: "${objective}"`, 100);
  push("muted", `quote ${formatRwf(quote.estimateLowRwf)}–${formatRwf(quote.estimateHighRwf)} · cap ${formatRwf(quote.maxRwf)} · ${quote.confidence} confidence`, 240);
  push("muted", `capabilities loaded: ${capabilities.map((c) => c.id).join(", ")}`, 200);
  push("agent", "planner turn 1 — inspecting objective and workspace", 480, true);

  const plan = buildToolPlan(taskKind, objective, rand);
  let turn = 2;
  for (const step of plan) {
    push("tool", `→ ${step.name}(${step.args})`, 320 + Math.floor(rand() * 260), true);
    push("muted", `  ${step.result}`, 200 + Math.floor(rand() * 200));
    if (step.name === "run_command" || step.name === "compose_summary" || step.name === "revise") {
      push("agent", `planner turn ${turn} — reviewing evidence`, 360, true);
      turn += 1;
    }
  }

  const needsApproval = taskKind === "operations";
  if (needsApproval) {
    push("warn", "external action requires approval — pausing at the gate", 260);
    push("muted", "  (this is a real invariant: consequential actions never execute unattended)", 200);
    return lines;
  }

  const cleanRun = rand() > 0.15;
  if (!cleanRun) {
    push("warn", "  first check failed — revising and re-verifying", 280);
    push("tool", "→ run_command(node --test)", 420, true);
  }
  push("success", "  ✓ verification passed", 260);

  const actualRwf = Math.max(4, Math.round(quote.estimateLowRwf * (0.02 + rand() * 0.05)));
  const durationSeconds = (7 + rand() * 21).toFixed(1);
  push("success", `run completed in ${durationSeconds}s — settled ${formatRwf(actualRwf)} of ${formatRwf(quote.maxRwf)} cap`, 220);
  push("muted", "evidence recorded: model_plan, command_log, patch, test_log (simulation only — nothing persisted)", 160);

  return lines;
}

const CELL_WIDTH = 10;

function padCenter(text: string, width: number): string {
  const clipped = text.slice(0, width);
  const totalPad = Math.max(0, width - clipped.length);
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return " ".repeat(left) + clipped + " ".repeat(right);
}

function glyphFor(status: StageStatus, spinnerFrame: string): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✗";
  if (status === "active") return spinnerFrame;
  return "·";
}

/**
 * Renders a boxed pipeline of stages, e.g.:
 * ┌──────────┐──▶┌──────────┐──▶┌──────────┐──▶┌──────────┐
 * │  INSPECT │   │ REPRODUCE│   │ IMPLEMENT│   │  CHECKS  │
 * │    ✓     │   │    ⠋     │   │    ·     │   │    ·     │
 * └──────────┘   └──────────┘   └──────────┘   └──────────┘
 * `spinnerFrame` only shows on whichever stage is currently active; every other stage shows
 * a fixed glyph, so nothing here claims progress that hasn't actually happened.
 */
export function renderStageTrack(stages: Stage[], spinnerFrame: string): string {
  if (stages.length === 0) throw new Error("renderStageTrack requires at least one stage");
  const top = stages.map(() => `┌${"─".repeat(CELL_WIDTH)}┐`).join("──▶");
  const label = stages.map((stage) => `│${padCenter(stage.label.toUpperCase(), CELL_WIDTH)}│`).join("   ");
  const glyph = stages.map((stage) => `│${padCenter(glyphFor(stage.status, spinnerFrame), CELL_WIDTH)}│`).join("   ");
  const bottom = stages.map(() => `└${"─".repeat(CELL_WIDTH)}┘`).join("   ");
  return [top, label, glyph, bottom].join("\n");
}

/**
 * A narrow-viewport alternative to renderStageTrack: the boxed pipeline needs ~57 columns,
 * which clips on a phone-width screen even at the smallest legible font size. This lists the
 * same stages vertically instead, needing only as many columns as the longest label.
 */
export function renderStageTrackVertical(stages: Stage[], spinnerFrame: string): string {
  if (stages.length === 0) throw new Error("renderStageTrackVertical requires at least one stage");
  const labelWidth = Math.max(...stages.map((stage) => stage.label.length));
  const lines: string[] = [];
  stages.forEach((stage, index) => {
    lines.push(`${stage.label.toUpperCase().padEnd(labelWidth)}  ${glyphFor(stage.status, spinnerFrame)}`);
    if (index < stages.length - 1) lines.push("│");
  });
  return lines.join("\n");
}

export const CELEBRATION_FRAMES = [
  "   ·        ✦        ·   \n ✧    ╔══════════════╗    · \n   ·  ║  TASK DONE ✓ ║  ✦ \n ·    ╚══════════════╝    · \n    ✦     ·      ✧        ",
  "   ✦        ·        ✧   \n ·    ╔══════════════╗    ✦ \n   ✧  ║  TASK DONE ✓ ║  · \n ✦    ╚══════════════╝    · \n    ·     ✧      ·        ",
  "   ✧        ✦        ·   \n ✦    ╔══════════════╗    ✧ \n   ·  ║  TASK DONE ✓ ║  ✦ \n ·    ╚══════════════╝    ✧ \n    ✧     ·      ✦        ",
];

export function renderFailureBanner(): string {
  return "┌──────────────────┐\n│   RUN FAILED  ✗   │\n└──────────────────┘";
}
