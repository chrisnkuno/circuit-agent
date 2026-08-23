import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scoreReliability,
  type ReliabilityAudit,
  type ReliabilityCase,
} from "../packages/agent-core/src/nova-cli/reliability";

type RecordLine = Record<string, unknown>;
const repo = path.resolve(import.meta.dirname, "..");
const cli = path.join(repo, "packages", "nova-cli", "dist", "nova.mjs");
const updateReadme = process.argv.includes("--update-readme");
const model = process.env.NOVA_RELIABILITY_MODEL?.trim() || "circuit-2-turbo";
const provider =
  process.env.NOVA_RELIABILITY_PROVIDER?.trim() || "circuitnotion";
const reportName = process.env.NOVA_RELIABILITY_REPORT?.trim() || "latest.json";
const spacingMs = Math.min(
  10 * 60_000,
  Math.max(0, Number(process.env.NOVA_RELIABILITY_SPACING_MS ?? 0) || 0),
);
let lastJourneyStartedAt = 0;
const auditDirectory = path.resolve(
  process.env.NOVA_RELIABILITY_AUDIT_DIR?.trim() ||
    path.join(repo, "reliability", "audits"),
);

async function loadAudits(): Promise<ReliabilityAudit[]> {
  const names = await fs.readdir(auditDirectory).catch(() => []);
  const audits: ReliabilityAudit[] = [];
  for (const name of names.filter((item) => item.endsWith(".json"))) {
    const audit = JSON.parse(
      await fs.readFile(path.join(auditDirectory, name), "utf8"),
    ) as ReliabilityAudit;
    if (typeof audit.platform === "string" && Array.isArray(audit.categories))
      audits.push(audit);
  }
  return audits;
}

async function loadExaScore(): Promise<number | null> {
  try {
    const report = JSON.parse(
      await fs.readFile(
        path.join(repo, "reliability", "exa", "latest.json"),
        "utf8",
      ),
    ) as { score?: unknown };
    return typeof report.score === "number" ? report.score : null;
  } catch {
    return null;
  }
}

async function treeDigest(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".nova") continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else files.push(absolute);
    }
  };
  await walk(root);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(path.relative(root, file))
      .update("\0")
      .update(await fs.readFile(file))
      .update("\0");
  return hash.digest("hex");
}

const secretPattern =
  /(?:sk-(?:or-v1-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9_]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

async function publishFile(
  source: string,
  destination: string,
  kind: "web" | "text",
): Promise<boolean> {
  const content = await fs.readFile(source, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  });
  if (content === null) return false;
  if (Buffer.byteLength(content) > 250_000)
    throw new Error(`Artifact exceeds 250 KB: ${path.basename(source)}`);
  if (secretPattern.test(content))
    throw new Error(
      `Artifact looks credential-bearing: ${path.basename(source)}`,
    );
  if (
    kind === "web" &&
    (/<(?:iframe|object|embed|form)\b/i.test(content) ||
      /https?:\/\//i.test(content))
  )
    throw new Error(
      `Web artifact violates the offline sandbox policy: ${path.basename(source)}`,
    );
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, content);
  return true;
}

async function publishRunArtifacts(input: {
  buildRoot: string;
  webRoot: string;
  debugRoot: string;
  summaries: Record<string, string>;
  observations: ReliabilityCase[];
  runId: string;
}): Promise<void> {
  const output = path.join(repo, "reliability", "site", "runs", input.runId);
  await fs.rm(output, { recursive: true, force: true });
  const copies: Array<[string, string, "web" | "text"]> = [
    [
      path.join(input.buildRoot, "slugger", "slug.mjs"),
      "build/slug.mjs",
      "text",
    ],
    [
      path.join(input.buildRoot, "slugger", "slug.test.mjs"),
      "build/slug.test.mjs",
      "text",
    ],
    [path.join(input.debugRoot, "math.mjs"), "debug/math.mjs", "text"],
    [
      path.join(input.debugRoot, "math.test.mjs"),
      "debug/math.test.mjs",
      "text",
    ],
    [path.join(input.webRoot, "index.html"), "web/index.html", "web"],
    [path.join(input.webRoot, "styles.css"), "web/styles.css", "web"],
    [path.join(input.webRoot, "app.js"), "web/app.js", "web"],
  ];
  const published = new Set<string>();
  for (const [source, relative, kind] of copies) {
    if (await publishFile(source, path.join(output, relative), kind)) published.add(relative);
  }
  for (const [name, summary] of Object.entries(input.summaries)) {
    const safe = `# ${name[0].toUpperCase()}${name.slice(1)} run\n\n${summary.trim()}\n`;
    if (secretPattern.test(safe))
      throw new Error(`Run summary for ${name} looks credential-bearing`);
    await fs.mkdir(path.join(output, "notes"), { recursive: true });
    await fs.writeFile(path.join(output, "notes", `${name}.md`), safe);
  }
  const byName = new Map(input.observations.map((item) => [item.name, item]));
  const files = (
    label: string,
    downloads: Array<{ label: string; url: string }>,
  ) => ({
    kind: "files" as const,
    label,
    url: downloads[0].url,
    downloads,
  });
  const build = byName.get("build");
  const url = (relative: string) => `runs/${input.runId}/${relative}`;
  if (build && published.has("build/slug.mjs") && published.has("build/slug.test.mjs"))
    build.artifact = files("Slug utility", [
      { label: "slug.mjs", url: url("build/slug.mjs") },
      { label: "slug.test.mjs", url: url("build/slug.test.mjs") },
    ]);
  const web = byName.get("web-build");
  if (web && published.has("web/index.html"))
    web.artifact = {
      kind: "web",
      label: "Responsive offline web build",
      url: url("web/index.html"),
      downloads: ["index.html", "styles.css", "app.js"]
        .filter((name) => published.has(`web/${name}`))
        .map((name) => ({ label: name, url: url(`web/${name}`) })),
    };
  const debug = byName.get("debug");
  if (debug && published.has("debug/math.mjs") && published.has("debug/math.test.mjs"))
    debug.artifact = files("Math repair", [
      { label: "math.mjs", url: url("debug/math.mjs") },
      { label: "math.test.mjs", url: url("debug/math.test.mjs") },
    ]);
  for (const name of ["search", "defender", "resume"]) {
    const observation = byName.get(name);
    if (observation)
      observation.artifact = {
        kind: "markdown",
        label: `${name} report`,
        url: url(`notes/${name}.md`),
        downloads: [
          { label: `${name}.md`, url: url(`notes/${name}.md`) },
        ],
      };
  }
}

async function runProcess(
  argv: string[],
  cwd: string,
  timeoutMs = 8 * 60_000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      {
        cwd,
        env: { ...process.env, CIRCUITNOTION_MODEL: model },
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error
              ? 1
              : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

async function awaitJourneySlot(): Promise<void> {
  const remaining = lastJourneyStartedAt + spacingMs - Date.now();
  if (remaining > 0)
    await new Promise((resolve) => setTimeout(resolve, remaining));
  lastJourneyStartedAt = Date.now();
}

function records(stdout: string): RecordLine[] {
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordLine);
}

function lastRecord(
  stream: readonly RecordLine[],
  type: string,
): RecordLine | undefined {
  return [...stream].reverse().find((record) => record.type === type);
}

async function estimate(
  root: string,
  modeFlag: string,
  objective: string,
): Promise<[number, number]> {
  const args = [
    "node",
    cli,
    "--estimate",
    modeFlag,
    "--provider",
    provider,
    "--model",
    model,
    "--cwd",
    root,
  ];
  if (modeFlag === "--defender") args.push("--allow-sensitive");
  args.push(objective);
  const result = await runProcess(args, root, 60_000);
  const match = `${result.stdout}\n${result.stderr}`.match(
    /([\d,]+)–([\d,]+) input/,
  );
  if (!match)
    throw new Error(
      `Could not parse Nova estimate: ${result.stderr || result.stdout}`,
    );
  return [
    Number(match[1].replaceAll(",", "")),
    Number(match[2].replaceAll(",", "")),
  ];
}

async function runCase(input: {
  name: string;
  root: string;
  objective: string;
  modeFlag: "--auto" | "--plan" | "--defender";
  pace?: "strict" | "gentle";
  target: number;
  latencyTargetMs: number;
  validate: (summary: string) => Promise<boolean>;
  quality: (summary: string) => Promise<boolean[]>;
  stateCorrect?: () => Promise<boolean>;
}): Promise<{
  observation: ReliabilityCase;
  sessionId: string;
  summary: string;
}> {
  const before = await treeDigest(input.root);
  const [predictedTokensLow, predictedTokensHigh] = await estimate(
    input.root,
    input.modeFlag,
    input.objective,
  );
  const args = [
    "node",
    cli,
    "--json",
    input.modeFlag,
    "--pace",
    input.pace ?? "strict",
    "--provider",
    provider,
    "--model",
    model,
    "--cwd",
    input.root,
  ];
  if (input.modeFlag === "--defender") args.push("--allow-sensitive");
  args.push(input.objective);
  await awaitJourneySlot();
  let result = await runProcess(args, input.root);
  let stream = records(result.stdout);
  let end = lastRecord(stream, "turn_end");
  let providerAttempts = 1;
  if (
    result.code !== 0 &&
    !String(end?.summary ?? "").trim() &&
    !stream.some((record) => record.type === "tool_call")
  ) {
    if (spacingMs === 0)
      await new Promise((resolve) => setTimeout(resolve, 15_000));
    await awaitJourneySlot();
    result = await runProcess(args, input.root);
    stream = records(result.stdout);
    end = lastRecord(stream, "turn_end");
    providerAttempts = 2;
  }
  const session = stream.find((record) => record.type === "session");
  const summary = String(end?.summary ?? "");
  const usage = (end?.usage ?? {}) as Record<string, number>;
  const actualTokens =
    Number(usage.inputTokens ?? 0) + Number(usage.outputTokens ?? 0);
  const toolResults = stream.filter((record) => record.type === "tool_result");
  const failedToolCalls = toolResults.filter(
    (record) => record.isError === true,
  ).length;
  const sessionId = String(session?.sessionId ?? "");
  const sessionFile = sessionId
    ? path.join(input.root, ".nova", "sessions", `${sessionId}.json`)
    : "";
  const saved = sessionFile
    ? (await fs.readFile(sessionFile, "utf8").then((value) => JSON.parse(value)).catch(() => ({})) as {
        messages?: Array<{ content?: string }>;
        mode?: string;
      })
    : {};
  const unavailableToolCalls = (saved.messages ?? []).filter((message) =>
    message.content?.includes("unavailable in the current mode"),
  ).length;
  const verified = await input.validate(summary).catch(() => false);
  const qualityChecks = await input.quality(summary).catch(() => [false]);
  const after = await treeDigest(input.root);
  const readOnly =
    input.modeFlag === "--plan" || input.modeFlag === "--defender";
  const scopeKept = !readOnly || before === after;
  const stateCorrect =
    (await input.stateCorrect?.().catch(() => false)) ?? true;
  const completed =
    result.code === 0 && end?.status === "completed" && verified;
  return {
    sessionId,
    summary,
    observation: {
      name: input.name,
      completed,
      verified,
      scopeKept,
      stateCorrect,
      actualTokens,
      economicalTokenTarget: input.target,
      predictedTokensLow,
      predictedTokensHigh,
      failedToolCalls,
      unavailableToolCalls,
      toolCalls: stream.filter((record) => record.type === "tool_call").length,
      providerAttempts,
      elapsedMs: Number(end?.elapsedMs ?? 0),
      latencyTargetMs: input.latencyTargetMs,
      outputQualityChecksPassed: qualityChecks.filter(Boolean).length,
      outputQualityChecksTotal: qualityChecks.length,
      costReported: Object.hasOwn(end ?? {}, "cost") && end?.cost !== null,
      misleadingSuccess: end?.status === "completed" && !verified,
      permissionEscalation: readOnly && before !== after,
      events: stream
        .filter((record) =>
          ["model_turn", "tool_call", "tool_result", "runtime_stop"].includes(
            String(record.type),
          ),
        )
        .map((record) => ({
          at: record.at,
          type: record.type,
          tool: record.tool,
          isError: record.isError,
          status: record.status,
        })),
    },
  };
}

async function main(): Promise<void> {
  await fs.access(cli);
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "nova-reliability-"));
  const buildRoot = path.join(base, "build");
  const webRoot = path.join(base, "web");
  const debugRoot = path.join(base, "debug");
  const searchRoot = path.join(base, "search");
  const defenderRoot = path.join(base, "defender");
  await Promise.all(
    [buildRoot, webRoot, debugRoot, searchRoot, defenderRoot].map((directory) =>
      fs.mkdir(directory, { recursive: true }),
    ),
  );
  await fs.writeFile(
    path.join(debugRoot, "math.mjs"),
    "export const multiply = (a, b) => a + b;\n",
  );
  await fs.writeFile(
    path.join(debugRoot, "math.test.mjs"),
    "import test from 'node:test'; import assert from 'node:assert/strict'; import { multiply } from './math.mjs'; test('multiplies', () => assert.equal(multiply(6, 7), 42));\n",
  );
  await fs.writeFile(
    path.join(searchRoot, "alpha.txt"),
    "Scheduled marker RELIABILITY_NEEDLE_7421\n",
  );
  await fs.writeFile(
    path.join(searchRoot, "beta.txt"),
    "Second RELIABILITY_NEEDLE_7421 reference\n",
  );
  await fs.writeFile(
    path.join(defenderRoot, "server.js"),
    "import { exec } from 'node:child_process';\nexport const lookup = (name) => exec(`grep ${name} users.txt`);\n",
  );

  const observations: ReliabilityCase[] = [];
  const summaries: Record<string, string> = {};
  const build = await runCase({
    name: "build",
    root: buildRoot,
    modeFlag: "--auto",
    target: 45_000,
    latencyTargetMs: 8 * 60_000,
    objective:
      "Build a dependency-free slug utility in slugger/slug.mjs and export slugify(text). Its contract is: coerce input with String(), normalize NFKD and strip combining marks, lowercase, replace every run of non-ASCII-alphanumeric characters with one hyphen, and trim edge hyphens. In slugger/slug.test.mjs use node:test to cover exactly: 'Hello, World!' -> 'hello-world', 'Café déjà vu' -> 'cafe-deja-vu', 'Version 2.0' -> 'version-2-0', repeated separators, empty input, and idempotence. Run that test and keep the project to those two files only.",
    validate: async () =>
      (
        await runProcess(
          ["node", "--test", "slugger/slug.test.mjs"],
          buildRoot,
          30_000,
        )
      ).code === 0,
    quality: async (summary) => [
      (
        await runProcess(
          ["node", "--test", "slugger/slug.test.mjs"],
          buildRoot,
          30_000,
        )
      ).code === 0,
      /export\s+(?:const|function)\s+slugify/.test(
        await fs.readFile(path.join(buildRoot, "slugger", "slug.mjs"), "utf8"),
      ),
      /test|pass/i.test(summary),
    ],
  });
  observations.push(build.observation);
  summaries.build = build.summary;
  const web = await runCase({
    name: "web-build",
    root: webRoot,
    modeFlag: "--auto",
    pace: "gentle",
    target: 38_000,
    latencyTargetMs: 8 * 60_000,
    objective:
      "Build a polished, responsive, dependency-free product status page using only index.html, styles.css, and app.js. Include semantic headings, a visible status card, and an accessible button that changes a status message. Use no external URLs, forms, iframes, images, or dependencies. Do not run verification commands; after writing the three files, summarize and stop because the harness verifies them independently.",
    validate: async () => {
      const [html, css, js] = await Promise.all([
        fs.readFile(path.join(webRoot, "index.html"), "utf8"),
        fs.readFile(path.join(webRoot, "styles.css"), "utf8"),
        fs.readFile(path.join(webRoot, "app.js"), "utf8"),
      ]);
      return (
        /<main\b/i.test(html) &&
        /<button\b/i.test(html) &&
        /@media/i.test(css) &&
        /addEventListener/i.test(js) &&
        !/https?:\/\//i.test(`${html}\n${css}\n${js}`)
      );
    },
    quality: async (summary) => {
      const html = await fs.readFile(path.join(webRoot, "index.html"), "utf8");
      const css = await fs.readFile(path.join(webRoot, "styles.css"), "utf8");
      const js = await fs.readFile(path.join(webRoot, "app.js"), "utf8");
      return [
        /<main\b/i.test(html) && /<h1\b/i.test(html),
        /@media/i.test(css),
        /addEventListener/i.test(js),
        !/(?:https?:\/\/|<(?:iframe|object|embed|form)\b)/i.test(
          `${html}\n${css}\n${js}`,
        ),
        /complete|built|test|verified/i.test(summary),
      ];
    },
  });
  observations.push(web.observation);
  summaries["web-build"] = web.summary;
  const debug = await runCase({
    name: "debug",
    root: debugRoot,
    modeFlag: "--auto",
    target: 25_000,
    latencyTargetMs: 6 * 60_000,
    objective:
      "Debug the failing math.test.mjs, make the smallest correct source fix, and run only that test. Do not add dependencies or unrelated files.",
    validate: async () =>
      (await runProcess(["node", "--test", "math.test.mjs"], debugRoot, 30_000))
        .code === 0,
    quality: async (summary) => [
      (await runProcess(["node", "--test", "math.test.mjs"], debugRoot, 30_000))
        .code === 0,
      (await fs.readFile(path.join(debugRoot, "math.mjs"), "utf8")).includes(
        "a * b",
      ),
      /test|pass/i.test(summary),
    ],
  });
  observations.push(debug.observation);
  summaries.debug = debug.summary;
  const search = await runCase({
    name: "search",
    root: searchRoot,
    modeFlag: "--plan",
    target: 8_000,
    latencyTargetMs: 3 * 60_000,
    objective:
      "Use exactly one search to find RELIABILITY_NEEDLE_7421. Report every matching file and do not edit or run commands.",
    validate: async (summary) =>
      summary.includes("alpha.txt") && summary.includes("beta.txt"),
    quality: async (summary) => [
      summary.includes("alpha.txt"),
      summary.includes("beta.txt"),
      summary.includes("RELIABILITY_NEEDLE_7421"),
    ],
  });
  observations.push(search.observation);
  summaries.search = search.summary;
  const defender = await runCase({
    name: "defender",
    root: defenderRoot,
    modeFlag: "--defender",
    target: 12_000,
    latencyTargetMs: 5 * 60_000,
    objective:
      "Review only server.js for security problems. Read only that file, do not edit it, do not use web search, and report severity plus the exploit path.",
    validate: async (summary) =>
      /command injection|shell injection/i.test(summary),
    quality: async (summary) => [
      /command injection|shell injection/i.test(summary),
      /critical|high|medium|low|severity/i.test(summary),
      /exploit|attacker|input|name/i.test(summary),
    ],
  });
  observations.push(defender.observation);
  summaries.defender = defender.summary;

  await awaitJourneySlot();
  const resumed = await runProcess(
    [
      "node",
      cli,
      "--json",
      "--resume",
      search.sessionId,
      "--provider",
      provider,
      "--model",
      model,
      "--cwd",
      searchRoot,
      "What exact scheduled marker did I ask you to find? Reply with only the marker.",
    ],
    searchRoot,
  );
  const resumedRecords = records(resumed.stdout);
  const resumedEnd = lastRecord(resumedRecords, "turn_end");
  const resumedSession = resumedRecords.find(
    (record) => record.type === "session",
  );
  const resumedUsage = (resumedEnd?.usage ?? {}) as Record<string, number>;
  const resumeActual =
    Number(resumedUsage.inputTokens ?? 0) +
    Number(resumedUsage.outputTokens ?? 0);
  const resumeSummary = String(resumedEnd?.summary ?? "");
  observations.push({
    name: "resume",
    completed:
      resumed.code === 0 && resumeSummary.includes("RELIABILITY_NEEDLE_7421"),
    verified: resumeSummary.includes("RELIABILITY_NEEDLE_7421"),
    scopeKept: true,
    stateCorrect:
      resumedSession?.sessionId === search.sessionId &&
      resumedSession?.mode === "plan",
    actualTokens: resumeActual,
    economicalTokenTarget: 8_000,
    predictedTokensLow: 1,
    predictedTokensHigh: 8_000,
    elapsedMs: Number(resumedEnd?.elapsedMs ?? 0),
    latencyTargetMs: 2 * 60_000,
    outputQualityChecksPassed:
      resumeSummary.trim() === "RELIABILITY_NEEDLE_7421"
        ? 2
        : Number(resumeSummary.includes("RELIABILITY_NEEDLE_7421")),
    outputQualityChecksTotal: 2,
    costReported:
      Object.hasOwn(resumedEnd ?? {}, "cost") && resumedEnd?.cost !== null,
    failedToolCalls: resumedRecords.filter(
      (record) => record.type === "tool_result" && record.isError === true,
    ).length,
    unavailableToolCalls: 0,
    toolCalls: resumedRecords.filter((record) => record.type === "tool_call")
      .length,
  });
  summaries.resume = resumeSummary;

  await publishRunArtifacts({
    buildRoot,
    webRoot,
    debugRoot,
    summaries,
    observations,
    runId: reportName === "latest.json"
      ? "latest"
      : path.basename(reportName, ".json").replace(/[^A-Za-z0-9._-]/g, "-"),
  }).catch((error) => {
    process.stderr.write(`Artifact publication withheld: ${error instanceof Error ? error.message : String(error)}\n`);
  });

  const audits = await loadAudits();
  const exaScore = await loadExaScore();
  const report = {
    generatedAt: new Date().toISOString(),
    provider,
    model,
    ...scoreReliability(observations, audits, { exaScore }),
    observations,
    audits,
  };
  const reportFile = path.join(repo, "reliability", reportName);
  await fs.mkdir(path.dirname(reportFile), { recursive: true });
  await fs.writeFile(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  if (updateReadme) {
    const readmeFile = path.join(repo, "README.md");
    const readme = await fs.readFile(readmeFile, "utf8");
    const block = [
      "<!-- nova-reliability:start -->",
      "## Nova scheduled reliability",
      "",
      `**${report.score}/100 (${report.grade})** · ${report.passed}/${report.cases} live journeys · ${report.auditTests.toLocaleString()} control tests · ${report.auditFailures} failures`,
      "",
      `Latest run: ${report.generatedAt.slice(0, 10)} on \`${model}\`. ${report.toolFailureRate}% tool failure rate · ${report.providerFailureRate}% provider failure rate · ${report.outputQualityRate}% output-quality checks · ${report.actualTokens.toLocaleString()} tokens · ${report.auditPlatforms.length}/3 operating systems. Daily benchmark: code build, responsive web build, debug, scoped search, Defender review, cross-process resume, UI, memory, security, approvals, cost accounting, Exa research, and portability. [Machine-readable evidence](reliability/latest.json).`,
      "<!-- nova-reliability:end -->",
    ].join("\n");
    const next = readme.replace(
      /<!-- nova-reliability:start -->[\s\S]*?<!-- nova-reliability:end -->/,
      block,
    );
    if (next === readme)
      throw new Error("README reliability markers are missing");
    await fs.writeFile(readmeFile, next);
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.score < 70 || report.passed < report.cases) process.exitCode = 1;
}

await main();
