import { describe, expect, it } from "vitest";
import type { Update } from "@tauri-apps/plugin-updater";
import {
  checkForUpdate,
  describeStatus,
  installUpdate,
  isBusy,
  shouldCheckForUpdate,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_POLL_INTERVAL_MS,
  type DownloadProgress,
  type UpdateStatus,
  type UpdaterPorts,
} from "./updates";

const HOUR = 60 * 60_000;

/**
 * Becoming a new version, which is the half that used to be missing.
 *
 * The app could already download and stage an update. What it could not do was *become* it: the
 * button said "Restart & install" and then did not restart, so on macOS and Linux the old binary
 * kept running with a new one sitting beside it on disk. From the outside that is indistinguishable
 * from an update that failed — and the natural response, pressing it again, repeats the download.
 *
 * So the relaunch is the property most of these tests are really about.
 */

const anUpdate = (version = "1.2.0"): Update => ({ version } as Update);

function ports(overrides: Partial<UpdaterPorts> = {}): UpdaterPorts & { relaunched: () => number } {
  let relaunched = 0;
  const base: UpdaterPorts = {
    check: async () => null,
    install: async () => undefined,
    relaunch: async () => { relaunched += 1; },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { ...base, relaunch: overrides.relaunch ?? base.relaunch, relaunched: () => relaunched };
}

describe("checking for a new version", () => {
  it("reports being up to date, rather than saying nothing at all", async () => {
    // The old flow only ever surfaced a *found* update, so a deliberate check that came back empty
    // looked identical to one that never ran. A button that appears to do nothing when it succeeds
    // is one people press repeatedly and then stop trusting.
    const status = await checkForUpdate(ports(), "1.1.0");
    expect(status).toEqual({ kind: "current", version: "1.1.0", checkedAt: 1_700_000_000_000 });
    expect(describeStatus(status)).toContain("1.1.0");
  });

  it("carries the update through when there is one", async () => {
    const update = anUpdate("2.0.0");
    const status = await checkForUpdate(ports({ check: async () => update }), "1.1.0");
    expect(status).toEqual({ kind: "available", update });
    expect(describeStatus(status)).toBe("Nova 2.0.0 is available");
  });

  it("turns a failure into something the person who pressed the button can read", async () => {
    // A check is a deliberate act, so its failure belongs on screen beside the button — not thrown
    // into a console no desktop user has open.
    const status = await checkForUpdate(ports({ check: async () => { throw new Error("Could not fetch a valid release JSON"); } }), "1.1.0");
    expect(status.kind).toBe("failed");
    expect(status.kind === "failed" && status.while).toBe("checking");
    // Not the raw message: a bare fetch error reads as the user's network being broken rather than
    // this build having no release feed configured.
    expect(describeStatus(status)).toContain("release feed");
  });

  it("names a signature failure as a refusal to install, not a network problem", async () => {
    const status = await checkForUpdate(ports({ check: async () => { throw new Error("signature verification failed"); } }), "1.1.0");
    expect(describeStatus(status)).toContain("signature check");
  });
});

describe("installing and becoming the new version", () => {
  it("relaunches once the new version is staged", async () => {
    // The whole point. `downloadAndInstall` stages; on macOS and Linux it does not replace the
    // running process, so without this the app goes on being the version it just replaced.
    const p = ports({ check: async () => anUpdate() });
    const seen: UpdateStatus[] = [];
    const final = await installUpdate(p, anUpdate("1.2.0"), (status) => seen.push(status));

    expect(p.relaunched()).toBe(1);
    expect(final).toEqual({ kind: "restarting", version: "1.2.0" });
    expect(seen.map((status) => status.kind)).toContain("restarting");
  });

  it("reports real progress while it downloads", async () => {
    const p = ports({
      install: async (_update, onProgress) => {
        const events: DownloadProgress[] = [
          { event: "Started", data: { contentLength: 1_000 } },
          { event: "Progress", data: { chunkLength: 250 } },
          { event: "Progress", data: { chunkLength: 250 } },
          { event: "Finished" },
        ];
        for (const event of events) onProgress(event);
      },
    });
    const seen: UpdateStatus[] = [];
    await installUpdate(p, anUpdate("1.2.0"), (status) => seen.push(status));

    const percents = seen.filter((status) => status.kind === "downloading").map((status) => (status as { percent?: number }).percent);
    expect(percents).toContain(25);
    expect(percents).toContain(50);
    expect(seen.map((status) => status.kind)).toContain("installing");
  });

  it("claims no percentage when the server never said how big the download is", async () => {
    // A percentage computed from a guessed total creeps toward 99% and stops, which reads as a
    // hang. An indeterminate bar is less informative and more honest.
    const p = ports({
      install: async (_update, onProgress) => {
        onProgress({ event: "Started", data: {} });
        onProgress({ event: "Progress", data: { chunkLength: 4_096 } });
      },
    });
    const seen: UpdateStatus[] = [];
    await installUpdate(p, anUpdate(), (status) => seen.push(status));

    const downloading = seen.filter((status) => status.kind === "downloading");
    expect(downloading.length).toBeGreaterThan(0);
    expect(downloading.every((status) => (status as { percent?: number }).percent === undefined)).toBe(true);
    expect(describeStatus(downloading[0])).toBe("Downloading…");
  });

  it("never claims more than 100%, however the chunks add up", async () => {
    const p = ports({
      install: async (_update, onProgress) => {
        onProgress({ event: "Started", data: { contentLength: 100 } });
        onProgress({ event: "Progress", data: { chunkLength: 250 } });
      },
    });
    const seen: UpdateStatus[] = [];
    await installUpdate(p, anUpdate(), (status) => seen.push(status));
    const percents = seen.filter((s) => s.kind === "downloading").map((s) => (s as { percent?: number }).percent);
    expect(Math.max(...percents.filter((value): value is number => value !== undefined))).toBe(100);
  });

  it("does not relaunch into a version that failed to install", async () => {
    // Restarting after a failed download is how a working install gets replaced by a broken one.
    const p = ports({ install: async () => { throw new Error("connection reset"); } });
    const final = await installUpdate(p, anUpdate(), () => undefined);

    expect(p.relaunched()).toBe(0);
    expect(final.kind).toBe("failed");
    expect(final.kind === "failed" && final.while).toBe("installing");
  });

  it("treats a Windows-style exit during relaunch as success, not failure", async () => {
    // On Windows the installer exits the app itself, so the relaunch call can legitimately fail.
    // The update has already been staged at that point; reporting an error would tell the user to
    // retry something that has in fact just succeeded.
    const p = ports({ relaunch: async () => { throw new Error("window was closed"); } });
    const final = await installUpdate(p, anUpdate("3.0.0"), () => undefined);
    expect(final).toEqual({ kind: "restarting", version: "3.0.0" });
  });

  it("still reports a relaunch that failed for a real reason", async () => {
    const p = ports({ relaunch: async () => { throw new Error("permission denied"); } });
    const final = await installUpdate(p, anUpdate(), () => undefined);
    expect(final.kind).toBe("failed");
  });
});

describe("what the button may do next", () => {
  it("treats every in-flight state as busy, so nothing starts a second update", () => {
    // Two concurrent downloads of the same installer is the one way this feature can corrupt what
    // it is installing.
    expect(isBusy({ kind: "checking" })).toBe(true);
    expect(isBusy({ kind: "downloading", version: "1" })).toBe(true);
    expect(isBusy({ kind: "installing", version: "1" })).toBe(true);
    expect(isBusy({ kind: "restarting", version: "1" })).toBe(true);

    expect(isBusy({ kind: "idle" })).toBe(false);
    expect(isBusy({ kind: "available", update: anUpdate() })).toBe(false);
    expect(isBusy({ kind: "current", version: "1", checkedAt: 0 })).toBe(false);
    expect(isBusy({ kind: "failed", message: "x", while: "checking" })).toBe(false);
  });

  it("has a sentence for every state, so no state renders as blank", () => {
    const all: UpdateStatus[] = [
      { kind: "idle" },
      { kind: "checking" },
      { kind: "current", version: "1.0.0", checkedAt: 0 },
      { kind: "available", update: anUpdate() },
      { kind: "downloading", version: "1.0.0" },
      { kind: "downloading", version: "1.0.0", percent: 42 },
      { kind: "installing", version: "1.0.0" },
      { kind: "restarting", version: "1.0.0" },
      { kind: "failed", message: "nope", while: "checking" },
      { kind: "failed", message: "nope", while: "installing" },
    ];
    for (const status of all) expect(describeStatus(status).length).toBeGreaterThan(0);
  });
});

describe("automatic update checks", () => {
  const status = { kind: "idle" } as const;

  it("checks immediately when it has never checked", () => {
    expect(shouldCheckForUpdate({ now: 1_000, status })).toBe(true);
  });

  it("waits the full interval between checks", () => {
    const now = 100 * HOUR;
    expect(shouldCheckForUpdate({ lastCheckedAt: now - UPDATE_CHECK_INTERVAL_MS + 1, now, status })).toBe(false);
    expect(shouldCheckForUpdate({ lastCheckedAt: now - UPDATE_CHECK_INTERVAL_MS, now, status })).toBe(true);
  });

  it("checks on the first poll after a long suspend rather than skipping it", () => {
    // The reason the timer is short and the comparison is against the clock: a laptop asleep for
    // three days must not come back and wait another eight hours.
    const now = 100 * HOUR;
    expect(shouldCheckForUpdate({ lastCheckedAt: now - 72 * HOUR, now, status })).toBe(true);
  });

  it("never re-checks over an update the user is looking at", () => {
    // A banner is on screen and a fresh check cannot improve on it — but it can replace the state
    // someone is halfway through acting on.
    const available = { kind: "available", update: {} as never } as const;
    expect(shouldCheckForUpdate({ lastCheckedAt: 0, now: 999 * HOUR, status: available })).toBe(false);
  });

  it("never starts a check while an install is in flight", () => {
    const downloading = { kind: "downloading", version: "9.9.9" } as const;
    expect(shouldCheckForUpdate({ lastCheckedAt: 0, now: 999 * HOUR, status: downloading })).toBe(false);
  });

  it("polls far more often than it checks, so an overdue check is noticed quickly", () => {
    expect(UPDATE_POLL_INTERVAL_MS).toBeLessThan(UPDATE_CHECK_INTERVAL_MS);
  });
});
