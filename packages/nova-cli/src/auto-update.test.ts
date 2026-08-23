import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AUTO_UPDATE_INTERVAL_MS,
  decideAutoUpdate,
  readAutoUpdateMode,
  readAutoUpdateState,
  runAutoUpdate,
  writeAutoUpdateState,
  type AutoUpdateContext,
} from "./auto-update";

let configDir: string;

beforeEach(async () => {
  configDir = await fs.mkdtemp(path.join(os.tmpdir(), "nova-autoupdate-"));
});

afterEach(async () => {
  await fs.rm(configDir, { recursive: true, force: true });
});

const base = (overrides: Partial<AutoUpdateContext> = {}): AutoUpdateContext => ({
  mode: "check",
  interactive: true,
  environment: {},
  currentVersion: "1.3.0",
  state: null,
  now: 1_000_000_000_000,
  ...overrides,
});

describe("when Nova looks for a new version", () => {
  it("checks when it has never checked, and not again until a day has passed", () => {
    expect(decideAutoUpdate(base()).action).toBe("check");
    const now = base().now!;
    expect(decideAutoUpdate(base({ state: { lastCheckedAt: now - 1_000 } }))).toEqual({ action: "skip", reason: "not_due" });
    expect(decideAutoUpdate(base({ state: { lastCheckedAt: now - AUTO_UPDATE_INTERVAL_MS - 1 } })).action).toBe("check");
  });

  it("checks again when the stamp is in the future, rather than never checking again", () => {
    // A clock that moved backwards, or a stamp copied from another machine. Trusting it would
    // silently disable updates for as long as the skew lasts.
    expect(decideAutoUpdate(base({ state: { lastCheckedAt: base().now! + AUTO_UPDATE_INTERVAL_MS } })).action).toBe("check");
  });

  it("does nothing at all when it is turned off", () => {
    expect(decideAutoUpdate(base({ mode: "off" }))).toEqual({ action: "skip", reason: "disabled" });
    // Even with an update sitting in front of it.
    expect(decideAutoUpdate(base({ mode: "off", state: { lastCheckedAt: 0, latestVersion: "9.9.9" } })).action).toBe("skip");
  });
});

describe("where an update must never happen", () => {
  it("leaves a piped or headless session alone", () => {
    // Nobody is there to read a notice, and rewriting the binary under a script is the failure.
    expect(decideAutoUpdate(base({ interactive: false, mode: "install", state: { lastCheckedAt: 0, latestVersion: "9.9.9" } })))
      .toEqual({ action: "skip", reason: "not_interactive" });
  });

  it("leaves a build server alone, whichever CI it is", () => {
    for (const marker of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TEAMCITY_VERSION"]) {
      const decision = decideAutoUpdate(base({ mode: "install", environment: { [marker]: "true" }, state: { lastCheckedAt: 0, latestVersion: "9.9.9" } }));
      expect(decision, marker).toEqual({ action: "skip", reason: "ci" });
    }
  });
});

describe("what it does with a version it already knows about", () => {
  const known = (version: string) => ({ lastCheckedAt: base().now!, latestVersion: version });

  it("tells you in check mode and installs in install mode", () => {
    expect(decideAutoUpdate(base({ state: known("1.4.0") }))).toEqual({ action: "notify", version: "1.4.0" });
    expect(decideAutoUpdate(base({ mode: "install", state: known("1.4.0") }))).toEqual({ action: "install", version: "1.4.0" });
  });

  it("never offers a downgrade, which is the normal case while developing Nova itself", () => {
    // A local build ahead of the registry must not be "updated" backwards.
    expect(decideAutoUpdate(base({ currentVersion: "1.4.0", state: known("1.3.0") })).action).toBe("skip");
    expect(decideAutoUpdate(base({ currentVersion: "1.3.0", state: known("1.3.0") })).action).toBe("skip");
  });

  it("compares numerically, not as text", () => {
    // "1.10.0" sorts before "1.9.0" as a string, and that is a real release someone would miss.
    expect(decideAutoUpdate(base({ currentVersion: "1.9.0", state: known("1.10.0") }))).toEqual({ action: "notify", version: "1.10.0" });
    expect(decideAutoUpdate(base({ currentVersion: "1.10.0", state: known("1.9.0") })).action).toBe("skip");
  });

  it("stops offering a version that was declined or failed to install", () => {
    const declined = { lastCheckedAt: base().now!, latestVersion: "1.4.0", skippedVersion: "1.4.0" };
    expect(decideAutoUpdate(base({ mode: "install", state: declined })).action).toBe("skip");
    // A later release is still offered — skipping one version is not opting out.
    expect(decideAutoUpdate(base({ mode: "install", state: { ...declined, latestVersion: "1.5.0" } })))
      .toEqual({ action: "install", version: "1.5.0" });
  });
});

describe("the setting", () => {
  it("defaults interactive sessions to installing without another acceptance prompt", () => {
    expect(readAutoUpdateMode({})).toBe("install");
    expect(readAutoUpdateMode({ NOVA_AUTO_UPDATE: "" })).toBe("install");
  });

  it("keeps malformed explicit settings notification-only", () => {
    expect(readAutoUpdateMode({ NOVA_AUTO_UPDATE: "nonsense" })).toBe("check");
  });

  it("reads the spellings people actually type", () => {
    for (const value of ["off", "false", "0", "no", "OFF"]) expect(readAutoUpdateMode({ NOVA_AUTO_UPDATE: value }), value).toBe("off");
    for (const value of ["check", "notify", "CHECK"]) expect(readAutoUpdateMode({ NOVA_AUTO_UPDATE: value }), value).toBe("check");
    for (const value of ["install", "auto", "on", "true", "1", "yes", "Install"]) expect(readAutoUpdateMode({ NOVA_AUTO_UPDATE: value }), value).toBe("install");
  });
});

describe("the stamp on disk", () => {
  it("round-trips a check", async () => {
    const environment = { NOVA_CONFIG_DIR: configDir };
    await writeAutoUpdateState(environment, { lastCheckedAt: 123, latestVersion: "1.4.0" });
    expect(await readAutoUpdateState(environment)).toEqual({ lastCheckedAt: 123, latestVersion: "1.4.0" });
  });

  it("reads a missing or corrupt stamp as 'never checked' rather than failing", async () => {
    const environment = { NOVA_CONFIG_DIR: configDir };
    expect(await readAutoUpdateState(environment)).toBeNull();
    await fs.writeFile(path.join(configDir, "update-check.json"), "{ this is not json");
    expect(await readAutoUpdateState(environment)).toBeNull();
    await fs.writeFile(path.join(configDir, "update-check.json"), '{"lastCheckedAt":"yesterday"}');
    expect(await readAutoUpdateState(environment)).toBeNull();
  });

  it("survives a config directory it cannot write to", async () => {
    // A read-only or impossible config location must cost tomorrow's check, never today's session.
    // A path whose parent is a regular file fails the way a permission problem does, immediately.
    const blocker = path.join(configDir, "not-a-directory");
    await fs.writeFile(blocker, "");
    await expect(writeAutoUpdateState({ NOVA_CONFIG_DIR: path.join(blocker, "nova") }, { lastCheckedAt: 1 })).resolves.toBeUndefined();
    expect(await readAutoUpdateState({ NOVA_CONFIG_DIR: path.join(blocker, "nova") })).toBeNull();
  });
});

describe("one round of the whole thing", () => {
  const environment = () => ({ NOVA_CONFIG_DIR: configDir });
  const context = (overrides: Partial<AutoUpdateContext> = {}) => ({
    mode: "check" as const,
    interactive: true,
    environment: environment(),
    currentVersion: "1.3.0",
    now: 1_000_000_000_000,
    ...overrides,
  });

  it("checks, records the answer, and reports a newer version", async () => {
    const run = await runAutoUpdate({ context: context(), fetchLatest: async () => "1.4.0" });
    expect(run.decision).toEqual({ action: "notify", version: "1.4.0" });
    expect(run.notice.join(" ")).toContain("1.4.0");
    // The answer is remembered, so tomorrow's launch does not ask again to learn the same thing.
    expect(await readAutoUpdateState(environment())).toMatchObject({ latestVersion: "1.4.0", lastCheckedAt: context().now });
  });

  it("says nothing when the registry cannot be reached, and still records the attempt", async () => {
    // An offline week must cost one attempt a day, not one per launch — and never a visible error.
    const run = await runAutoUpdate({ context: context(), fetchLatest: async () => { throw new Error("ENOTFOUND"); } });
    expect(run.notice).toEqual([]);
    expect(await readAutoUpdateState(environment())).toMatchObject({ lastCheckedAt: context().now });
  });

  it("installs when asked to, and says the running session is still the old build", async () => {
    const installed: string[] = [];
    const run = await runAutoUpdate({
      context: context({ mode: "install" }),
      fetchLatest: async () => "1.4.0",
      install: async (version) => { installed.push(version); return true; },
    });
    expect(installed).toEqual(["1.4.0"]);
    expect(run.notice.join(" ")).toMatch(/restart/i);
  });

  it("installs under the unset default without requesting acceptance", async () => {
    const installed: string[] = [];
    const run = await runAutoUpdate({
      context: context({ mode: readAutoUpdateMode({}) }),
      fetchLatest: async () => "1.4.0",
      install: async (version) => { installed.push(version); return true; },
    });
    expect(run.decision).toEqual({ action: "install", version: "1.4.0" });
    expect(installed).toEqual(["1.4.0"]);
  });

  it("stops retrying a version that failed to install", async () => {
    // Retrying a broken release at every launch is how an update mechanism gets uninstalled.
    const run = await runAutoUpdate({
      context: context({ mode: "install" }),
      fetchLatest: async () => "1.4.0",
      install: async () => false,
    });
    expect(run.notice.join(" ")).toMatch(/could not install/i);
    expect(await readAutoUpdateState(environment())).toMatchObject({ skippedVersion: "1.4.0" });
    // And the next launch does not try again.
    const second = await runAutoUpdate({
      context: context({ mode: "install", now: context().now + 1 }),
      fetchLatest: async () => { throw new Error("must not be asked"); },
      install: async () => { throw new Error("must not install"); },
    });
    expect(second.notice).toEqual([]);
  });

  it("never touches the network when it is turned off", async () => {
    const run = await runAutoUpdate({
      context: context({ mode: "off" }),
      fetchLatest: async () => { throw new Error("must not be asked"); },
    });
    expect(run.decision).toEqual({ action: "skip", reason: "disabled" });
  });
});
