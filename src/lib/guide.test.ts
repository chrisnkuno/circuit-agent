import { describe, expect, it } from "vitest";
import { GUIDE, findGuideTopic, keysFor, searchGuide } from "./guide";
import { SHORTCUTS } from "./shortcuts";

/**
 * Documentation rots silently, which is the only reason it is worth testing at all. The CLI's guide
 * is held to the same rule: a feature that ships without a line in the guide fails the suite, and
 * that mechanism — not good intentions — is what keeps the two in step.
 */

describe("the guide", () => {
  it("documents every shortcut the window offers", () => {
    // The direction that catches new features: add a chord, forget the guide, fail here.
    const documented = new Set(GUIDE.flatMap((topic) => topic.shortcuts ?? []));
    for (const binding of SHORTCUTS) expect(documented).toContain(binding.action);
  });

  it("claims no shortcut that does not exist", () => {
    // And the direction that catches removals, so the guide cannot promise a key that is gone.
    const real = new Set(SHORTCUTS.map((binding) => binding.action));
    for (const topic of GUIDE) {
      for (const action of topic.shortcuts ?? []) expect(real).toContain(action);
    }
  });

  it("can print the keys for every shortcut it names", () => {
    for (const topic of GUIDE) {
      for (const action of topic.shortcuts ?? []) expect(keysFor(action)).toBeTruthy();
    }
  });

  it("gives every topic a unique id, a title, a summary and a body", () => {
    const ids = GUIDE.map((topic) => topic.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const topic of GUIDE) {
      expect(topic.title.trim()).not.toBe("");
      expect(topic.summary.trim()).not.toBe("");
      expect(topic.body.length).toBeGreaterThan(0);
      for (const paragraph of topic.body) expect(paragraph.trim()).not.toBe("");
    }
  });

  it("covers the things people are otherwise surprised by", () => {
    // Named explicitly rather than counted: these are the four facts that cost a support
    // conversation each when nobody writes them down.
    const prose = GUIDE.flatMap((topic) => [topic.title, topic.summary, ...topic.body]).join(" ").toLowerCase();
    expect(prose).toContain("escape denies");
    expect(prose).toContain("plan cannot write");
    expect(prose).toContain("at once");
    expect(prose).toContain("sandbox");
  });

  it("finds a topic by id, and nothing for one that does not exist", () => {
    expect(findGuideTopic("modes")?.title).toContain("Modes");
    expect(findGuideTopic("no-such-topic")).toBeUndefined();
  });

  it("searches titles and bodies, and returns everything for an empty query", () => {
    expect(searchGuide("")).toHaveLength(GUIDE.length);
    expect(searchGuide("   ")).toHaveLength(GUIDE.length);
    const approvals = searchGuide("approval");
    expect(approvals.length).toBeGreaterThan(0);
    expect(searchGuide("quantum tunnelling")).toHaveLength(0);
  });

  it("is case-insensitive, because nobody types a search the way it was written", () => {
    expect(searchGuide("SANDBOX").length).toBe(searchGuide("sandbox").length);
  });
});
