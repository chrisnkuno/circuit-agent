/**
 * Scores live Exa retrieval evidence separately from Nova's prose quality.
 * Grounding, cross-domain novelty, and maintained defensive-tool fit prevent a persuasive but
 * shallow search summary from earning reliability points it did not substantiate.
 */
export type ExaReliabilityCase = {
  name: "breadth" | "freshness" | "alpha" | "defender";
  resultCount: number;
  targetResults: number;
  relevantResults: number;
  uniqueUrls: number;
  uniqueDomains: number;
  targetDomains: number;
  highlightedResults: number;
  elapsedMs: number;
  latencyTargetMs: number;
  datedResults?: number;
  freshResults?: number;
  findings?: number;
  groundedFindings?: number;
  triangulatedFindings?: number;
  toolCandidates?: number;
  qualifiedToolCandidates?: number;
  costDollars: number | null;
};

export type ExaReliabilityReport = {
  score: number;
  grade: "excellent" | "good" | "needs-work" | "unreliable";
  components: {
    coverage: number;
    relevance: number;
    sourceDiversity: number;
    extraction: number;
    freshness: number;
    speed: number;
    deduplication: number;
    grounding: number;
    novelty: number;
    defensiveUtility: number;
    costTransparency: number;
  };
  cases: number;
  passed: number;
  results: number;
  uniqueUrls: number;
  uniqueDomains: number;
  relevanceRate: number;
  duplicateRate: number;
  highlightCoverage: number;
  totalCostDollars: number | null;
  medianLatencyMs: number;
};

const ratio = (value: number): number => Math.max(0, Math.min(1, value));
const average = (values: number[]): number =>
  values.length
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
const oneDecimal = (value: number): number => Math.round(value * 10) / 10;
const percent = (value: number): number =>
  Math.round(ratio(value) * 1_000) / 10;

function median(values: number[]): number {
  const ordered = [...values].sort((left, right) => left - right);
  if (!ordered.length) return 0;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[middle]
    : Math.round((ordered[middle - 1] + ordered[middle]) / 2);
}

/**
 * Grades retrieval evidence, not prose. "Novelty" requires a finding to be grounded in at least
 * two independent domains; merely labelling something surprising earns nothing.
 */
export function scoreExaReliability(
  cases: readonly ExaReliabilityCase[],
): ExaReliabilityReport {
  if (!cases.length)
    throw new Error("At least one Exa reliability case is required");
  const results = cases.reduce((sum, item) => sum + item.resultCount, 0);
  const uniqueUrls = cases.reduce((sum, item) => sum + item.uniqueUrls, 0);
  const relevant = cases.reduce((sum, item) => sum + item.relevantResults, 0);
  const highlighted = cases.reduce(
    (sum, item) => sum + item.highlightedResults,
    0,
  );
  const freshnessCases = cases.filter(
    (item) => item.datedResults !== undefined,
  );
  const findingCases = cases.filter((item) => item.findings !== undefined);
  const coverageRate = average(
    cases.map((item) => ratio(item.resultCount / item.targetResults)),
  );
  const relevanceRate = results ? relevant / results : 0;
  const diversityRate = average(
    cases.map((item) => ratio(item.uniqueDomains / item.targetDomains)),
  );
  const extractionRate = results ? highlighted / results : 0;
  const freshnessRate = average(
    freshnessCases.map((item) =>
      item.datedResults ? (item.freshResults ?? 0) / item.datedResults : 0,
    ),
  );
  const speedRate = average(
    cases.map((item) =>
      item.elapsedMs > 0 ? ratio(item.latencyTargetMs / item.elapsedMs) : 0,
    ),
  );
  const deduplicationRate = results ? uniqueUrls / results : 0;
  const groundingRate = average(
    findingCases.map((item) =>
      item.findings ? (item.groundedFindings ?? 0) / item.findings : 0,
    ),
  );
  const noveltyRate = average(
    findingCases.map((item) =>
      item.findings ? (item.triangulatedFindings ?? 0) / item.findings : 0,
    ),
  );
  const toolCases = cases.filter((item) => item.toolCandidates !== undefined);
  const defensiveUtilityRate = average(
    toolCases.map((item) =>
      item.toolCandidates
        ? (item.qualifiedToolCandidates ?? 0) / item.toolCandidates
        : 0,
    ),
  );
  const costRate = average(
    cases.map((item) => Number(item.costDollars !== null)),
  );
  const components = {
    coverage: oneDecimal(coverageRate * 18),
    relevance: oneDecimal(relevanceRate * 19),
    sourceDiversity: oneDecimal(diversityRate * 9),
    extraction: oneDecimal(extractionRate * 10),
    freshness: oneDecimal(freshnessRate * 10),
    speed: oneDecimal(speedRate * 9),
    deduplication: oneDecimal(deduplicationRate * 5),
    grounding: oneDecimal(groundingRate * 5),
    novelty: oneDecimal(noveltyRate * 5),
    defensiveUtility: oneDecimal(defensiveUtilityRate * 5),
    costTransparency: oneDecimal(costRate * 5),
  };
  let score = Math.round(
    Object.values(components).reduce((sum, value) => sum + value, 0),
  );
  if (cases.some((item) => item.resultCount === 0)) score = Math.min(score, 49);
  if (relevanceRate < 0.5) score = Math.min(score, 59);
  const grade =
    score >= 90
      ? "excellent"
      : score >= 75
        ? "good"
        : score >= 60
          ? "needs-work"
          : "unreliable";
  const costs = cases.map((item) => item.costDollars);
  return {
    score,
    grade,
    components,
    cases: cases.length,
    passed: cases.filter(
      (item) =>
        item.resultCount > 0 && item.relevantResults / item.resultCount >= 0.5,
    ).length,
    results,
    uniqueUrls,
    uniqueDomains:
      new Set(cases.map((item) => `${item.name}:${item.uniqueDomains}`))
        .size === 0
        ? 0
        : cases.reduce((sum, item) => sum + item.uniqueDomains, 0),
    relevanceRate: percent(relevanceRate),
    duplicateRate: percent(results ? 1 - uniqueUrls / results : 1),
    highlightCoverage: percent(extractionRate),
    totalCostDollars: costs.every((cost) => cost !== null)
      ? costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
      : null,
    medianLatencyMs: median(cases.map((item) => item.elapsedMs)),
  };
}
