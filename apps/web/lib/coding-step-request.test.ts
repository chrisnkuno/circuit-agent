import { describe, expect, it } from "vitest";
import { buildStepRequest } from "./coding-step-request";
import { buildWanderObjective, CODING_SESSION, WANDER_SESSION } from "@circuit-nova/nova-core/wander";

describe("coding step request session budgets", () => {
  it("keeps everyday coding on the tight default session", () => {
    const request = buildStepRequest("Add README", "add a README", "task_1", "step_1");
    expect(request.maxCommands).toBe(CODING_SESSION.maxCommands);
    expect(request.maxOutputTokens).toBe(CODING_SESSION.maxOutputTokens);
    expect(request.timeoutMs).toBe(CODING_SESSION.modelTimeoutMs);
    expect(request.reasoningEffort).toBe(CODING_SESSION.reasoningEffort);
    expect(request.workspaceSeedFiles).toBeUndefined();
  });

  it("gives Wander the ~8-minute lab session without changing coding defaults", () => {
    const objective = buildWanderObjective("coral bleaching interventions");
    const request = buildStepRequest("Wander", objective, "task_2", "step_2", undefined, "# Literature briefing\n");
    expect(request.maxCommands).toBe(WANDER_SESSION.maxCommands);
    expect(request.maxOutputTokens).toBe(WANDER_SESSION.maxOutputTokens);
    expect(request.timeoutMs).toBe(WANDER_SESSION.modelTimeoutMs);
    // The relay's ~90s ceiling now binds silence, not the whole call: the plan streams, so a
    // notebook may take minutes to write as long as tokens keep arriving.
    expect(request.idleTimeoutMs).toBe(WANDER_SESSION.modelIdleTimeoutMs);
    expect(request.idleTimeoutMs).toBeLessThan(90_000);
    expect(request.timeoutMs).toBeGreaterThan(90_000);
    expect(request.reasoningEffort).toBe("low");
    expect(request.reasoningEffort).toBe(WANDER_SESSION.reasoningEffort);
    expect(request.workspaceSeedFiles).toEqual([{ path: "wander/EVIDENCE.md", content: "# Literature briefing\n" }]);
    // Lease/sandbox live outside the model request but must dominate coding defaults.
    expect(WANDER_SESSION.claimLeaseMs).toBe(600_000);
    // Model backstop plus sandbox work has to fit the 10-minute Convex action running the step.
    expect(WANDER_SESSION.modelTimeoutMs).toBeLessThan(WANDER_SESSION.claimLeaseMs);
    // Eight full minutes of bench time for the lab.
    expect(WANDER_SESSION.sandboxRuntimeSeconds).toBe(480);
    // Self-enforced stop, safely inside the 10-minute Convex action that runs the whole step.
    expect(WANDER_SESSION.stepDeadlineMs).toBeLessThan(10 * 60_000);
    expect(WANDER_SESSION.stepDeadlineMs).toBeGreaterThanOrEqual(WANDER_SESSION.sandboxRuntimeSeconds * 1_000);
    expect(CODING_SESSION.claimLeaseMs).toBe(180_000);
    expect(CODING_SESSION.sandboxRuntimeSeconds).toBe(300);
    expect(WANDER_SESSION.claimLeaseMs).toBeLessThanOrEqual(10 * 60_000);
  });
});
