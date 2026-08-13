import { BOLD, CYAN, DIM, YELLOW, paint, paintAll } from "./ansi";
import { UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { GUTTER, keyValues, type SectionStyle } from "./sections";

/**
 * Slow mode: spend less per turn, on purpose.
 *
 * An agent left at full stride will happily burn a day's budget answering a question you thought
 * was small — sixty model iterations, eight parallel tool calls each, and the first you hear of it
 * is the number in the status bar. The existing controls are all *ceilings on the session*
 * (`--budget`) or on the runaway case (the runtime's own guards); neither changes the rate.
 *
 * This does. Every knob it turns is one the runtime already has, so nothing new can go wrong in the
 * agent loop:
 *
 * - `maxIterations` — how many times the model may go round before it has to come back and report.
 * - `maxToolCallsPerTurn` — how much it may do in one of those rounds.
 * - `maxOutputTokens` — how long a single reply may be.
 *
 * Plus two things that live in the CLI: a cooldown between turns, and a confirmation when a turn's
 * *estimate* is bigger than the pace allows. The cooldown matters more than it looks — the way a
 * budget actually evaporates is a fast back-and-forth where nobody stops to read, and a few seconds
 * of enforced pause is where a person notices the agent has misunderstood them.
 *
 * Not a safety feature and not sold as one: it is a spending pace. `--budget` remains the hard cap.
 */

export type PaceLevel = "off" | "gentle" | "strict";

export type PaceProfile = {
  level: PaceLevel;
  label: string;
  description: string;
  /** Merged over the runtime's defaults; omitted keys keep whatever the runtime already uses. */
  budgets: { maxIterations?: number; maxToolCallsPerTurn?: number; maxOutputTokens?: number };
  /** Enforced quiet time between the end of one turn and the start of the next. */
  cooldownMs: number;
  /** Estimated tokens for one turn past which the turn is confirmed rather than simply started. */
  confirmAboveTokens?: number;
};

export const PACE_PROFILES: Record<PaceLevel, PaceProfile> = {
  off: {
    level: "off",
    label: "full speed",
    description: "No pacing — the runtime's own limits are the only ceiling.",
    budgets: {},
    cooldownMs: 0,
  },
  gentle: {
    level: "gentle",
    label: "slow",
    description: "Fewer model rounds and smaller replies; a turn that looks expensive asks first.",
    budgets: { maxIterations: 20, maxToolCallsPerTurn: 4, maxOutputTokens: 4_000 },
    cooldownMs: 0,
    confirmAboveTokens: 60_000,
  },
  strict: {
    level: "strict",
    label: "very slow",
    description: "Short leash: a handful of rounds, two tools at a time, a pause between turns.",
    budgets: { maxIterations: 8, maxToolCallsPerTurn: 2, maxOutputTokens: 2_000 },
    cooldownMs: 6_000,
    confirmAboveTokens: 25_000,
  },
};

export function profileFor(level: PaceLevel): PaceProfile {
  return PACE_PROFILES[level];
}

/** `--slow`, `--slow strict`, `--pace off` — the argv spelling. */
export function parsePaceFlag(value: string | undefined): PaceLevel | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized === "") return undefined;
  if (normalized === "on" || normalized === "gentle" || normalized === "slow") return "gentle";
  if (normalized === "strict" || normalized === "very" || normalized === "max") return "strict";
  if (normalized === "off" || normalized === "none" || normalized === "full") return "off";
  return undefined;
}

export type PaceCommand = { kind: "show" } | { kind: "set"; level: PaceLevel } | { kind: "invalid"; reason: string };

/** `/slow`, `/slow strict`, `/slow off`. Bare `/slow` toggles into gentle from off, and reports otherwise. */
export function parsePaceCommand(input: string, current: PaceLevel): PaceCommand | null {
  const match = /^\/(?:slow|pace)(?:\s+(\S+))?$/.exec(input.trim());
  if (!match) return null;
  if (match[1] === undefined) return current === "off" ? { kind: "set", level: "gentle" } : { kind: "show" };
  const level = parsePaceFlag(match[1]);
  return level
    ? { kind: "set", level }
    : { kind: "invalid", reason: `/slow takes "on", "strict", or "off" — not "${match[1]}".` };
}

/** The runtime budgets for a pace, merged over whatever the caller was already passing. */
export function applyPacing<T extends Record<string, number>>(base: T, level: PaceLevel): T & PaceProfile["budgets"] {
  return { ...base, ...PACE_PROFILES[level].budgets };
}

/** Milliseconds still owed before the next turn may start. Zero when the pace has no cooldown. */
export function remainingCooldown(level: PaceLevel, lastTurnEndedAt: number | undefined, now = Date.now()): number {
  const cooldown = PACE_PROFILES[level].cooldownMs;
  if (cooldown === 0 || lastTurnEndedAt === undefined) return 0;
  return Math.max(0, cooldown - (now - lastTurnEndedAt));
}

/**
 * Whether a turn's forecast is big enough that the pace wants it confirmed.
 *
 * Measured on the *high* end of the estimate on purpose: the point of asking is to catch the turn
 * that could be expensive, and a midpoint hides exactly that case behind an average.
 */
export function exceedsPace(
  level: PaceLevel,
  prediction: { inputTokensHigh: number; outputTokensHigh: number },
): boolean {
  const ceiling = PACE_PROFILES[level].confirmAboveTokens;
  if (ceiling === undefined) return false;
  return prediction.inputTokensHigh + prediction.outputTokensHigh > ceiling;
}

/** The compact marker the status line and prompt carry while a pace is on. */
export function paceBadge(level: PaceLevel, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  if (level === "off") return "";
  return `${glyphs.paused} ${PACE_PROFILES[level].label}`;
}

/** What `/slow` prints: the pace, what it changes, and how to leave it. */
export function describePace(level: PaceLevel, style: SectionStyle): string {
  const profile = PACE_PROFILES[level];
  const glyphs = style.glyphs ?? UNICODE_GLYPHS;
  const head = `${GUTTER}${paintAll(profile.label, [CYAN, BOLD], style.depth)} ${paint(glyphs.middot, DIM, style.depth)} ${paint(profile.description, DIM, style.depth)}`;
  if (level === "off") return head;
  const rows: [string, string][] = [
    ["model rounds", String(profile.budgets.maxIterations ?? "runtime default")],
    ["tools per round", String(profile.budgets.maxToolCallsPerTurn ?? "runtime default")],
    ["reply ceiling", `${(profile.budgets.maxOutputTokens ?? 0).toLocaleString()} tokens`],
    ["pause between turns", profile.cooldownMs > 0 ? `${Math.round(profile.cooldownMs / 1_000)}s` : "none"],
    ["confirm turns above", profile.confirmAboveTokens ? `${profile.confirmAboveTokens.toLocaleString()} estimated tokens` : "never"],
  ];
  return [head, keyValues(rows, style), `${GUTTER}${paint("/slow off returns to full speed", YELLOW, style.depth)}`].join("\n");
}
