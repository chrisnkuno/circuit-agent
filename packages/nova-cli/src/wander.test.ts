import { describe, expect, it } from "vitest";
import { parseWanderResults, wanderGradeCounts, WANDER_MARKER, WANDER_TOPIC_CATALOG } from "@circuit-nova/nova-core/wander";
import { UNICODE_GLYPHS } from "./glyphs";
import type { ExaSearchClient, ExaSearchHit } from "@circuit-nova/nova-core/providers/exa";
import { buildWanderPrompt, gatherWanderEvidence, parseWanderCommand, renderWanderResults, resolveWanderJobTopic, wanderArtifacts, wanderJobObjective } from "./wander";

const hit = (overrides: Partial<ExaSearchHit> = {}): ExaSearchHit => ({
  title: "Coral bleaching thresholds",
  url: "https://example.org/coral",
  publishedDate: "2026-02-01",
  author: "Reef Lab",
  highlights: ["Bleaching begins at   1 degree above\nthe summer maximum."],
  ...overrides,
});

const stubSearch = (results: ExaSearchHit[] | Error): ExaSearchClient => ({
  search: async () => {
    if (results instanceof Error) throw results;
    return { requestId: "req", results };
  },
}) as unknown as ExaSearchClient;

describe("parsing the command", () => {
  it("takes a topic verbatim", () => {
    expect(parseWanderCommand("/wander  how   bird navigation works ")).toEqual({ kind: "once", topic: "how bird navigation works", random: false });
  });

  it("picks a curated topic when asked for nothing in particular", () => {
    // A bare /wander is the main way this gets used; demanding a topic first defeats the point.
    for (const input of ["/wander", "/wander random", "/wander RANDOM"]) {
      const parsed = parseWanderCommand(input, "seed-1");
      expect(parsed).toMatchObject({ kind: "once", random: true });
      expect(WANDER_TOPIC_CATALOG).toContain((parsed as { topic: string }).topic);
    }
  });

  it("picks the same topic for the same seed", () => {
    expect(parseWanderCommand("/wander", "seed-7")).toEqual(parseWanderCommand("/wander", "seed-7"));
  });

  it("reads a cadence, with or without a topic", () => {
    expect(parseWanderCommand("/wander daily")).toEqual({ kind: "schedule", cadence: "daily" });
    expect(parseWanderCommand("/wander weekly coral reefs")).toEqual({ kind: "schedule", cadence: "weekly", topic: "coral reefs" });
    expect(parseWanderCommand("/wander daily random")).toEqual({ kind: "schedule", cadence: "daily" });
  });

  it("names the problem itself rather than failing deeper down", () => {
    expect(parseWanderCommand(`/wander ${"x".repeat(200)}`)).toEqual({ kind: "invalid", reason: expect.stringContaining("too long") });
  });

  it("is not a wander command at all", () => {
    expect(parseWanderCommand("/wanderlust")).toBeNull();
    expect(parseWanderCommand("/diff")).toBeNull();
  });
});

describe("the evidence dossier", () => {
  it("records the sources the lab is allowed to cite", async () => {
    const evidence = await gatherWanderEvidence("coral bleaching", stubSearch([hit()]));
    expect(evidence.markdown).toContain("https://example.org/coral");
    expect(evidence.markdown).toContain("Only the URLs in this file may be cited");
    // Highlights are collapsed to one line so the quote survives markdown blockquoting.
    expect(evidence.markdown).toContain("> Bleaching begins at 1 degree above the summer maximum.");
    expect(evidence.hits).toHaveLength(1);
  });

  it("bills both meters of the search it ran", async () => {
    const evidence = await gatherWanderEvidence("coral bleaching", stubSearch([hit(), hit(), hit()]));
    expect(evidence.expense).toEqual({
      provider: "exa",
      meter: "search",
      quantities: { request: 1, contents: 3 },
      label: "wander evidence: coral bleaching",
    });
  });

  it("still produces a dossier with no search provider, and says why it is empty", async () => {
    // A thin dossier is a real outcome the protocol handles by grading claims speculative.
    // Refusing to start would hide that rather than prevent it.
    const evidence = await gatherWanderEvidence("coral bleaching", undefined);
    expect(evidence.markdown).toContain("No search provider is configured");
    expect(evidence.markdown).toContain("grade essentially every claim as speculative".replace(/^./, (first) => first.toUpperCase()));
    expect(evidence.expense).toBeUndefined();
  });

  it("does not bill for a search that failed", async () => {
    const evidence = await gatherWanderEvidence("coral bleaching", stubSearch(new Error("429 rate limited")));
    expect(evidence.markdown).toContain("Literature search failed (429 rate limited)");
    expect(evidence.expense).toBeUndefined();
  });
});

describe("the turn prompt", () => {
  it("carries the marker, the topic and the lab protocol", () => {
    const prompt = buildWanderPrompt("how coral reefs bleach");
    expect(prompt).toContain(WANDER_MARKER);
    expect(prompt).toContain("how coral reefs bleach");
    expect(prompt).toContain("wander/EVIDENCE.md");
    expect(prompt).toContain("Consensus editor");
    expect(prompt).toContain("verified");
  });

  it("tells the lab the dossier is already written", () => {
    // The scout step ran out here; without this the agent burns a turn trying to search.
    expect(buildWanderPrompt("x")).toContain("already been written to wander/EVIDENCE.md");
  });

  it("names every artifact the lab should leave behind", () => {
    expect(wanderArtifacts()).toContain("wander/CONSENSUS.md");
    // The five notebook files, plus the same consensus table as data for anything that charts it.
    expect(wanderArtifacts()).toContain("wander/RESULTS.json");
    expect(wanderArtifacts()).toHaveLength(6);
  });
});

describe("what a durable schedule stores and resolves", () => {
  it("writes a named topic down literally, so every occurrence explores the same thing", () => {
    const objective = wanderJobObjective({ cadence: "daily", topic: "coral reefs" });
    expect(resolveWanderJobTopic(objective, "any-seed")).toBe("coral reefs");
    expect(resolveWanderJobTopic(objective, "a-different-seed")).toBe("coral reefs");
  });

  it("stores the schedule marker for a topic-less schedule, not a topic picked once", () => {
    const objective = wanderJobObjective({ cadence: "daily" });
    expect(objective).not.toContain("Topic:");
    expect(WANDER_TOPIC_CATALOG).toContain(resolveWanderJobTopic(objective, "seed-a"));
  });

  it("picks a fresh topic per occurrence when the seed changes, not the same one forever", () => {
    // The whole point of choosing "random" over naming a topic is a new curiosity each time —
    // a seed fixed at the job's own id (constant across every firing) would defeat that.
    const objective = wanderJobObjective({ cadence: "daily" });
    const seeds = Array.from({ length: 20 }, (_unused, index) => `job-1:${index}`);
    const topics = new Set(seeds.map((seed) => resolveWanderJobTopic(objective, seed)));
    expect(topics.size).toBeGreaterThan(1);
  });
});

describe("wander results", () => {
  const style = { depth: "none" as const, glyphs: UNICODE_GLYPHS, width: 80 };
  const results = {
    topic: "why coral bleaches",
    claims: [
      { claim: "Bleaching follows sustained thermal stress", grade: "verified" },
      { claim: "Symbiont shuffling buys a season, not a decade", grade: "strong_plausible" },
      { claim: "Nearshore turbidity shades reefs enough to matter", grade: "speculative" },
      { claim: "Recovery tracks larval supply from upstream reefs", grade: "strong_plausible" },
    ],
    unknowns: ["how long shuffled symbionts persist"],
  };

  it("reads the graded claims out of the file the lab writes", () => {
    const parsed = parseWanderResults(JSON.stringify(results));
    expect(parsed?.topic).toBe("why coral bleaches");
    expect(parsed?.claims).toHaveLength(4);
    expect(wanderGradeCounts(parsed!)).toEqual([
      { grade: "verified", count: 1 },
      { grade: "strong_plausible", count: 2 },
      { grade: "speculative", count: 1 },
    ]);
  });

  it("drops a claim whose grade the lab invented rather than coercing it onto the chart", () => {
    const parsed = parseWanderResults(JSON.stringify({
      claims: [
        { claim: "kept", grade: "verified" },
        { claim: "invented grade", grade: "probably_true" },
        { claim: "", grade: "verified" },
        { grade: "verified" },
        "not an object",
      ],
    }));
    expect(parsed?.claims).toEqual([{ claim: "kept", grade: "verified" }]);
  });

  it("says nothing rather than something wrong when the file is missing, empty or malformed", () => {
    for (const source of ["", "not json", "[]", "null", "{}", '{"claims":[]}', '{"claims":"lots"}']) {
      expect(parseWanderResults(source)).toBeNull();
    }
  });

  it("survives a lab that omitted the optional parts", () => {
    const parsed = parseWanderResults('{"claims":[{"claim":"one","grade":"speculative"}]}');
    expect(parsed).toEqual({ topic: "", claims: [{ claim: "one", grade: "speculative" }], unknowns: [] });
  });

  it("charts the grades against the whole lab, not against the winning bar", () => {
    const rendered = renderWanderResults(JSON.stringify(results), style, 72)!;
    expect(rendered).toContain("why coral bleaches");
    expect(rendered).toContain("verified");
    expect(rendered).toContain("strong plausible");
    expect(rendered).toContain("4 claims");
    // Two of four is half the bar's length, because the ceiling is the claim count.
    const strongRow = rendered.split("\n").find((line) => line.includes("strong plausible"))!;
    const speculativeRow = rendered.split("\n").find((line) => line.includes("speculative"))!;
    const filled = (row: string) => [...row].filter((cell) => cell === "█").length;
    expect(filled(strongRow)).toBe(filled(speculativeRow) * 2);
  });

  it("lists what was graded and what is still unknown", () => {
    const rendered = renderWanderResults(JSON.stringify(results), style, 72)!;
    expect(rendered).toContain("Bleaching follows sustained thermal stress");
    expect(rendered).toContain("still unknown: how long shuffled symbionts persist");
    // Strongest grade first, so the finding leads rather than the speculation.
    expect(rendered.indexOf("Bleaching follows")).toBeLessThan(rendered.indexOf("Nearshore turbidity"));
  });

  it("renders nothing at all for a run that graded nothing", () => {
    expect(renderWanderResults("{}", style, 72)).toBeNull();
  });
});
