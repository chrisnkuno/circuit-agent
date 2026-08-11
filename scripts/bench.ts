#!/usr/bin/env bun
/**
 * Nova's startup and turn benchmark.
 *
 * Exists because "it feels slow" cannot be optimised and "it got faster" cannot be claimed. Every
 * scenario here is something a person waits on: the floor under every invocation, the pause before
 * the prompt appears, the round trip of a whole turn with the model's own latency removed.
 *
 * Three decisions worth knowing:
 *
 * - **Median and p95, never mean.** A mean is dragged around by one unlucky GC pause or a noisy
 *   neighbour on the machine, which is exactly the sample a startup benchmark should ignore. The
 *   median is what a user typically waits; p95 is the bad day they remember.
 * - **Warmup runs are discarded.** The first execution pays for a cold page cache and an empty V8
 *   compile cache, so including it measures the filesystem rather than the change under test. Cold
 *   start is worth measuring too, which is why it is its own scenario rather than contamination in
 *   all the others.
 * - **Comparison is built in.** `--save` writes a baseline and `--baseline` diffs against it, so a
 *   change is reported as a delta with a noise floor rather than a number someone has to remember.
 *   A difference smaller than the run-to-run spread is reported as noise, not as a win.
 */

import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "packages/nova-cli/dist/nova.mjs");

/**
 * The real `node`, never `process.execPath`.
 *
 * This script is run with `bun run`, so `process.execPath` is Bun — which reports a Node version
 * and would have measured a runtime no user of the published CLI is on. It showed up as a cold
 * start faster than a warm one, which is impossible and was the benchmark measuring itself wrong.
 * npm's shim launches `node`, so that is what a timing here has to launch.
 */
const NODE = process.env.NOVA_BENCH_NODE ?? "node";

type Sample = number;
type Stats = { median: number; p95: number; min: number; runs: number };
type Scenario = { name: string; what: string; run: (context: BenchContext) => Promise<void>; iterations?: number; coldEachRun?: boolean };
type BenchContext = { cwd: string; configDir: string; cacheDir: string; stubUrl: string };

function percentile(sorted: readonly Sample[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function summarize(samples: Sample[]): Stats {
  const sorted = [...samples].sort((left, right) => left - right);
  return { median: percentile(sorted, 0.5), p95: percentile(sorted, 0.95), min: sorted[0] ?? 0, runs: sorted.length };
}

/** Runs the CLI to completion and returns wall-clock milliseconds. Throws on a non-zero exit, since timing a crash is meaningless. */
function timeCli(args: string[], context: BenchContext, env: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    // `env` is built as a plain string map and cast at this one boundary: this repo's Next.js types
    // augment `ProcessEnv` to require `NODE_ENV`, so a fresh object literal typed as one has to
    // carry a field that has nothing to do with launching a CLI. Same treatment as command.ts.
    const environment: Record<string, string> = {
      PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
      NOVA_CONFIG_DIR: context.configDir,
      // Deliberately does NOT set NODE_COMPILE_CACHE. Setting it here would enable V8's on-disk
      // cache for every run and report a startup no user gets, since nobody's shell exports it.
      // Whatever caching the CLI does must be something the CLI itself turns on; the benchmark's
      // job is to measure what ships, not to hand it an advantage and call the result a number.
      // `NOVA_COMPILE_CACHE_DIR` only relocates the cache so a run cannot pollute the developer's.
      NOVA_COMPILE_CACHE_DIR: context.cacheDir,
      NOVA_FX_OFFLINE: "true", TZ: "UTC", NO_COLOR: "1", ...env,
    };
    const child = spawn(NODE, [CLI, ...args], {
      cwd: context.cwd,
      env: environment as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk; });
    child.stdout?.resume();
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      if (code !== 0) reject(new Error(`exited ${code}: ${stderr.slice(0, 300)}`));
      else resolve(elapsed);
    });
  });
}

const SCENARIOS: Scenario[] = [
  {
    name: "startup:version",
    what: "The floor under every invocation — load, parse, print, exit.",
    iterations: 20,
    run: async (context) => { await timeCli(["--version"], context); },
  },
  {
    name: "startup:cold",
    what: "First run on a machine: empty V8 compile cache, as a new install behaves.",
    iterations: 6,
    coldEachRun: true,
    run: async (context) => { await timeCli(["--version"], context); },
  },
  {
    name: "startup:help",
    what: "Startup plus rendering the full command list.",
    iterations: 20,
    run: async (context) => { await timeCli(["--help"], context); },
  },
  {
    name: "startup:providers",
    what: "Startup plus reading settings and resolving provider configuration.",
    iterations: 15,
    run: async (context) => { await timeCli(["--providers"], context); },
  },
  {
    name: "turn:json",
    what: "A whole turn end to end against a local model stub — everything but the model's own latency.",
    iterations: 10,
    run: async (context) => {
      await timeCli(["--json", "say hi"], context, {
        ANTHROPIC_API_KEY: "sk-ant-bench", ANTHROPIC_BASE_URL: context.stubUrl, ANTHROPIC_MODEL: "claude-sonnet-5",
      });
    },
  },
];

/** A model that answers instantly, so a turn measures Nova rather than the network. */
async function startStub(): Promise<{ url: string; close: () => Promise<void> }> {
  const { startAnthropicStub } = await import(path.join(ROOT, "packages/nova-cli/src/pty/anthropic-stub.ts"));
  const stub = await startAnthropicStub();
  // Deep enough that no run in any scenario exhausts the queue and blocks.
  for (let index = 0; index < 200; index += 1) stub.enqueue({ kind: "text", text: "done" });
  return { url: stub.url, close: () => stub.close() };
}

function formatMs(value: number): string {
  return `${value.toFixed(1)}ms`;
}

function formatDelta(current: number, baseline: number, noiseFloor: number): string {
  const delta = current - baseline;
  const percent = baseline === 0 ? 0 : (delta / baseline) * 100;
  if (Math.abs(delta) < noiseFloor) return `  ~ noise (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}ms)`;
  const arrow = delta < 0 ? "faster" : "SLOWER";
  return `  ${arrow} ${Math.abs(percent).toFixed(1)}% (${delta >= 0 ? "+" : ""}${delta.toFixed(1)}ms)`;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const savePath = argv.includes("--save") ? argv[argv.indexOf("--save") + 1] : undefined;
  const baselinePath = argv.includes("--baseline") ? argv[argv.indexOf("--baseline") + 1] : undefined;
  const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;

  if (!(await fs.stat(CLI).catch(() => null))) {
    process.stderr.write(`No built CLI at ${CLI}. Run "bun run build:cli" first.\n`);
    return 1;
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "nova-bench-"));
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-bench-cfg-"));
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-bench-cache-"));
  await fs.writeFile(path.join(cwd, "app.ts"), "export const port = 3000;\n");
  const stub = await startStub();
  const context: BenchContext = { cwd, configDir, cacheDir, stubUrl: stub.url };
  // Reported rather than assumed: which runtime actually executed the CLI is the first thing to
  // check when two runs of this benchmark disagree.
  const nodeVersion = await new Promise<string>((resolve) => {
    const probe = spawn(NODE, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    probe.stdout.on("data", (chunk) => { out += chunk; });
    probe.on("close", () => resolve(out.trim() || "unknown"));
    probe.on("error", () => resolve("unknown"));
  });

  const baseline: Record<string, Stats> | undefined = baselinePath
    ? JSON.parse(await fs.readFile(baselinePath, "utf8")).scenarios
    : undefined;

  process.stdout.write(`Nova benchmark — ${nodeVersion} on ${os.platform()}/${os.arch()}\n`);
  process.stdout.write(`${"".padEnd(72, "─")}\n`);

  const results: Record<string, Stats> = {};
  let regressed = false;

  try {
    for (const scenario of SCENARIOS) {
      if (only && !scenario.name.includes(only)) continue;
      const iterations = scenario.iterations ?? 12;
      const samples: Sample[] = [];

      // Warmup, discarded: the first run pays for a cold page cache and an empty compile cache,
      // which measures the filesystem rather than the code. `startup:cold` opts out — for it, that
      // cost *is* the measurement.
      if (!scenario.coldEachRun) {
        for (let index = 0; index < 3; index += 1) await scenario.run(context);
      }

      for (let index = 0; index < iterations; index += 1) {
        if (scenario.coldEachRun) await fs.rm(cacheDir, { recursive: true, force: true }).then(() => fs.mkdir(cacheDir, { recursive: true }));
        const started = process.hrtime.bigint();
        await scenario.run(context);
        samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      }

      const stats = summarize(samples);
      results[scenario.name] = stats;

      // The noise floor is this run's own spread, not a fixed number: a machine under load has a
      // wider one, and calling a 3ms move a win there would be inventing a result.
      const noiseFloor = Math.max(2, (stats.p95 - stats.min) / 2);
      const comparison = baseline?.[scenario.name] ? formatDelta(stats.median, baseline[scenario.name].median, noiseFloor) : "";
      if (comparison.includes("SLOWER")) regressed = true;

      process.stdout.write(`${scenario.name.padEnd(20)} ${formatMs(stats.median).padStart(9)}  p95 ${formatMs(stats.p95).padStart(9)}  min ${formatMs(stats.min).padStart(9)}${comparison}\n`);
      process.stdout.write(`${" ".repeat(20)} ${scenario.what}\n`);
    }
  } finally {
    await stub.close();
    for (const directory of [cwd, configDir, cacheDir]) await fs.rm(directory, { recursive: true, force: true });
  }

  if (savePath) {
    await fs.writeFile(savePath, `${JSON.stringify({ recordedAt: new Date().toISOString(), node: process.version, platform: `${os.platform()}/${os.arch()}`, scenarios: results }, null, 2)}\n`);
    process.stdout.write(`\nSaved baseline to ${savePath}\n`);
  }
  if (baseline) {
    process.stdout.write(`\n${regressed ? "A scenario regressed beyond this run's noise floor." : "No regression beyond this run's noise floor."}\n`);
  }
  return regressed ? 1 : 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
