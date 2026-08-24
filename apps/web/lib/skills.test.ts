import { describe, expect, it } from "vitest";
import {
  composeSystemPromptWithSkills,
  distillSkillFromRun,
  nextSkillVersion,
  renderSkillGuidance,
  selectRelevantSkills,
  slugify,
  validateSkillDraft,
  type Skill,
} from "./skills";

describe("slugify", () => {
  it("lowercases, hyphenates, and bounds the result", () => {
    expect(slugify("Fix the Flaky Retry Test!!")).toBe("fix-the-flaky-retry-test");
  });

  it("rejects text with no derivable slug", () => {
    expect(() => slugify("!!!")).toThrow("Could not derive a slug");
  });
});

describe("validateSkillDraft", () => {
  const base = { slug: "fix-flaky-retry-test", title: "Fix a flaky retry test", taskKind: "coding" as const, proceduralSummary: "Reproduce with a fixed seed, then stabilize the timing assumption.", sourceRunId: "run_1", sourceObjective: "Stabilize the retry test" };

  it("accepts a well-formed draft", () => {
    expect(() => validateSkillDraft(base)).not.toThrow();
  });

  it("rejects an invalid slug", () => {
    expect(() => validateSkillDraft({ ...base, slug: "Not Valid" })).toThrow("slug");
  });

  it("rejects a too-short procedural summary", () => {
    expect(() => validateSkillDraft({ ...base, proceduralSummary: "short" })).toThrow("procedural summary");
  });

  it("requires source provenance", () => {
    expect(() => validateSkillDraft({ ...base, sourceRunId: "" })).toThrow("run it was distilled from");
    expect(() => validateSkillDraft({ ...base, sourceObjective: "" })).toThrow("objective it was distilled from");
  });
});

describe("distillSkillFromRun", () => {
  const evidence = { runId: "run_42", taskKind: "coding" as const, objective: "Fix the flaky retry test in the payment worker", summary: "Reproduced with a fixed random seed, found the timing assumption, replaced it with a fake clock, verified with two passing test runs.", verified: true };

  it("distills a verified run into a proposed-ready draft", () => {
    const draft = distillSkillFromRun(evidence);
    expect(draft.slug).toBe("fix-the-flaky-retry-test-in-the-payment-worker");
    expect(draft.sourceRunId).toBe("run_42");
    expect(draft.proceduralSummary).toContain("fake clock");
  });

  it("accepts an explicit title distinct from the objective", () => {
    const draft = distillSkillFromRun(evidence, "Stabilize flaky timing tests");
    expect(draft.slug).toBe("stabilize-flaky-timing-tests");
    expect(draft.title).toBe("Stabilize flaky timing tests");
  });

  it("refuses to distill an unverified run", () => {
    expect(() => distillSkillFromRun({ ...evidence, verified: false })).toThrow("verified");
  });
});

describe("nextSkillVersion", () => {
  it("starts at 1 for a new slug and increments from the highest existing version", () => {
    expect(nextSkillVersion([])).toBe(1);
    expect(nextSkillVersion([1, 2, 4])).toBe(5);
  });
});

function skill(overrides: Partial<Skill>): Skill {
  return {
    slug: "example-skill", title: "Example skill", taskKind: "coding", proceduralSummary: "Do the example thing carefully and verify it.",
    sourceRunId: "run_1", sourceObjective: "example objective", version: 1, status: "approved",
    ...overrides,
  };
}

describe("selectRelevantSkills", () => {
  const skills: Skill[] = [
    skill({ slug: "retry-flaky-tests", title: "Stabilize flaky retry tests", proceduralSummary: "Fix flaky retry tests by replacing real timers with a fake clock and a fixed seed.", version: 1 }),
    skill({ slug: "add-database-index", title: "Add a missing database index", proceduralSummary: "Profile slow queries and add a covering index for the hot path.", version: 1 }),
    skill({ slug: "unrelated-proposed", title: "Unrelated proposed skill", proceduralSummary: "Retry flaky tests using fake clocks and fixed seeds.", status: "proposed", version: 1 }),
  ];

  it("ranks the skill whose content overlaps the new objective highest", () => {
    const selected = selectRelevantSkills("The retry test for payments is flaky, fix the flaky timing", skills, { maxSkills: 5, maxTotalChars: 10_000 });
    expect(selected[0]?.slug).toBe("retry-flaky-tests");
  });

  it("excludes skills that are not approved even if textually relevant", () => {
    const selected = selectRelevantSkills("retry flaky tests fake clock fixed seed", skills, { maxSkills: 5, maxTotalChars: 10_000 });
    expect(selected.some((item) => item.slug === "unrelated-proposed")).toBe(false);
  });

  it("excludes skills below the relevance floor", () => {
    const selected = selectRelevantSkills("completely unrelated objective about shipping logistics", skills, { maxSkills: 5, maxTotalChars: 10_000 });
    expect(selected).toEqual([]);
  });

  it("respects the character budget over the count limit", () => {
    const long = skill({ slug: "retry-flaky-tests", title: "Stabilize flaky retry tests", proceduralSummary: "x".repeat(200), version: 1 });
    const selected = selectRelevantSkills("retry flaky tests", [long], { maxSkills: 5, maxTotalChars: 50 });
    expect(selected).toEqual([]);
  });
});

describe("renderSkillGuidance", () => {
  it("returns an empty string when no skills are selected", () => {
    expect(renderSkillGuidance([])).toBe("");
  });

  it("frames recalled skills as advisory and non-authority-granting", () => {
    const text = renderSkillGuidance([skill({})]);
    expect(text).toContain("cannot grant a tool, permission, budget, or approval");
    expect(text).toContain("Example skill");
  });
});

describe("composeSystemPromptWithSkills", () => {
  it("leaves the base prompt unchanged when no skill qualifies", () => {
    expect(composeSystemPromptWithSkills("You are a bounded coding agent.", [])).toBe("You are a bounded coding agent.");
  });

  it("appends recalled skill guidance after the base prompt", () => {
    const composed = composeSystemPromptWithSkills("You are a bounded coding agent.", [skill({})]);
    expect(composed.startsWith("You are a bounded coding agent.\n\n")).toBe(true);
    expect(composed).toContain("Example skill");
  });
});
