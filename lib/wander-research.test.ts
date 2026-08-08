import { describe, expect, it, vi } from "vitest";
import type { ExaSearchClient } from "../packages/agent-core/src/providers/exa";
import {
  buildWanderSearchQuery,
  dedupeExaHits,
  extractWanderTopic,
  formatWanderEvidenceBrief,
  gatherWanderEvidence,
  wanderRepositoryContext,
  wanderTopicHash,
} from "./wander-research";
import { buildWanderObjective } from "../packages/agent-core/src/wander";

describe("Wander Exa research budget", () => {
  it("extracts topics from scientific-lab objectives", () => {
    expect(extractWanderTopic(buildWanderObjective("coral bleaching interventions"))).toBe("coral bleaching interventions");
    expect(extractWanderTopic("[Wander] cadence=daily topic=random")).toBeNull();
  });

  it("hashes topics case-insensitively for cache keys", () => {
    expect(wanderTopicHash("Sleep")).toBe(wanderTopicHash("sleep"));
  });

  it("builds one thrifty search query per topic", () => {
    expect(buildWanderSearchQuery("mRNA vaccines")).toMatch(/mRNA vaccines/);
    expect(buildWanderSearchQuery("mRNA vaccines")).toMatch(/primary sources/);
  });

  it("dedupes Exa hits by canonical URL", () => {
    const unique = dedupeExaHits([
      { title: "A", url: "https://ex.com/a?utm_source=x", publishedDate: null, author: null, highlights: ["one", "two", "three", "four"] },
      { title: "A2", url: "https://ex.com/a", publishedDate: null, author: null, highlights: ["dup"] },
      { title: "B", url: "https://ex.com/b", publishedDate: null, author: null, highlights: ["b"] },
    ]);
    expect(unique).toHaveLength(2);
    expect(unique[0].highlights).toHaveLength(3);
  });

  it("serves a fresh topic cache without calling Exa", async () => {
    const search = vi.fn();
    const client = { search } as unknown as ExaSearchClient;
    const dossier = await gatherWanderEvidence({
      topic: "hygiene hypothesis",
      client,
      now: 1_000_000,
      cached: {
        briefMarkdown: "# cached\n",
        fetchedAt: 1_000_000 - 60_000,
        sourceCount: 3,
        query: "old query",
        exaRequestId: "req_1",
      },
    });
    expect(dossier.exaCalls).toBe(0);
    expect(dossier.briefMarkdown).toBe("# cached\n");
    expect(search).not.toHaveBeenCalled();
  });

  it("performs exactly one Exa search when the cache misses", async () => {
    const search = vi.fn(async () => ({
      requestId: "req_new",
      results: [
        { title: "Paper", url: "https://journals.example/p1", publishedDate: "2024-01-01", author: "Ada", highlights: ["effect size"] },
      ],
    }));
    const client = { search } as unknown as ExaSearchClient;
    const dossier = await gatherWanderEvidence({ topic: "CRISPR off-target effects", client, now: Date.now() });
    expect(search).toHaveBeenCalledTimes(1);
    expect(dossier.exaCalls).toBe(1);
    expect(dossier.sourceCount).toBe(1);
    expect(dossier.briefMarkdown).toMatch(/Literature briefing/);
    expect(dossier.briefMarkdown).toMatch(/https:\/\/journals\.example\/p1/);
  });

  it("formats a scientist-facing brief and repository context", () => {
    const brief = formatWanderEvidenceBrief({
      topic: "sleep",
      query: "sleep — primary sources",
      fetchedAt: 0,
      exaRequestId: null,
      fromCache: false,
      sources: [],
    });
    expect(brief).toMatch(/Literature scout/i);
    expect(wanderRepositoryContext(brief)).toMatch(/scientific lab/i);
    expect(wanderRepositoryContext(null)).toMatch(/not available/i);
  });
});
