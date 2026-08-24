import { promises as fs } from "node:fs";
import path from "node:path";
import {
  scoreReliability,
  type ReliabilityAudit,
  type ReliabilityCase,
} from "@circuit-nova/nova-core/nova-cli/reliability";

const repo = path.resolve(import.meta.dirname, "../..");
const reportFile = path.join(repo, "reliability", "latest.json");
const auditDirectory = path.join(repo, "reliability", "audits");
const existing = JSON.parse(await fs.readFile(reportFile, "utf8")) as {
  generatedAt: string;
  provider: string;
  model: string;
  observations: ReliabilityCase[];
};
const audits = await Promise.all(
  (await fs.readdir(auditDirectory))
    .filter((name) => name.endsWith(".json"))
    .map(
      async (name) =>
        JSON.parse(
          await fs.readFile(path.join(auditDirectory, name), "utf8"),
        ) as ReliabilityAudit,
    ),
);
const exaScore = await fs
  .readFile(path.join(repo, "reliability", "exa", "latest.json"), "utf8")
  .then((value) => (JSON.parse(value) as { score?: number }).score ?? null)
  .catch(() => null);
const report = {
  generatedAt: existing.generatedAt,
  rescoredAt: new Date().toISOString(),
  provider: existing.provider,
  model: existing.model,
  ...scoreReliability(existing.observations, audits, { exaScore }),
  observations: existing.observations,
  audits,
};
await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);

const readmeFile = path.join(repo, "README.md");
const readme = await fs.readFile(readmeFile, "utf8");
const block = [
  "<!-- nova-reliability:start -->",
  "## Nova scheduled reliability",
  "",
  `**${report.score}/100 (${report.grade})** · ${report.passed}/${report.cases} live journeys · ${report.auditTests.toLocaleString()} control tests · ${report.auditFailures} failures`,
  "",
  `Latest run: ${report.generatedAt.slice(0, 10)} on \`${report.model}\`. ${report.toolFailureRate}% tool failure rate · ${report.providerFailureRate}% provider failure rate · ${report.outputQualityRate}% output-quality checks · ${report.actualTokens.toLocaleString()} tokens · ${report.auditPlatforms.length}/3 operating systems. Daily benchmark: code build, responsive web build, debug, scoped search, Defender review, cross-process resume, UI, memory, security, approvals, cost accounting, Exa research, and portability. [Machine-readable evidence](reliability/latest.json).`,
  "<!-- nova-reliability:end -->",
].join("\n");
const markerBlock = /<!-- nova-reliability:start -->[\s\S]*?<!-- nova-reliability:end -->/;
if (!markerBlock.test(readme)) throw new Error("README reliability markers are missing");
const next = readme.replace(markerBlock, block);
await fs.writeFile(readmeFile, next);
process.stdout.write(
  `${JSON.stringify({ score: report.score, grade: report.grade, auditTests: report.auditTests, auditFailures: report.auditFailures, auditPlatforms: report.auditPlatforms })}\n`,
);
