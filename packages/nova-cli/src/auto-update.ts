import { promises as fs } from "node:fs";
import path from "node:path";
import { novaConfigDirectory } from "@circuit-nova/nova-core/nova-cli/memory";

/**
 * Staying current without getting in the way.
 *
 * `nova update` has always existed, which means updating was something you had to remember to do —
 * so the people most likely to be running a months-old build are exactly the ones who never think
 * about it. A daily check fixes that. The hard part is not the check; it is doing it without
 * becoming the thing people disable.
 *
 * Four rules, and each one is a refusal:
 *
 * **It never blocks the prompt.** The check is fired without being awaited and its result is read
 * later. A registry that is slow, unreachable, or behind a captive portal must cost nothing — the
 * one thing worse than an outdated CLI is one that takes four seconds to start because a network
 * it cannot reach is down.
 *
 * **It never interrupts work.** Installing replaces the executable of a running process. That is
 * safe at an idle prompt and reckless in the middle of a turn, so an install only ever happens at
 * a decision point the caller names, never on a timer.
 *
 * **It never runs where nobody can answer.** Piped output, a headless run, or CI means there is no
 * one to see a notice and nothing good can come of rewriting the binary underneath a script. Those
 * sessions check nothing and install nothing.
 *
 * **Installing is opt-in.** The default is to look and to say so. Replacing software on someone's
 * machine without being asked is a decision that belongs to them, and "it was only a patch" is
 * exactly what everyone says before the release that was not.
 */

export type AutoUpdateMode = "off" | "check" | "install";

/** How often to look. Daily: often enough to matter, rare enough that nobody notices the traffic. */
export const AUTO_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1_000;

export type AutoUpdateState = {
  /** Epoch ms of the last completed check, successful or not — a failed check still counts as looking. */
  lastCheckedAt: number;
  /** The newest version the registry reported, if the last check got an answer. */
  latestVersion?: string;
  /** A version the user declined or that failed to install; never offered again automatically. */
  skippedVersion?: string;
};

export type AutoUpdateDecision =
  | { action: "skip"; reason: "disabled" | "not_due" | "not_interactive" | "ci" }
  | { action: "check" }
  | { action: "notify"; version: string }
  | { action: "install"; version: string };

export type AutoUpdateContext = {
  mode: AutoUpdateMode;
  /** False for a pipe, a headless run, or anything else with nobody watching. */
  interactive: boolean;
  environment: Record<string, string | undefined>;
  currentVersion: string;
  state: AutoUpdateState | null;
  now?: number;
};

/** Continuous-integration markers. A build server must never have its tools swapped mid-build. */
function isContinuousIntegration(environment: Record<string, string | undefined>): boolean {
  return ["CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"]
    .some((name) => Boolean(environment[name]?.trim()));
}

export function readAutoUpdateMode(environment: Record<string, string | undefined>): AutoUpdateMode {
  const raw = environment.NOVA_AUTO_UPDATE?.trim().toLowerCase();
  if (raw === "off" || raw === "false" || raw === "0" || raw === "no") return "off";
  if (raw === "install" || raw === "auto" || raw === "on" || raw === "true" || raw === "1" || raw === "yes") return "install";
  // Anything else, including unset: look and say so. See the header for why installing is opt-in.
  return "check";
}

/**
 * What to do right now, given everything known and nothing fetched.
 *
 * Pure on purpose. Every rule above is a branch here, so each one is a test rather than a comment,
 * and the caller is left with I/O it cannot get wrong.
 */
export function decideAutoUpdate(context: AutoUpdateContext): AutoUpdateDecision {
  if (context.mode === "off") return { action: "skip", reason: "disabled" };
  if (!context.interactive) return { action: "skip", reason: "not_interactive" };
  if (isContinuousIntegration(context.environment)) return { action: "skip", reason: "ci" };

  const now = context.now ?? Date.now();
  const state = context.state;
  const due = !state || now - state.lastCheckedAt >= AUTO_UPDATE_INTERVAL_MS || state.lastCheckedAt > now;

  // A known-newer version acts before a due check does: the answer is already in hand, and asking
  // the registry again to learn what was learned yesterday is a request nobody needed.
  if (state?.latestVersion && state.latestVersion !== context.currentVersion && state.skippedVersion !== state.latestVersion) {
    if (isNewer(state.latestVersion, context.currentVersion)) {
      return context.mode === "install" ? { action: "install", version: state.latestVersion } : { action: "notify", version: state.latestVersion };
    }
  }
  return due ? { action: "check" } : { action: "skip", reason: "not_due" };
}

/**
 * Whether `candidate` is a later release than `current`.
 *
 * Deliberately not a full semver comparison — `update.ts` owns that, and duplicating it here would
 * create two answers to one question. This is the cheap guard that keeps a *downgrade* from ever
 * being offered when a local build is ahead of the registry, which is the normal state of affairs
 * while developing Nova itself.
 */
function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string) => value.split("-")[0].split(".").map((part) => Number.parseInt(part, 10));
  const [left, right] = [parse(candidate), parse(current)];
  if (left.some(Number.isNaN) || right.some(Number.isNaN)) return false;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function stateFile(environment: Record<string, string | undefined>): string {
  return path.join(novaConfigDirectory(environment), "update-check.json");
}

/** The last check, or null when there has never been one — or when the file is unreadable, which is the same thing. */
export async function readAutoUpdateState(environment: Record<string, string | undefined>): Promise<AutoUpdateState | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile(environment), "utf8")) as Partial<AutoUpdateState>;
    if (typeof parsed.lastCheckedAt !== "number" || !Number.isFinite(parsed.lastCheckedAt)) return null;
    return {
      lastCheckedAt: parsed.lastCheckedAt,
      ...(typeof parsed.latestVersion === "string" ? { latestVersion: parsed.latestVersion } : {}),
      ...(typeof parsed.skippedVersion === "string" ? { skippedVersion: parsed.skippedVersion } : {}),
    };
  } catch {
    // A missing or corrupt stamp means "check now", which is the safe reading: the cost is one
    // request, and the alternative is a CLI that stops checking forever because a file got truncated.
    return null;
  }
}

/** Records a check. Best-effort: a read-only config directory must not fail anyone's session. */
export async function writeAutoUpdateState(environment: Record<string, string | undefined>, state: AutoUpdateState): Promise<void> {
  try {
    const file = stateFile(environment);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  } catch {
    // Losing the stamp costs one extra check tomorrow. Failing the session costs the session.
  }
}

/** What the user sees when a newer version is found and installing is not enabled. */
export function updateNotice(version: string, currentVersion: string): string[] {
  return [
    `Nova ${version} is available — you are on ${currentVersion}.`,
    "Run /update to install it, or turn on automatic updates with /update auto.",
  ];
}

/** What the user sees after an automatic install. The running process is still the old code. */
export function installedNotice(version: string): string[] {
  return [
    `Updated to Nova ${version}.`,
    "This session keeps running the version it started with; restart when convenient.",
  ];
}

export type AutoUpdateRun = {
  /** Lines to show the user at the next safe moment, if any. */
  notice: string[];
  decision: AutoUpdateDecision;
};

/**
 * Runs one round of the policy: decide, look if due, act if there is something to act on.
 *
 * Written so the caller does nothing but choose *when* to call it and where to print the result —
 * every rule about whether to act at all lives in `decideAutoUpdate`, and everything that touches
 * the network or the package manager is injected, so this is testable without either.
 *
 * The check is bounded at three seconds. A registry that cannot answer in that time has nothing to
 * say that is worth delaying a prompt for, and tomorrow's check costs nothing.
 */
export async function runAutoUpdate(options: {
  context: Omit<AutoUpdateContext, "state">;
  readState?: typeof readAutoUpdateState;
  writeState?: typeof writeAutoUpdateState;
  fetchLatest: (timeoutMs: number) => Promise<string>;
  install?: (version: string) => Promise<boolean>;
}): Promise<AutoUpdateRun> {
  const read = options.readState ?? readAutoUpdateState;
  const write = options.writeState ?? writeAutoUpdateState;
  const { environment, currentVersion } = options.context;
  const state = await read(environment);
  const now = options.context.now ?? Date.now();

  let decision = decideAutoUpdate({ ...options.context, state });
  if (decision.action === "check") {
    let latestVersion: string | undefined;
    try {
      latestVersion = await options.fetchLatest(3_000);
    } catch {
      // An unreachable registry is not an error anyone asked about. The stamp still moves, so a
      // captive portal or an offline week costs one attempt a day rather than one per launch.
    }
    const checked: AutoUpdateState = { ...state, lastCheckedAt: now, ...(latestVersion ? { latestVersion } : {}) };
    await write(environment, checked);
    if (!latestVersion) return { notice: [], decision };
    decision = decideAutoUpdate({ ...options.context, state: checked });
  }

  if (decision.action === "notify") return { notice: updateNotice(decision.version, currentVersion), decision };

  if (decision.action === "install" && options.install) {
    const installed = await options.install(decision.version);
    if (installed) return { notice: installedNotice(decision.version), decision };
    // A failed install is remembered as skipped: retrying the same broken version at every launch
    // is how an update mechanism becomes something people uninstall.
    await write(environment, { ...(state ?? { lastCheckedAt: now }), lastCheckedAt: now, latestVersion: decision.version, skippedVersion: decision.version });
    return { notice: [`Could not install Nova ${decision.version} automatically. Run /update to see why.`], decision };
  }

  return { notice: [], decision };
}
