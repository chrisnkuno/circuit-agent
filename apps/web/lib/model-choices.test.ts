import { describe, expect, it } from "vitest";
import { modelChoicesFor } from "./model-choices";

describe("model choices", () => {
  it("offers CircuitNotion's priced models, without meters", () => {
    const choices = modelChoicesFor("circuitnotion");
    const ids = choices.map((choice) => choice.id);
    expect(ids).toContain("circuit-1");
    expect(ids).not.toContain("sandbox");
    expect(ids).not.toContain("search");
  });

  it("returns each model once, sorted, with its input rate and currency", () => {
    const choices = modelChoicesFor("circuitnotion");
    expect(new Set(choices.map((choice) => choice.id)).size).toBe(choices.length);
    expect([...choices].sort((a, b) => a.id.localeCompare(b.id))).toEqual(choices);
    const priced = choices.find((choice) => choice.id === "circuit-1");
    expect(priced?.inputRate).toBeGreaterThan(0);
    expect(priced?.currency).toBeTruthy();
  });

  it("offers nothing for a provider the build ships no rates for", () => {
    expect(modelChoicesFor("openai")).toEqual([]);
  });
});
