import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ReliabilityAudit,
  ReliabilityAuditCategory,
} from "@circuit-nova/nova-core/nova-cli/reliability";

const repo = path.resolve(import.meta.dirname, "../..");
const cli = path.join(repo, "packages", "nova-cli", "dist", "nova.mjs");
const auditDirectory = path.resolve(
  process.env.NOVA_RELIABILITY_AUDIT_DIR?.trim() ||
    path.join(repo, "reliability", "audits"),
);

const suites: Array<{ name: ReliabilityAuditCategory; files: string[] }> = [
  {
    name: "ui",
    files: [
      "packages/nova-cli/src/fixed-layout.test.ts",
      "packages/nova-cli/src/fixed-screen.test.ts",
      "packages/nova-cli/src/layout.test.ts",
      "packages/nova-cli/src/viewport.test.ts",
      "packages/nova-cli/src/tui.test.ts",
      "packages/nova-cli/src/navigation.test.ts",
      "packages/nova-cli/src/commands.test.ts",
      "packages/nova-cli/src/reliability-status.test.ts",
      "reliability/site/site.test.ts",
    ],
  },
  {
    name: "taskExecution",
    files: [
      "packages/agent-core/src/agent-runtime.test.ts",
      "packages/agent-core/src/nova-cli/agent.test.ts",
      "packages/agent-core/src/nova-cli/auto-mode.test.ts",
      "packages/agent-core/src/nova-cli/tools.test.ts",
      "packages/agent-core/src/nova-cli/tool-result.test.ts",
      "packages/agent-core/src/nova-cli/workspace-conformance.test.ts",
    ],
  },
  {
    name: "memoryResume",
    files: [
      "packages/agent-core/src/nova-cli/session.test.ts",
      "packages/agent-core/src/nova-cli/remember.test.ts",
      "packages/agent-core/src/nova-cli/state-client.test.ts",
      "packages/nova-cli/src/memory.test.ts",
      "packages/nova-cli/src/resume.test.ts",
      "packages/nova-cli/src/chat-history.test.ts",
      "packages/nova-cli/src/state-history.test.ts",
      "packages/nova-cli/src/resumed-spend.test.ts",
    ],
  },
  {
    name: "security",
    files: [
      "packages/agent-core/src/nova-cli/safety.test.ts",
      "packages/agent-core/src/nova-cli/adversarial-policy.test.ts",
      "packages/agent-core/src/nova-cli/secret-scan.test.ts",
      "packages/agent-core/src/sandbox-policy.test.ts",
      "packages/agent-core/src/nova-cli/session.test.ts",
    ],
  },
  {
    name: "approvals",
    files: [
      "packages/agent-core/src/nova-cli/permissions.test.ts",
      "packages/nova-cli/src/nova.test.ts",
    ],
  },
  {
    name: "costAccuracy",
    files: [
      "packages/agent-core/src/nova-cli/cost.test.ts",
      "packages/agent-core/src/pricing.test.ts",
      "packages/agent-core/src/model-cost.test.ts",
      "packages/agent-core/src/providers/price-catalog.test.ts",
      "packages/nova-cli/src/local-currency.test.ts",
      "packages/nova-cli/src/resumed-spend.test.ts",
    ],
  },
  {
    name: "portability",
    files: [
      "packages/agent-core/src/nova-cli/environment.test.ts",
      "packages/agent-core/src/nova-cli/migration.test.ts",
      "packages/agent-core/src/nova-cli/nested-instructions.test.ts",
      "packages/nova-cli/src/settings.test.ts",
      "packages/nova-cli/src/glyphs.test.ts",
      "packages/nova-cli/src/auto-update.test.ts",
      "packages/nova-cli/src/update.test.ts",
    ],
  },
];

function run(
  argv: string[],
  cwd = repo,
  timeoutMs = 10 * 60_000,
): Promise<{ code: number; output: string; elapsedMs: number }> {
  const started = performance.now();
  return new Promise((resolve) => {
    execFile(
      argv[0],
      argv.slice(1),
      { cwd, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code =
          typeof (error as NodeJS.ErrnoException | null)?.code === "number"
            ? (error as NodeJS.ErrnoException & { code: number }).code
            : error
              ? 1
              : 0;
        resolve({
          code,
          output: `${stdout}\n${stderr}`,
          elapsedMs: Math.round(performance.now() - started),
        });
      },
    );
  });
}

function count(output: string, label: "pass" | "fail"): number {
  const clean = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  const word = label === "pass" ? "(?:pass|passed)" : "(?:fail|failed)";
  const matches = [...clean.matchAll(new RegExp(`(\\d+)\\s+${word}\\b`, "g"))];
  return Number(matches.at(-1)?.[1] ?? 0);
}

async function historyStartupP50(): Promise<number> {
  await fs.access(cli);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-history-speed-"));
  const samples: number[] = [];
  for (let index = 0; index < 5; index += 1) {
    const result = await run(
      [process.execPath, cli, "--sessions", "--cwd", cwd],
      cwd,
      30_000,
    );
    if (result.code !== 0)
      throw new Error("The model-free history startup probe failed");
    samples.push(result.elapsedMs);
  }
  samples.sort((left, right) => left - right);
  return samples[2];
}

async function main(): Promise<void> {
  const categories: ReliabilityAudit["categories"] = [];
  for (const suite of suites) {
    const result = await run([
      process.execPath,
      "run",
      "test",
      "--",
      ...suite.files,
    ]);
    const passed = count(result.output, "pass");
    const failed = count(result.output, "fail");
    categories.push({
      name: suite.name,
      passed: result.code === 0 && failed === 0 && passed > 0,
      tests: passed + failed,
      failed,
      durationMs: result.elapsedMs,
    });
    if (result.code !== 0) {
      process.stderr.write(
        `Audit category ${suite.name} failed.\n${result.output.slice(-8_000)}\n`,
      );
    }
  }
  const report: ReliabilityAudit = {
    platform: process.platform,
    architecture: process.arch,
    generatedAt: new Date().toISOString(),
    categories,
    historyStartupP50Ms: await historyStartupP50(),
  };
  await fs.mkdir(auditDirectory, { recursive: true });
  const file = path.join(
    auditDirectory,
    `${process.platform}-${process.arch}.json`,
  );
  await fs.writeFile(file, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (categories.some((category) => !category.passed)) process.exitCode = 1;
}

await main();
