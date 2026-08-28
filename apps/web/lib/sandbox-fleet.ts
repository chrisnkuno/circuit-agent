import { billingEfficiency } from "./sandbox-metrics";

/**
 * Deriving what a person needs to know about a fleet of E2B sandboxes from the rows Convex
 * stores about them.
 *
 * Kept pure and out of the component so the rules that decide "is this sandbox actually doing
 * something right now" are stated once and can be tested without a browser or a provider.
 */

/** The subset of `api.sandboxes.listForOrganization` rows these rules read. */
export type SandboxRow = {
  sandboxId: string;
  runStatus: string;
  activeStepTitle: string | null;
  heartbeatAt: number | null;
  startedAt: number;
  sandboxMs: number;
  workspacePresetId: string | null;
};

/**
 * `running` means a step holds the sandbox and is still checking in. `idle` is the normal
 * resting state between steps — E2B keeps the machine, nothing is executing, and it is not
 * billed. `paused` is a deliberately suspended sandbox, and `stopped` a finished one.
 *
 * Distinguishing idle from running matters because idle is free: a panel that called every
 * live sandbox "running" would make an ordinary run look like runaway spend. `starting` is the
 * gap between approval and E2B handing back an id — real, visible, and about half a minute long.
 */
export type SandboxState = "starting" | "running" | "idle" | "paused" | "stopped";

/** A step that stopped checking in this long ago is no longer holding the sandbox. */
export const HEARTBEAT_STALE_MS = 90_000;

export function sandboxState(row: SandboxRow, now: number): SandboxState {
  if (row.runStatus === "paused") return "paused";
  if (!row.sandboxId) return "starting";
  if (["completed", "failed", "blocked", "cancelled"].includes(row.runStatus)) return "stopped";
  if (!row.activeStepTitle) return "idle";
  if (row.heartbeatAt !== null && now - row.heartbeatAt > HEARTBEAT_STALE_MS) return "idle";
  return "running";
}

/** Compact, tabular durations: a fleet panel reads as a column of numbers, not of prose. */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export type SandboxSummary = {
  state: SandboxState;
  uptimeMs: number;
  uptime: string;
  /** Only the time a step actually held the machine — what E2B charges for. */
  billed: string;
  /** Billed over uptime: how much of this sandbox's life was actually paid for. */
  efficiency: number;
  template: string;
  activity: string;
};

export function describeSandbox(row: SandboxRow, now: number): SandboxSummary {
  const state = sandboxState(row, now);
  const uptimeMs = Math.max(0, now - row.startedAt);
  return {
    state,
    uptimeMs,
    uptime: formatDuration(uptimeMs),
    billed: formatDuration(row.sandboxMs),
    efficiency: billingEfficiency(row.sandboxMs, uptimeMs),
    template: row.workspacePresetId ?? "default",
    activity: state === "running" && row.activeStepTitle ? row.activeStepTitle
      : state === "starting" ? "asking E2B for a machine"
      : state === "paused" ? "suspended by you"
      : state === "stopped" ? "run finished"
      : "waiting between steps",
  };
}

export type FleetSummary = { total: number; running: number; idle: number; paused: number; billedMs: number };

/** Newest first: the sandbox someone just started is the one they are looking for. */
export function orderFleet<T extends SandboxRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.startedAt - a.startedAt);
}

export function summarizeFleet(rows: readonly SandboxRow[], now: number): FleetSummary {
  const summary: FleetSummary = { total: rows.length, running: 0, idle: 0, paused: 0, billedMs: 0 };
  for (const row of rows) {
    summary.billedMs += row.sandboxMs;
    const state = sandboxState(row, now);
    if (state === "running") summary.running += 1;
    else if (state === "paused") summary.paused += 1;
    else if (state === "idle") summary.idle += 1;
  }
  return summary;
}
