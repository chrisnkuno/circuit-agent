import { describe, expect, it } from "vitest";
import { buildDynamicPresetsPrompt, DynamicPresetsSchema, presetContextKey } from "./dynamic-presets";

describe("presetContextKey", () => {
  it("differs when repository connection state differs", () => {
    const withRepo = presetContextKey({ hasConnectedRepository: true, recentObjectives: [] });
    const withoutRepo = presetContextKey({ hasConnectedRepository: false, recentObjectives: [] });
    expect(withRepo).not.toBe(withoutRepo);
  });

  it("differs when recent objectives differ, and is stable for the same context", () => {
    const a = presetContextKey({ hasConnectedRepository: false, recentObjectives: ["add a README"] });
    const b = presetContextKey({ hasConnectedRepository: false, recentObjectives: ["add a README", "write a script"] });
    const aAgain = presetContextKey({ hasConnectedRepository: false, recentObjectives: ["add a README"] });
    expect(a).not.toBe(b);
    expect(a).toBe(aAgain);
  });

  it("only considers the five most recent objectives", () => {
    const many = presetContextKey({ hasConnectedRepository: false, recentObjectives: ["1", "2", "3", "4", "5", "6", "7"] });
    const capped = presetContextKey({ hasConnectedRepository: false, recentObjectives: ["1", "2", "3", "4", "5"] });
    expect(many).toBe(capped);
  });
});

describe("buildDynamicPresetsPrompt", () => {
  it("tells the model the workspace is empty and self-contained when no repository is connected", () => {
    const prompt = buildDynamicPresetsPrompt({ hasConnectedRepository: false, recentObjectives: [] });
    expect(prompt.instructions).toContain("No repository is connected");
    expect(prompt.instructions).toContain("must NOT assume any pre-existing code");
    expect(prompt.input).toContain("no task history");
  });

  it("tells the model a repository is connected and lists recent objectives to avoid duplicates", () => {
    const prompt = buildDynamicPresetsPrompt({ hasConnectedRepository: true, recentObjectives: ["fix the flaky retry test"] });
    expect(prompt.instructions).toContain("A real repository IS connected");
    expect(prompt.input).toContain("fix the flaky retry test");
    expect(prompt.input).toContain("not near-duplicates");
  });
});

describe("DynamicPresetsSchema", () => {
  it("accepts one to three well-formed presets", () => {
    const parsed = DynamicPresetsSchema.parse({ presets: [{ label: "Add tests", objective: "write a unit test for the parser" }] });
    expect(parsed.presets).toHaveLength(1);
  });

  it("rejects an empty preset list and rejects more than three", () => {
    expect(() => DynamicPresetsSchema.parse({ presets: [] })).toThrow();
    const four = Array.from({ length: 4 }, (_, i) => ({ label: `Preset ${i}`, objective: `objective ${i}` }));
    expect(() => DynamicPresetsSchema.parse({ presets: four })).toThrow();
  });
});
