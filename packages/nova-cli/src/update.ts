import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline/promises";
import cliPackage from "../package.json";

export const NOVA_CLI_PACKAGE = "@circuit-nova/nova-cli";
export const NOVA_CLI_VERSION = cliPackage.version;
const DEFAULT_REGISTRY = "https://registry.npmjs.org";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

type Semver = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnSyncOptions,
) => { status: number | null; signal?: NodeJS.Signals | null; error?: Error };

export type SelfUpdateStatus = "up_to_date" | "ahead" | "available" | "declined" | "updated" | "failed";

export type SelfUpdateResult = {
  status: SelfUpdateStatus;
  currentVersion: string;
  latestVersion?: string;
  code: number;
};

export type SelfUpdateOptions = {
  checkOnly?: boolean;
  yes?: boolean;
  packageManager?: string;
  environment?: Record<string, string | undefined>;
  currentVersion?: string;
  fetchImpl?: FetchLike;
  spawnImpl?: SpawnLike;
  interactive?: boolean;
  confirm?: (question: string) => Promise<boolean>;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  modulePath?: string;
  execPath?: string;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Parses the strict subset package registries use; invalid versions never reach a command line. */
export function parseSemver(value: string): Semver | null {
  const match = SEMVER.exec(value);
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) return null;
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease };
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index];
    const b = right[index];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    if (a === b) continue;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) return Number(a) < Number(b) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Returns -1, 0, or 1 using SemVer precedence (build metadata is intentionally ignored). */
export function compareVersions(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) throw new Error(`Cannot compare invalid versions: ${left} and ${right}`);
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  return comparePrerelease(a.prerelease, b.prerelease);
}

export function isPackageManager(value: string | undefined): value is PackageManager {
  return value === "npm" || value === "pnpm" || value === "yarn" || value === "bun";
}

/** Detects the installer conservatively, with an explicit override taking precedence. */
export function detectPackageManager(options: {
  override?: string;
  environment?: Record<string, string | undefined>;
  execPath?: string;
  modulePath?: string;
} = {}): PackageManager {
  const environment = options.environment ?? process.env;
  const override = options.override ?? environment.NOVA_UPDATE_PACKAGE_MANAGER;
  if (override) {
    if (!isPackageManager(override)) throw new Error(`Unsupported package manager "${override}". Use npm, pnpm, yarn, or bun.`);
    return override;
  }

  const userAgent = environment.npm_config_user_agent?.split(/[\s/]/, 1)[0];
  if (isPackageManager(userAgent)) return userAgent;

  const clues = [environment.npm_execpath, options.execPath, options.modulePath].filter(Boolean).join("/").toLowerCase();
  if (/(^|[/.\\])pnpm([/.\\]|$)|[/.\\]\.pnpm[/.\\]/.test(clues)) return "pnpm";
  if (/(^|[/.\\])yarn([/.\\]|$)|[/.\\]\.yarn[/.\\]/.test(clues)) return "yarn";
  if (/(^|[/.\\])bun([/.\\]|$)|[/.\\]\.bun[/.\\]/.test(clues)) return "bun";
  return "npm";
}

/** Produces argv, never shell text: a registry response cannot become executable syntax. */
export function updateCommand(manager: PackageManager, version: string): { command: string; args: string[] } {
  if (!parseSemver(version)) throw new Error(`Refusing to install invalid version "${version}".`);
  const target = `${NOVA_CLI_PACKAGE}@${version}`;
  switch (manager) {
    case "npm": return { command: "npm", args: ["install", "--global", target] };
    case "pnpm": return { command: "pnpm", args: ["add", "--global", target] };
    case "yarn": return { command: "yarn", args: ["global", "add", target] };
    case "bun": return { command: "bun", args: ["add", "--global", target] };
  }
}

export async function fetchLatestVersion(options: {
  environment?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<string> {
  const environment = options.environment ?? process.env;
  const registry = new URL(environment.NOVA_UPDATE_REGISTRY?.trim() || DEFAULT_REGISTRY);
  if (registry.protocol !== "https:") throw new Error("NOVA_UPDATE_REGISTRY must use HTTPS.");
  const endpoint = new URL(`${encodeURIComponent(NOVA_CLI_PACKAGE)}/latest`, `${registry.href.replace(/\/$/, "")}/`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Registry returned HTTP ${response.status}.`);
    const body = await response.json() as { name?: unknown; version?: unknown };
    if (body.name !== NOVA_CLI_PACKAGE || typeof body.version !== "string" || !parseSemver(body.version)) {
      throw new Error("Registry returned an invalid Nova package record.");
    }
    return body.version;
  } finally {
    clearTimeout(timer);
  }
}

async function askForConfirmation(question: string): Promise<boolean> {
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`${question} [Y/n] `)).trim().toLowerCase();
    return answer === "" || answer === "y" || answer === "yes";
  } finally {
    readline.close();
  }
}

/** Checks and, when authorized, replaces the global CLI through its package manager. */
export async function runSelfUpdate(options: SelfUpdateOptions = {}): Promise<SelfUpdateResult> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(text));
  const environment = options.environment ?? process.env;
  const currentVersion = options.currentVersion ?? NOVA_CLI_VERSION;
  if (!parseSemver(currentVersion)) {
    stderr(`Nova cannot update itself because its current version "${currentVersion}" is invalid.\n`);
    return { status: "failed", currentVersion, code: 1 };
  }

  let latestVersion: string;
  try {
    latestVersion = await fetchLatestVersion({ environment, fetchImpl: options.fetchImpl });
  } catch (error) {
    stderr(`Could not check for Nova updates: ${error instanceof Error ? error.message : String(error)}\n`);
    return { status: "failed", currentVersion, code: 1 };
  }

  const precedence = compareVersions(currentVersion, latestVersion);
  if (precedence === 0) {
    stdout(`Nova ${currentVersion} is already up to date.\n`);
    return { status: "up_to_date", currentVersion, latestVersion, code: 0 };
  }
  if (precedence > 0) {
    stdout(`Nova ${currentVersion} is newer than the registry release ${latestVersion}.\n`);
    return { status: "ahead", currentVersion, latestVersion, code: 0 };
  }
  if (options.checkOnly) {
    stdout(`Nova ${latestVersion} is available (currently ${currentVersion}). Run \`nova update\` to install it.\n`);
    return { status: "available", currentVersion, latestVersion, code: 0 };
  }

  let manager: PackageManager;
  let command: ReturnType<typeof updateCommand>;
  try {
    manager = detectPackageManager({
      override: options.packageManager,
      environment,
      execPath: options.execPath ?? process.execPath,
      modulePath: options.modulePath ?? import.meta.url,
    });
    command = updateCommand(manager, latestVersion);
  } catch (error) {
    stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return { status: "failed", currentVersion, latestVersion, code: 1 };
  }

  if (!options.yes) {
    const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (!interactive && !options.confirm) {
      stderr(`Nova ${latestVersion} is available, but a non-interactive update needs --yes.\n`);
      stderr(`Would run: ${command.command} ${command.args.join(" ")}\n`);
      return { status: "failed", currentVersion, latestVersion, code: 1 };
    }
    const approved = await (options.confirm ?? askForConfirmation)(`Update Nova ${currentVersion} → ${latestVersion} with ${manager}?`);
    if (!approved) {
      stdout("Update cancelled.\n");
      return { status: "declined", currentVersion, latestVersion, code: 0 };
    }
  }

  stdout(`Updating Nova ${currentVersion} → ${latestVersion} with ${manager}…\n`);
  const spawn = options.spawnImpl ?? ((executable, args, spawnOptions) => spawnSync(executable, args, spawnOptions));
  let result: ReturnType<SpawnLike>;
  try {
    // Running outside the caller's project prevents npm/pnpm workspace settings from changing the
    // meaning of a global install. `shell: false` is a security invariant, not an optimization.
    result = spawn(command.command, command.args, {
      cwd: tmpdir(),
      env: { ...process.env, ...environment } as NodeJS.ProcessEnv,
      stdio: "inherit",
      shell: false,
    });
  } catch (error) {
    stderr(`Nova update failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return { status: "failed", currentVersion, latestVersion, code: 1 };
  }
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.signal ? `terminated by ${result.signal}` : `installer exited ${result.status ?? "without a status"}`);
    stderr(`Nova update failed: ${reason}.\n`);
    stderr(`You can retry manually: ${command.command} ${command.args.join(" ")}\n`);
    return { status: "failed", currentVersion, latestVersion, code: 1 };
  }

  stdout(`Nova ${latestVersion} was installed. Restart Nova to use the new version.\n`);
  return { status: "updated", currentVersion, latestVersion, code: 0 };
}
