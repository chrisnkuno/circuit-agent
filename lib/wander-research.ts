import { createHash } from "node:crypto";
import { ExaSearchClient, type ExaSearchHit } from "../packages/agent-core/src/providers/exa";
import { isWanderObjective, WANDER_MARKER } from "../packages/agent-core/src/wander";

/** Hard budget: one Exa /search per Wander run, never a tool loop. */
export const WANDER_EXA_BUDGET = {
  searchesPerRun: 1,
  numResults: 5,
  type: "auto" as const,
  highlightMaxCharacters: 1_200,
  /** Full briefing stored on the run / seeded as wander/EVIDENCE.md. */
  maxBriefCharacters: 10_000,
  /**
   * Smaller slice injected into the planner prompt. The full dossier is still in EVIDENCE.md;
   * keeping the prompt lean is required so Convex→Cloudflare-relay→model finishes under ~90s.
   */
  maxPromptBriefCharacters: 4_500,
  /** Reuse a prior dossier for the same topic instead of paying again. */
  cacheTtlMs: 7 * 24 * 60 * 60_000,
};

export type WanderEvidenceSource = {
  title: string;
  url: string;
  publishedDate: string | null;
  author: string | null;
  highlights: string[];
};

export type WanderEvidenceDossier = {
  topic: string;
  query: string;
  fetchedAt: number;
  exaRequestId: string | null;
  sourceCount: number;
  /** Exact Exa calls made to produce this dossier (0 when served from cache). */
  exaCalls: number;
  sources: WanderEvidenceSource[];
  briefMarkdown: string;
};

const PUBLICATION_HINT = /\b(evidence|study|studies|rct|trial|hypothesis|meta-?analysis|genome|crispr|vaccine|neuro|climate|physics|biology|chemistry|medical|clinical|pubmed|doi)\b/i;

export function extractWanderTopic(objective: string): string | null {
  if (!isWanderObjective(objective)) return null;
  // Schedule markers have no concrete topic yet.
  if (/cadence=(daily|weekly)\s+topic=random/i.test(objective)) return null;
  const match = objective.match(/^\[Wander\]\s+Topic:\s*(.+?)\.\s+(?:Write wander\/|Scientific lab:)/i);
  if (match?.[1]?.trim()) return match[1].trim();
  return objective.replace(WANDER_MARKER, "").trim().slice(0, 160) || null;
}

export function wanderTopicHash(topic: string): string {
  return createHash("sha256").update(topic.trim().toLowerCase()).digest("hex").slice(0, 32);
}

/** One search query — never fan out into multiple Exa calls. */
export function buildWanderSearchQuery(topic: string): string {
  const clean = topic.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Wander topic is required for Exa search");
  return `${clean} — primary sources, reviews, and high-quality explainers`;
}

function canonicalizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    // Drop tracking noise that would defeat dedupe.
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_") || key === "ref" || key === "fbclid") parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url.trim();
  }
}

/** Collapse near-duplicate hits so five slots are five distinct sources. */
export function dedupeExaHits(hits: ExaSearchHit[]): ExaSearchHit[] {
  const seen = new Set<string>();
  const unique: ExaSearchHit[] = [];
  for (const hit of hits) {
    const key = canonicalizeUrl(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      ...hit,
      highlights: hit.highlights.slice(0, 3),
    });
  }
  return unique;
}

export function formatWanderEvidenceBrief(input: {
  topic: string;
  query: string;
  fetchedAt: number;
  exaRequestId: string | null;
  sources: WanderEvidenceSource[];
  fromCache: boolean;
}): string {
  const lines = [
    `# Literature briefing (Wander lab)`,
    ``,
    `Role: Literature scout — this file is the lab's only citable primary briefing.`,
    `Topic: ${input.topic}`,
    `Query: ${input.query}`,
    `Fetched: ${new Date(input.fetchedAt).toISOString()}${input.fromCache ? " (cache hit — no Exa call)" : ""}`,
    input.exaRequestId ? `Exa request: ${input.exaRequestId}` : `Exa request: n/a`,
    ``,
    `Budget: 1× Exa search, type=auto, ≤${WANDER_EXA_BUDGET.numResults} results, highlights only (no full text, no AI summaries, no deep search).`,
    ``,
    `Scientists downstream (PI, methodologist, rival, editor) may cite only these URLs. If a claim is not supported here, grade it speculative or omit it. Do not invent DOIs, quotes, or study results.`,
    ``,
  ];
  if (input.sources.length === 0) {
    lines.push(`_No sources returned. Proceed with explicit knowledge limits and no fabricated citations._`);
  }
  input.sources.forEach((source, index) => {
    lines.push(`## ${index + 1}. ${source.title}`);
    lines.push(`URL: ${source.url}`);
    if (source.publishedDate) lines.push(`Published: ${source.publishedDate}`);
    if (source.author) lines.push(`Author: ${source.author}`);
    if (source.highlights.length === 0) {
      lines.push(`_No highlights._`);
    } else {
      lines.push(`Highlights:`);
      for (const highlight of source.highlights) lines.push(`- ${highlight}`);
    }
    lines.push(``);
  });
  const brief = lines.join("\n").trim() + "\n";
  if (brief.length <= WANDER_EXA_BUDGET.maxBriefCharacters) return brief;
  return `${brief.slice(0, WANDER_EXA_BUDGET.maxBriefCharacters - 80)}\n\n_…truncated to stay inside the Wander evidence budget._\n`;
}

/**
 * Gather Wander evidence under a hard cost budget: at most one Exa search, cached by topic.
 * Callers must not invoke this more than once per run.
 */
export async function gatherWanderEvidence(options: {
  topic: string;
  client: ExaSearchClient;
  now?: number;
  /** Prior dossier for this topic hash, when still fresh. */
  cached?: { briefMarkdown: string; fetchedAt: number; sourceCount: number; query: string; exaRequestId: string | null } | null;
}): Promise<WanderEvidenceDossier> {
  const topic = options.topic.trim();
  if (!topic) throw new Error("Wander topic is required");
  const now = options.now ?? Date.now();
  const query = buildWanderSearchQuery(topic);

  if (options.cached && now - options.cached.fetchedAt < WANDER_EXA_BUDGET.cacheTtlMs) {
    return {
      topic,
      query: options.cached.query,
      fetchedAt: options.cached.fetchedAt,
      exaRequestId: options.cached.exaRequestId,
      sourceCount: options.cached.sourceCount,
      exaCalls: 0,
      sources: [],
      briefMarkdown: options.cached.briefMarkdown,
    };
  }

  const response = await options.client.search({
    query,
    numResults: WANDER_EXA_BUDGET.numResults,
    type: WANDER_EXA_BUDGET.type,
    highlightMaxCharacters: WANDER_EXA_BUDGET.highlightMaxCharacters,
    ...(PUBLICATION_HINT.test(topic) ? { category: "publication" as const } : {}),
  });

  const sources = dedupeExaHits(response.results).slice(0, WANDER_EXA_BUDGET.numResults).map((hit) => ({
    title: hit.title,
    url: hit.url,
    publishedDate: hit.publishedDate,
    author: hit.author,
    highlights: hit.highlights,
  }));

  const briefMarkdown = formatWanderEvidenceBrief({
    topic,
    query,
    fetchedAt: now,
    exaRequestId: response.requestId,
    sources,
    fromCache: false,
  });

  return {
    topic,
    query,
    fetchedAt: now,
    exaRequestId: response.requestId,
    sourceCount: sources.length,
    exaCalls: 1,
    sources,
    briefMarkdown,
  };
}

export function wanderRepositoryContext(briefMarkdown: string | null | undefined): string {
  if (!briefMarkdown?.trim()) {
    return [
      "No repository is connected yet.",
      "This is a Wander scientific lab. Exa literature was not available (missing EXA_API_KEY or prefetch failed).",
      "Proceed as careful scientists with prior knowledge only, keep most claims speculative, and never invent citations.",
    ].join(" ");
  }
  let brief = briefMarkdown.trim();
  if (brief.length > WANDER_EXA_BUDGET.maxPromptBriefCharacters) {
    brief = `${brief.slice(0, WANDER_EXA_BUDGET.maxPromptBriefCharacters - 80)}\n\n_…prompt truncated; full briefing is in wander/EVIDENCE.md._\n`;
  }
  return [
    "No repository is connected yet.",
    "This is a Wander scientific lab. The literature scout already ran once on the control plane (Exa highlights only; not searchable again from the sandbox).",
    "wander/EVIDENCE.md is seeded with the full briefing — prefer that file for citations. The excerpt below is only a prompt-sized digest.",
    "",
    brief,
  ].join("\n");
}
