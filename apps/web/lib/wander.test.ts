import { describe, expect, it } from "vitest";
import {
  buildWanderObjective,
  buildWanderScheduleObjective,
  CODING_SESSION,
  expandWanderObjective,
  isWanderObjective,
  isWanderRandomScheduleObjective,
  pickWanderTopic,
  resolveExecutionSession,
  WANDER_LAB_FILES,
  WANDER_OBJECTIVE_MAX,
  WANDER_SESSION,
  WANDER_TOPIC_CATALOG,
  wanderPlannerInstructions,
} from "@circuit-nova/nova-core/wander";
import { extractWanderTopic } from "./wander-research";

describe("Wander objectives", () => {
  it("detects Wander even when a task title is prefixed before the marker", () => {
    const objective = buildWanderObjective("coral bleaching");
    expect(isWanderObjective(objective)).toBe(true);
    expect(isWanderObjective(`Wander daily. ${objective}`)).toBe(true);
    expect(isWanderObjective("add a README")).toBe(false);
  });

  it("builds a bounded scientific-lab objective inside the orchestration limit", () => {
    const objective = buildWanderObjective("how sleep affects memory consolidation");
    expect(isWanderObjective(objective)).toBe(true);
    expect(objective.length).toBeLessThanOrEqual(WANDER_OBJECTIVE_MAX);
    expect(objective).toContain("HYPOTHESES.md");
    expect(objective).toContain("CONSENSUS.md");
    expect(objective).toContain("verified|strong_plausible|speculative");
    expect(extractWanderTopic(objective)).toBe("how sleep affects memory consolidation");
  });

  it("rejects a blank topic", () => {
    expect(() => buildWanderObjective("   ")).toThrow(/required/i);
  });

  it("clips an oversized topic rather than overflowing the limit", () => {
    const objective = buildWanderObjective("x".repeat(400));
    expect(objective.length).toBeLessThanOrEqual(WANDER_OBJECTIVE_MAX);
  });

  it("marks daily/weekly schedules as random-topic placeholders", () => {
    const daily = buildWanderScheduleObjective("daily");
    const weekly = buildWanderScheduleObjective("weekly");
    expect(isWanderRandomScheduleObjective(daily)).toBe(true);
    expect(isWanderRandomScheduleObjective(weekly)).toBe(true);
    expect(isWanderRandomScheduleObjective(buildWanderObjective("a topic"))).toBe(false);
  });

  it("expands a random schedule marker into a concrete catalog topic", () => {
    const expanded = expandWanderObjective(buildWanderScheduleObjective("weekly"), "seed-42");
    expect(isWanderObjective(expanded)).toBe(true);
    expect(isWanderRandomScheduleObjective(expanded)).toBe(false);
    expect(WANDER_TOPIC_CATALOG.some((topic) => expanded.includes(topic.slice(0, 40)))).toBe(true);
  });

  it("picks topics deterministically for a seed", () => {
    expect(pickWanderTopic("same")).toBe(pickWanderTopic("same"));
    expect(pickWanderTopic("a")).not.toBe(pickWanderTopic("b"));
  });

  it("frames the planner as a lab of distinct scientists", () => {
    const text = wanderPlannerInstructions().join("\n");
    expect(text).toMatch(/Principal investigator/i);
    expect(text).toMatch(/Methodologist/i);
    expect(text).toMatch(/Rival theorist/i);
    expect(text).toMatch(/Consensus editor/i);
    expect(text).toContain(WANDER_LAB_FILES.hypotheses);
    expect(text).toContain(WANDER_LAB_FILES.consensus);
    expect(text).toMatch(/never invent citations/i);
    expect(text).toMatch(/disagreement is the point/i);
    expect(text).toMatch(/≤ ~800 words/);
    expect(text).toMatch(/≤ ~600 words/);
    expect(text).toMatch(/≤ ~1000 words/);
    expect(text).toMatch(/short lab session/);
    expect(text).toMatch(/risks aborting the model call/);
  });

  it("resolves an 8-minute Wander session while leaving coding budgets alone", () => {
    expect(resolveExecutionSession("add a README")).toEqual(CODING_SESSION);
    expect(resolveExecutionSession(buildWanderObjective("sleep"))).toEqual(WANDER_SESSION);
    expect(WANDER_SESSION.claimLeaseMs).toBeGreaterThan(CODING_SESSION.claimLeaseMs);
    expect(WANDER_SESSION.claimLeaseMs).toBeLessThanOrEqual(10 * 60_000);
  });
});

