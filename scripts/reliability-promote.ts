import { promises as fs } from "node:fs";
import path from "node:path";

type Candidate = {
  generatedAt: string;
  provider: string;
  model: string;
  score: number;
  grade: string;
  cases: number;
  passed: number;
  auditTests: number;
  auditFailures: number;
  toolFailureRate: number;
  providerFailureRate: number;
  outputQualityRate: number;
  actualTokens: number;
  medianLatencyMs: number;
  auditPlatforms: string[];
};

const repo = path.resolve(import.meta.dirname, "..");
const reportsDirectory = path.join(repo, "reliability", "reports");
const candidates = await Promise.all(
  (await fs.readdir(reportsDirectory).catch(() => []))
    .filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await fs.readFile(path.join(reportsDirectory, name), "utf8")) as Candidate),
);
const eligible = candidates
  .filter((report) => report.provider === "openai" && report.model.endsWith(":free") && report.cases > 0 && report.passed === report.cases && report.auditFailures === 0)
  .sort((left, right) =>
    right.score - left.score ||
    right.outputQualityRate - left.outputQualityRate ||
    left.providerFailureRate - right.providerFailureRate ||
    left.toolFailureRate - right.toolFailureRate ||
    left.medianLatencyMs - right.medianLatencyMs,
  );

const winner = eligible[0];
if (!winner) {
  process.stdout.write("No fully passing free-model report was eligible for promotion; retained the last verified score.\n");
  process.exit(0);
}

await fs.writeFile(path.join(repo, "reliability", "latest.json"), `${JSON.stringify(winner, null, 2)}\n`);
const readmeFile = path.join(repo, "README.md");
const readme = await fs.readFile(readmeFile, "utf8");
const block = [
  "<!-- nova-reliability:start -->",
  "## Nova scheduled reliability",
  "",
  `**${winner.score}/100 (${winner.grade})** · ${winner.passed}/${winner.cases} live journeys · ${winner.auditTests.toLocaleString()} control tests · ${winner.auditFailures} failures`,
  "",
  `Latest run: ${winner.generatedAt.slice(0, 10)} on free model \`${winner.model}\`. ${winner.toolFailureRate}% tool failure rate · ${winner.providerFailureRate}% provider failure rate · ${winner.outputQualityRate}% output-quality checks · ${winner.actualTokens.toLocaleString()} tokens · ${winner.auditPlatforms.length}/3 operating systems. Daily benchmark: code build, responsive web build, debug, scoped search, Defender review, cross-process resume, UI, memory, security, approvals, cost accounting, Exa research, and portability. [Machine-readable evidence](reliability/latest.json).`,
  "<!-- nova-reliability:end -->",
].join("\n");
const next = readme.replace(/<!-- nova-reliability:start -->[\s\S]*?<!-- nova-reliability:end -->/, block);
if (next === readme) throw new Error("README reliability markers are missing");
await fs.writeFile(readmeFile, next);
process.stdout.write(`Promoted ${winner.model} at ${winner.score}/100.\n`);
