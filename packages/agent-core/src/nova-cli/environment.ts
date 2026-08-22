import os from "node:os";
import type { NovaWorkspace } from "./backends";

/**
 * What the agent is standing on before it runs its first command.
 *
 * Every "run_command failed" that is really the agent's fault has the same shape: it assumed a
 * program that is not installed (`npm test` in a bun repo, `python` where only `python3` exists),
 * or assumed a shell that is not there (a pipe in a sandbox that executes argv). None of that is
 * knowable from the file listing alone — a `package.json` says nothing about whether `npm` is on
 * PATH — so it is measured once per session and stated in the prompt, where it costs a few dozen
 * tokens instead of a failed turn and a retry.
 *
 * Measured, never assumed: the report says a program is available only because `<program>
 * --version` exited zero in this workspace, and says it is missing only because that same call
 * failed. A guess dressed up as a fact would be worse than saying nothing.
 */
export type ToolPresence = { name: string; version: string | null };

export type EnvironmentReport = {
  backend: NovaWorkspace["kind"];
  /** The platform whose shell rules apply to commands — the container's for a sandbox, not the host's. */
  platform: NodeJS.Platform;
  /** Host detail worth having locally (`Linux 6.18 (WSL2)`); null for a sandbox, where the host is irrelevant. */
  host: string | null;
  /** How `run_command` executes: the backend's own guidance, verbatim. */
  execution: string;
  /** The manager this project actually uses, identified by its committed lockfile. */
  packageManager: { name: string; lockfile: string } | null;
  available: ToolPresence[];
  missing: string[];
};

/** Programs worth knowing about in any project: the runtimes and the search/VCS tools Nova reaches for. */
const BASE_PROBES = ["git", "node", "bun", "npm", "pnpm", "yarn", "rg", "python3"];

/**
 * Extra probes earned by a marker file in the root.
 *
 * Keyed on what the project actually is, so a Node repo does not spend a process launch asking
 * whether `cargo` is installed, and a Rust repo does find out before it tries.
 */
const MARKER_PROBES: Array<{ marker: RegExp; probes: string[] }> = [
  { marker: /^Cargo\.toml$/, probes: ["cargo", "rustc"] },
  { marker: /^go\.mod$/, probes: ["go"] },
  { marker: /^(pyproject\.toml|requirements.*\.txt|setup\.py|Pipfile)$/, probes: ["pip3", "uv", "pytest"] },
  { marker: /^Gemfile$/, probes: ["ruby", "bundle"] },
  { marker: /^(Makefile|makefile|GNUmakefile)$/, probes: ["make"] },
  { marker: /^(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/, probes: ["docker"] },
  { marker: /^deno\.jsonc?$/, probes: ["deno"] },
  { marker: /^(pom\.xml|build\.gradle(\.kts)?)$/, probes: ["java", "mvn", "gradle"] },
];

/** Lockfile to manager. Ordered: the first match in this list wins when a repo carries more than one. */
const LOCKFILES: Array<{ file: string; manager: string }> = [
  { file: "bun.lock", manager: "bun" },
  { file: "bun.lockb", manager: "bun" },
  { file: "pnpm-lock.yaml", manager: "pnpm" },
  { file: "yarn.lock", manager: "yarn" },
  { file: "package-lock.json", manager: "npm" },
  { file: "uv.lock", manager: "uv" },
  { file: "poetry.lock", manager: "poetry" },
  { file: "Cargo.lock", manager: "cargo" },
];

/** Nothing else is ever spawned: a probe name that is not a bare program name is a bug, not input. */
const PROGRAM_NAME = /^[a-z0-9][a-z0-9_.+-]*$/;

/** Ceiling for one `--version` call. A program that cannot answer this fast is not usable for a build step either. */
const PROBE_TIMEOUT_MS = 5_000;

/** First version-looking token of the first output line: `git version 2.43.0` -> `2.43.0`. */
function parseVersion(output: string): string | null {
  const firstLine = output.split("\n").map((line) => line.trim()).find(Boolean);
  if (!firstLine) return null;
  return firstLine.match(/\d+(\.\d+)+(-[\w.]+)?/)?.[0] ?? firstLine.slice(0, 40);
}

function hostDescription(platform: NodeJS.Platform): string {
  const release = os.release();
  const wsl = /microsoft/i.test(release) ? " (WSL)" : "";
  return `${os.type()} ${release.split("-")[0]}${wsl} ${os.arch()} on ${platform}`;
}

/**
 * Runs the probes and returns what is really there.
 *
 * Failures are answers, not errors: a probe that exits non-zero, times out, or cannot be spawned
 * at all means "not available", which is precisely the fact the agent needed. The whole report
 * degrades to "backend and shell only" if the workspace refuses to run anything, because a session
 * that cannot describe its environment must still start.
 */
export async function probeEnvironment(workspace: NovaWorkspace): Promise<EnvironmentReport> {
  const report: EnvironmentReport = {
    backend: workspace.kind,
    platform: workspace.commandPlatform,
    host: workspace.kind === "local" ? hostDescription(workspace.commandPlatform) : null,
    execution: workspace.commandGuidance,
    packageManager: null,
    available: [],
    missing: [],
  };

  const entries = await workspace.list("", 1).catch(() => [] as string[]);
  const rootFiles = entries.filter((entry) => !entry.endsWith("/") && !entry.includes("/"));

  const lockfile = LOCKFILES.find((candidate) => rootFiles.includes(candidate.file));
  if (lockfile) report.packageManager = { name: lockfile.manager, lockfile: lockfile.file };

  const probes = new Set(BASE_PROBES);
  for (const { marker, probes: extra } of MARKER_PROBES) {
    if (rootFiles.some((file) => marker.test(file))) for (const program of extra) probes.add(program);
  }
  if (report.packageManager) probes.add(report.packageManager.name);

  const results = await Promise.all(
    [...probes].filter((program) => PROGRAM_NAME.test(program)).map(async (program) => {
      try {
        const result = await workspace.runCommand(`${program} --version`, PROBE_TIMEOUT_MS);
        if (result.exitCode !== 0) return { name: program, version: null, present: false };
        return { name: program, version: parseVersion(`${result.stdout}\n${result.stderr}`), present: true };
      } catch {
        // A backend that refuses the call (allowlist, disposed sandbox) has told us the same thing
        // a non-zero exit would: the agent cannot rely on this program here.
        return { name: program, version: null, present: false };
      }
    }),
  );

  for (const result of results.sort((a, b) => a.name.localeCompare(b.name))) {
    if (result.present) report.available.push({ name: result.name, version: result.version });
    else report.missing.push(result.name);
  }
  return report;
}

/** The prompt section. Kept short: this is a reference table, not an essay. */
export function describeEnvironment(report: EnvironmentReport): string {
  const lines = [
    "Environment (measured in this workspace at session start — trust it over any assumption about what is installed):",
    `- Commands run: ${report.backend}${report.host ? `, ${report.host}` : ""}. ${report.execution}`,
  ];
  if (report.packageManager) {
    lines.push(
      `- Package manager: ${report.packageManager.name} (${report.packageManager.lockfile} is committed). Use it for installs and for running package scripts; another manager would rewrite the lockfile.`,
    );
  }
  if (report.available.length > 0) {
    lines.push(`- Available: ${report.available.map((tool) => (tool.version ? `${tool.name} ${tool.version}` : tool.name)).join(", ")}.`);
  }
  if (report.missing.length > 0) {
    lines.push(`- NOT available (calling these fails): ${report.missing.join(", ")}.`);
  }
  lines.push(
    "- Use what is listed. Before running a program that appears on neither list, check it in the same turn as your other calls (`command -v <program>`, or `where` on Windows) rather than learning it from a failed run_command.",
  );
  return lines.join("\n");
}
