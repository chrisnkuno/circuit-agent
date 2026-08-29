import { describe, expect, it } from "vitest";
import { buildStepRequest } from "./coding-step-request";
import {
  buildWanderObjective,
  CODING_SESSION,
  MIN_PLAN_STREAM_TOKENS_PER_SECOND,
  tokenBudgetFitsModelTimeout,
  WANDER_SESSION,
} from "@circuit-nova/nova-core/wander";

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
    expect(CODING_SESSION.claimLeaseMs).toBe(600_000);
    expect(CODING_SESSION.sandboxRuntimeSeconds).toBe(240);
    expect(WANDER_SESSION.claimLeaseMs).toBeLessThanOrEqual(10 * 60_000);
  });


  // A token allowance the clock cannot pay for is not a budget, it is a guaranteed timeout. A 32K
  // allowance once sat behind a 90s backstop: every detailed plan burned three attempts and lost
  // its lease before a sandbox ever existed. These bind the two numbers together.
  it("gives the coding session enough clock to actually stream its whole token allowance", () => {
    expect(tokenBudgetFitsModelTimeout(CODING_SESSION)).toBe(true);
    const secondsNeeded = CODING_SESSION.maxOutputTokens / MIN_PLAN_STREAM_TOKENS_PER_SECOND;
    expect(CODING_SESSION.modelTimeoutMs / 1_000).toBeGreaterThanOrEqual(secondsNeeded);
  });

  it("fails a session whose token budget outruns its model timeout", () => {
    // The exact shape of the regression, so the helper cannot pass everything.
    expect(tokenBudgetFitsModelTimeout({ maxOutputTokens: 32_000, modelTimeoutMs: 90_000 })).toBe(false);
  });

  it("leaves the coding sandbox real bench time inside the step deadline", () => {
    // Model call then sandbox work run serially in one Convex action with no mid-call heartbeat,
    // so the two must sum to less than the step's self-enforced stop.
    expect(CODING_SESSION.modelTimeoutMs + CODING_SESSION.sandboxRuntimeSeconds * 1_000).toBeLessThanOrEqual(
      CODING_SESSION.stepDeadlineMs,
    );
    expect(CODING_SESSION.sandboxRuntimeSeconds * 1_000).toBeGreaterThan(0);
    // The step must stop itself before Convex kills the action at ten minutes, and before the
    // lease lapses, so a failure is always recorded rather than silently retried from nothing.
    expect(CODING_SESSION.stepDeadlineMs).toBeLessThan(10 * 60_000);
    expect(CODING_SESSION.stepDeadlineMs).toBeLessThan(CODING_SESSION.claimLeaseMs);
    expect(CODING_SESSION.claimLeaseMs).toBeLessThanOrEqual(10 * 60_000);
  });

  it("keeps silence, not slowness, as the coding hang detector", () => {
    expect(CODING_SESSION.modelIdleTimeoutMs).toBeLessThan(CODING_SESSION.modelTimeoutMs);
    expect(WANDER_SESSION.modelIdleTimeoutMs).toBeLessThan(WANDER_SESSION.modelTimeoutMs);
  });

  it("adds a concrete deployability contract for the prepared Next.js workspace", () => {
    const request = buildStepRequest("Build an app", "Build a responsive inventory app", "task_3", "step_3", "next-app");
    expect(request.repositoryContext).toContain("production-deployable");
    expect(request.repositoryContext).toContain("DEPLOYMENT.md");
    expect(request.templatePrograms).toContain("npm");
  });

  // A live next-app build died on "'styled-jsx' cannot be imported from a Server Component module"
  // only after the sandbox had written the whole app. The boundary has to be stated up front.
  it("states the App Router client-boundary rule that silently breaks generated builds", () => {
    const request = buildStepRequest("Build an app", "Build an invoice dashboard", "task_4", "step_4", "next-app");
    expect(request.repositoryContext).toContain("use client");
    expect(request.repositoryContext).toMatch(/styled-jsx/);
    expect(request.repositoryContext).toMatch(/Server Component/);
  });

  // A live next-app plan exhausted its whole 32K output budget and died truncated. The contract
  // had told the model the starter was already present and, in the same breath, that the source
  // "must include package.json and its lockfile" — so the plan wrote the scaffolding back out.
  it("tells the app workspace not to re-emit scaffolding it already has", () => {
    const request = buildStepRequest("Build an app", "Build an expense tracker page", "task_6", "step_6", "next-app");
    expect(request.repositoryContext).toMatch(/never output a lockfile/i);
    expect(request.repositoryContext).toMatch(/do not rewrite, regenerate or re-emit/i);
    // Deployability must survive as a property of the result, not as a list of files to reproduce.
    expect(request.repositoryContext).toContain("DEPLOYMENT.md");
    expect(request.repositoryContext).toMatch(/production-deployable/i);
    // The old wording is the regression: it is what made plans emit a lockfile.
    expect(request.repositoryContext).not.toMatch(/must include package\.json and its lockfile/i);
  });

  it("keeps the App Router rule out of non-Next workspaces", () => {
    const request = buildStepRequest("CSV tool", "Build a Python CSV validator", "task_5", "step_5");
    expect(request.repositoryContext).not.toContain("use client");
  });
});
