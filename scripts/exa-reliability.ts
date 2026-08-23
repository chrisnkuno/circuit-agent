import { promises as fs } from "node:fs";
import path from "node:path";
import {
  scoreExaReliability,
  type ExaReliabilityCase,
} from "../packages/agent-core/src/nova-cli/exa-reliability";
import {
  ExaSearchClient,
  type ExaSearchHit,
  type ExaSearchResponse,
} from "../packages/agent-core/src/providers/exa";

const apiKey = process.env.EXA_API_KEY?.trim();
if (!apiKey)
  throw new Error(
    "EXA_API_KEY is required for the live Exa reliability benchmark",
  );
const client = new ExaSearchClient({
  apiKey,
  baseUrl: process.env.EXA_BASE_URL?.trim() || undefined,
});
const repo = path.resolve(import.meta.dirname, "..");

function domain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function relevant(hit: ExaSearchHit, pattern: RegExp): boolean {
  return pattern.test(`${hit.title}\n${hit.highlights.join("\n")}`);
}

function baseObservation(input: {
  name: ExaReliabilityCase["name"];
  response: ExaSearchResponse;
  targetResults: number;
  targetDomains: number;
  relevance: RegExp;
  elapsedMs: number;
  latencyTargetMs: number;
}): ExaReliabilityCase {
  const urls = input.response.results.map((hit) => hit.url);
  return {
    name: input.name,
    resultCount: input.response.results.length,
    targetResults: input.targetResults,
    relevantResults: input.response.results.filter((hit) =>
      relevant(hit, input.relevance),
    ).length,
    uniqueUrls: new Set(urls).size,
    uniqueDomains: new Set(urls.map(domain).filter(Boolean)).size,
    targetDomains: input.targetDomains,
    highlightedResults: input.response.results.filter((hit) =>
      hit.highlights.some((highlight) => highlight.trim().length >= 40),
    ).length,
    elapsedMs: input.elapsedMs,
    latencyTargetMs: input.latencyTargetMs,
    costDollars: input.response.costDollars,
  };
}

async function measured(
  request: Parameters<ExaSearchClient["search"]>[0],
): Promise<{ response: ExaSearchResponse; elapsedMs: number }> {
  const started = performance.now();
  const response = await client.search(request);
  return { response, elapsedMs: Math.round(performance.now() - started) };
}

const recentBoundary = new Date(Date.now() - 180 * 24 * 60 * 60 * 1_000);
const breadth = await measured({
  query:
    "primary sources on software supply-chain security SLSA Sigstore SBOM build provenance and reproducible builds",
  type: "fast",
  numResults: 30,
  systemPrompt:
    "Prefer standards, official documentation, research papers, and engineering incident reports. Avoid SEO summaries and duplicate domains.",
  contents: { highlights: true },
});
const freshness = await measured({
  query:
    "recent security advisories and release notes for Node.js Bun Deno and JavaScript runtimes",
  type: "auto",
  numResults: 20,
  category: "news",
  startPublishedDate: recentBoundary.toISOString(),
  systemPrompt:
    "Prefer first-party release notes, project advisories, CVE records, and maintainer posts.",
  contents: { highlights: true, maxAgeHours: 0 },
});
const alpha = await measured({
  query:
    "non-obvious primary-source signals that AI coding agents are moving from autocomplete to autonomous software maintenance",
  type: "deep-lite",
  numResults: 15,
  additionalQueries: [
    "coding agent autonomous maintenance benchmarks issue resolution",
    "engineering teams coding agents CI bug fixing production evidence",
    "software agent evaluation long horizon repositories",
  ],
  systemPrompt:
    "Find surprising but defensible cross-source signals. Prefer benchmarks, issue trackers, research, release notes, and engineering posts. Reject listicles and unsupported predictions.",
  outputSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            signal: { type: "string" },
            whyNonObvious: { type: "string" },
          },
          required: ["signal", "whyNonObvious"],
        },
      },
    },
    required: ["findings"],
  },
  contents: { highlights: true },
});
const defender = await measured({
  query:
    "latest actively exploited vulnerabilities, common exploit chains, and defensive tools relevant to Node.js TypeScript web applications and CI/CD supply chains",
  type: "deep-lite",
  numResults: 20,
  additionalQueries: [
    "CISA KEV Node.js JavaScript npm supply chain recent",
    "defensive OSINT tools verify exploit activity software dependencies",
    "OPSEC guidance for incident response evidence collection exposed secrets",
    "site:github.com cybersecurity defensive tools Node.js CI/CD recently maintained stars releases",
  ],
  startPublishedDate: recentBoundary.toISOString(),
  systemPrompt:
    "Defensive research only. Prefer CISA KEV, NVD, CVE records, GitHub advisories, vendor bulletins, incident reports, and official repositories. Find GitHub tools for the specific defensive need and rank maintenance, releases, issue responsiveness, security policy, documentation, license, archive status, and platform fit; treat stars and trending activity only as adoption signals. Never install or execute a tool. Separate proof-of-concept availability from confirmed exploitation. Do not provide intrusion steps, credentials, personal targeting, or operational exploitation guidance.",
  outputSchema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            advisory: { type: "string" },
            affectedSurface: { type: "string" },
            exploitStatus: { type: "string" },
            defensiveAction: { type: "string" },
          },
          required: [
            "advisory",
            "affectedSurface",
            "exploitStatus",
            "defensiveAction",
          ],
        },
      },
      tools: {
        type: "array",
        items: {
          type: "object",
          properties: {
            repository: { type: "string" },
            capability: { type: "string" },
            maintenanceEvidence: { type: "string" },
            adoptionSignal: { type: "string" },
            platformFit: { type: "string" },
            tradeoff: { type: "string" },
          },
          required: [
            "repository",
            "capability",
            "maintenanceEvidence",
            "adoptionSignal",
            "platformFit",
            "tradeoff",
          ],
        },
      },
    },
    required: ["findings", "tools"],
  },
  contents: { highlights: true, maxAgeHours: 0 },
});

const cases: ExaReliabilityCase[] = [
  baseObservation({
    name: "breadth",
    response: breadth.response,
    targetResults: 25,
    targetDomains: 12,
    relevance: /SLSA|Sigstore|SBOM|provenance|reproducible|supply.?chain/i,
    elapsedMs: breadth.elapsedMs,
    latencyTargetMs: 10_000,
  }),
  {
    ...baseObservation({
      name: "freshness",
      response: freshness.response,
      targetResults: 15,
      targetDomains: 8,
      relevance: /Node\.js|Bun|Deno|JavaScript|security|advisory|release|CVE/i,
      elapsedMs: freshness.elapsedMs,
      latencyTargetMs: 35_000,
    }),
    datedResults: freshness.response.results.filter((hit) => hit.publishedDate)
      .length,
    freshResults: freshness.response.results.filter((hit) => {
      const published = hit.publishedDate
        ? Date.parse(hit.publishedDate)
        : Number.NaN;
      return (
        Number.isFinite(published) && published >= recentBoundary.getTime()
      );
    }).length,
  },
];

let content: Record<string, unknown> = {};
if (typeof alpha.response.output?.content === "string") {
  try {
    content = JSON.parse(alpha.response.output.content) as Record<
      string,
      unknown
    >;
  } catch {
    content = {};
  }
} else if (
  alpha.response.output?.content &&
  typeof alpha.response.output.content === "object"
) {
  content = alpha.response.output.content;
}
const findings = Array.isArray(content.findings) ? content.findings : [];
const grounding = alpha.response.output?.grounding ?? [];
const grounded = grounding.filter((item) => item.citations.length > 0);
const triangulated = grounding.filter(
  (item) =>
    new Set(
      item.citations.map((citation) => domain(citation.url)).filter(Boolean),
    ).size >= 2,
);
cases.push({
  ...baseObservation({
    name: "alpha",
    response: alpha.response,
    targetResults: 10,
    targetDomains: 7,
    relevance: /agent|coding|software|repository|benchmark|maintenance|issue/i,
    elapsedMs: alpha.elapsedMs,
    latencyTargetMs: 45_000,
  }),
  findings: findings.length,
  groundedFindings: Math.min(findings.length, grounded.length),
  triangulatedFindings: Math.min(findings.length, triangulated.length),
});

let defenderContent: Record<string, unknown> = {};
if (typeof defender.response.output?.content === "string") {
  try {
    defenderContent = JSON.parse(defender.response.output.content) as Record<
      string,
      unknown
    >;
  } catch {
    defenderContent = {};
  }
} else if (
  defender.response.output?.content &&
  typeof defender.response.output.content === "object"
) {
  defenderContent = defender.response.output.content;
}
const defenderFindings = Array.isArray(defenderContent.findings)
  ? defenderContent.findings
  : [];
const defenderTools = Array.isArray(defenderContent.tools)
  ? defenderContent.tools
  : [];
const qualifiedDefenderTools = defenderTools.filter((item) => {
  if (!item || typeof item !== "object") return false;
  const tool = item as Record<string, unknown>;
  return (
    /^https:\/\/github\.com\//i.test(String(tool.repository ?? "")) &&
    ["capability", "maintenanceEvidence", "platformFit", "tradeoff"].every(
      (field) => String(tool[field] ?? "").trim().length >= 12,
    )
  );
});
const defenderGrounding = defender.response.output?.grounding ?? [];
cases.push({
  ...baseObservation({
    name: "defender",
    response: defender.response,
    targetResults: 12,
    targetDomains: 8,
    relevance:
      /CVE|advisory|exploit|vulnerab|CISA|KEV|Node\.js|npm|supply.?chain|incident|OSINT|OPSEC/i,
    elapsedMs: defender.elapsedMs,
    latencyTargetMs: 60_000,
  }),
  datedResults: defender.response.results.filter((hit) => hit.publishedDate)
    .length,
  freshResults: defender.response.results.filter((hit) => {
    const published = hit.publishedDate
      ? Date.parse(hit.publishedDate)
      : Number.NaN;
    return Number.isFinite(published) && published >= recentBoundary.getTime();
  }).length,
  findings: defenderFindings.length,
  groundedFindings: Math.min(
    defenderFindings.length,
    defenderGrounding.filter((item) => item.citations.length > 0).length,
  ),
  triangulatedFindings: Math.min(
    defenderFindings.length,
    defenderGrounding.filter(
      (item) =>
        new Set(
          item.citations
            .map((citation) => domain(citation.url))
            .filter(Boolean),
        ).size >= 2,
    ).length,
  ),
  toolCandidates: defenderTools.length,
  qualifiedToolCandidates: qualifiedDefenderTools.length,
});

const report = {
  generatedAt: new Date().toISOString(),
  provider: "exa",
  ...scoreExaReliability(cases),
  observations: cases,
};
const output = path.join(repo, "reliability", "exa", "latest.json");
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.score < 70 || report.passed < report.cases) process.exitCode = 1;
