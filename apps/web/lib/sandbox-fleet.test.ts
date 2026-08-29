import { describe, expect, it } from "vitest";
import { describeSandbox, formatDuration, orderFleet, sandboxState, summarizeFleet, HEARTBEAT_STALE_MS, type SandboxRow } from "./sandbox-fleet";

const now = 1_700_000_000_000;

function row(overrides: Partial<SandboxRow> = {}): SandboxRow {
  return {
    sandboxId: "sbx_1",
    runStatus: "running",
    activeStepTitle: "Install dependencies",
    phase: "building",
    planBytes: null,
    heartbeatAt: now - 2_000,
    startedAt: now - 65_000,
    sandboxMs: 12_000,
    workspacePresetId: "next-app",
    ...overrides,
  };
}

describe("sandboxState", () => {
  it("separates a sandbox a step is holding from one merely kept alive", () => {
    // The distinction is the whole point: idle time is not billed, so calling it "running"
    // would make every ordinary run look like runaway spend.
    expect(sandboxState(row(), now)).toBe("running");
    expect(sandboxState(row({ activeStepTitle: null }), now)).toBe("idle");
  });

  it("treats a step that stopped checking in as no longer holding the sandbox", () => {
    expect(sandboxState(row({ heartbeatAt: now - HEARTBEAT_STALE_MS - 1 }), now)).toBe("idle");
    expect(sandboxState(row({ heartbeatAt: now - HEARTBEAT_STALE_MS + 1 }), now)).toBe("running");
  });

  it("reports an approved run with no machine yet as starting, not as missing", () => {
    // This half-minute is real, and calling it "nothing running" while E2B provisions is a lie
    // told at exactly the moment someone is watching hardest.
    expect(sandboxState(row({ sandboxId: "" }), now)).toBe("starting");
    expect(describeSandbox(row({ sandboxId: "" }), now).activity).toBe("asking E2B for a machine");
    // A paused run without a machine is still paused: the deliberate state wins.
    expect(sandboxState(row({ sandboxId: "", runStatus: "paused" }), now)).toBe("paused");
  });

  it("reports a deliberately suspended sandbox as paused and a finished run as stopped", () => {
    expect(sandboxState(row({ runStatus: "paused", activeStepTitle: null }), now)).toBe("paused");
    for (const status of ["completed", "failed", "blocked", "cancelled"]) {
      expect(sandboxState(row({ runStatus: status }), now)).toBe("stopped");
    }
  });

  it("reports a live machine whose step is still writing the plan as planning, not as a stuck run", () => {
    // Change 1 creates the sandbox before the plan call, so a fresh heartbeat with an empty
    // machine is now normal for minutes. Calling that "running" would show four zeroed meters.
    expect(sandboxState(row({ phase: "planning" }), now)).toBe("planning");
    // Once the plan is in hand and the build starts, it is an ordinary running sandbox again.
    expect(sandboxState(row({ phase: "building" }), now)).toBe("running");
    // Planning only holds while the worker is still checking in; a stalled one falls back to idle.
    expect(sandboxState(row({ phase: "planning", heartbeatAt: now - HEARTBEAT_STALE_MS - 1 }), now)).toBe("idle");
    // A paused run wins over planning: the deliberate state is not overridden by a stale phase.
    expect(sandboxState(row({ phase: "planning", runStatus: "paused" }), now)).toBe("paused");
    // No machine yet still reads as starting even if a phase was recorded.
    expect(sandboxState(row({ phase: "planning", sandboxId: "" }), now)).toBe("starting");
  });

  it("shows how much of the plan has streamed in while planning", () => {
    expect(describeSandbox(row({ phase: "planning", planBytes: null }), now).activity).toBe("planning the build");
    expect(describeSandbox(row({ phase: "planning", planBytes: 0 }), now).activity).toBe("planning the build");
    expect(describeSandbox(row({ phase: "planning", planBytes: 12_288 }), now).activity).toBe("planning the build · 12 KB");
    // Any nonzero amount rounds up to at least 1 KB rather than showing "0 KB".
    expect(describeSandbox(row({ phase: "planning", planBytes: 200 }), now).activity).toBe("planning the build · 1 KB");
  });

  it("counts a planning machine as running for the fleet cost summary", () => {
    const summary = summarizeFleet([row({ phase: "planning" }), row({ phase: "building" })], now);
    expect(summary.running).toBe(2);
  });
});

describe("formatDuration", () => {
  it("stays compact across every scale a run reaches", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-5_000)).toBe("0s");
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(125_000)).toBe("2m 5s");
    expect(formatDuration(7_380_000)).toBe("2h 3m");
  });
});

describe("describeSandbox", () => {
  it("names what the sandbox is doing rather than leaving the line blank", () => {
    expect(describeSandbox(row(), now).activity).toBe("Install dependencies");
    expect(describeSandbox(row({ activeStepTitle: null }), now).activity).toBe("waiting between steps");
    expect(describeSandbox(row({ runStatus: "paused" }), now).activity).toBe("suspended by you");
  });

  it("separates uptime from billed time, because only one of them costs money", () => {
    const summary = describeSandbox(row({ startedAt: now - 600_000, sandboxMs: 30_000 }), now);
    expect(summary.uptime).toBe("10m 0s");
    expect(summary.billed).toBe("30s");
    expect(summary.efficiency).toBeCloseTo(0.05, 10);
  });

  it("falls back to a named template rather than printing null", () => {
    expect(describeSandbox(row({ workspacePresetId: null }), now).template).toBe("default");
  });
});

describe("summarizeFleet", () => {
  it("counts each state separately and totals only billed time", () => {
    const summary = summarizeFleet([
      row({ sandboxMs: 1_000 }),
      row({ activeStepTitle: null, sandboxMs: 2_000 }),
      row({ runStatus: "paused", sandboxMs: 4_000 }),
      row({ runStatus: "completed", sandboxMs: 8_000 }),
    ], now);
    expect(summary).toEqual({ total: 4, running: 1, idle: 1, paused: 1, billedMs: 15_000 });
  });

  it("is empty rather than undefined for a workspace with no sandboxes", () => {
    expect(summarizeFleet([], now)).toEqual({ total: 0, running: 0, idle: 0, paused: 0, billedMs: 0 });
  });
});

describe("orderFleet", () => {
  it("puts the newest sandbox first without mutating the query result", () => {
    const rows = [row({ sandboxId: "old", startedAt: now - 900_000 }), row({ sandboxId: "new", startedAt: now - 1_000 })];
    expect(orderFleet(rows).map((entry) => entry.sandboxId)).toEqual(["new", "old"]);
    expect(rows[0].sandboxId).toBe("old");
  });
});
