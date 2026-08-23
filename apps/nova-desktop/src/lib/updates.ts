import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/**
 * Checking for a new Nova, and becoming it.
 *
 * The app already noticed updates, but only ever on its own terms: one silent check at startup,
 * and a banner if something turned up. Someone who had heard a version was out had no way to ask,
 * and someone who dismissed the window learned nothing until the next launch. So the check is a
 * button now, and a button has to answer even when the answer is "nothing" — an action that
 * appears to do nothing when it succeeds is one people press repeatedly and then distrust.
 *
 * The second half matters more. `downloadAndInstall` stages a new version; on macOS and Linux it
 * does not become the running one. The old flow stopped there under a button labelled "Restart &
 * install", so the app went on running the version it had just replaced — indistinguishable, from
 * the outside, from an update that silently failed. Relaunching is what makes the promise true.
 * Windows is the exception and is handled below.
 */

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  /** Checked, and this is already the newest version. Carries the version so it can be shown. */
  | { kind: "current"; version: string; checkedAt: number }
  | { kind: "available"; update: Update }
  /** `percent` is undefined when the server sent no content length — a real and common case. */
  | { kind: "downloading"; version: string; percent?: number }
  | { kind: "installing"; version: string }
  /** Staged and about to relaunch. On Windows the installer takes over and the app just exits. */
  | { kind: "restarting"; version: string }
  | { kind: "failed"; message: string; while: "checking" | "installing" };

export type UpdaterPorts = {
  check(): Promise<Update | null>;
  /** Resolves once the new version is staged on disk. */
  install(update: Update, onProgress: (event: DownloadProgress) => void): Promise<void>;
  relaunch(): Promise<void>;
  now(): number;
};

/** The subset of the plugin's download events this cares about. */
export type DownloadProgress =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export const tauriUpdater: UpdaterPorts = {
  check: () => check(),
  install: (update, onProgress) => update.downloadAndInstall((event) => onProgress(event as DownloadProgress)),
  relaunch: () => relaunch(),
  now: () => Date.now(),
};

function describe(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  // The plugin's own wording for "there is no update server configured" is a bare network error,
  // which reads as a fault in the user's connection rather than in the build they are running.
  if (/could not fetch a valid release|404|not found/i.test(raw)) {
    return "No release feed was reachable. This build may not be set up for updates.";
  }
  if (/signature|pubkey|verif/i.test(raw)) {
    return "The update failed its signature check and was not installed.";
  }
  return raw;
}

/**
 * Asks whether a newer version exists.
 *
 * Never throws: a check is something a person pressed, so its failure belongs on screen next to
 * the button rather than in a console nobody has open.
 */
export async function checkForUpdate(ports: UpdaterPorts, currentVersion: string): Promise<UpdateStatus> {
  try {
    const update = await ports.check();
    return update ? { kind: "available", update } : { kind: "current", version: currentVersion, checkedAt: ports.now() };
  } catch (error) {
    return { kind: "failed", message: describe(error), while: "checking" };
  }
}

/**
 * Downloads, installs, and becomes the new version.
 *
 * `onStatus` is called as it goes rather than only at the end, because this is the one action in
 * the app that can take minutes on a slow connection, and a button that says "Installing…" for
 * four minutes with no other sign of life is one people force-quit halfway through — which, for an
 * installer, is the one moment it must not be interrupted.
 */
export async function installUpdate(
  ports: UpdaterPorts,
  update: Update,
  onStatus: (status: UpdateStatus) => void,
): Promise<UpdateStatus> {
  const version = update.version;
  let contentLength: number | undefined;
  let downloaded = 0;
  onStatus({ kind: "downloading", version });

  try {
    await ports.install(update, (event) => {
      if (event.event === "Started") {
        contentLength = event.data.contentLength;
        onStatus({ kind: "downloading", version });
        return;
      }
      if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        // Only claimed when the server said how big the download is. A percentage invented from a
        // guess crawls to 99% and stays there, which is worse than an honest indeterminate bar.
        onStatus(contentLength
          ? { kind: "downloading", version, percent: Math.min(100, Math.round((downloaded / contentLength) * 100)) }
          : { kind: "downloading", version });
        return;
      }
      onStatus({ kind: "installing", version });
    });
  } catch (error) {
    const failed: UpdateStatus = { kind: "failed", message: describe(error), while: "installing" };
    onStatus(failed);
    return failed;
  }

  const restarting: UpdateStatus = { kind: "restarting", version };
  onStatus(restarting);
  try {
    await ports.relaunch();
  } catch (error) {
    // On Windows the installer exits the app itself, so a relaunch call can legitimately fail or
    // never return. Reaching here with the new version already staged is not a failed update, and
    // reporting one would tell the user to retry something that has already happened.
    if (!isExpectedRelaunchFailure(error)) {
      const failed: UpdateStatus = { kind: "failed", message: describe(error), while: "installing" };
      onStatus(failed);
      return failed;
    }
  }
  return restarting;
}

/** A relaunch that could not run because the process is already on its way out. */
function isExpectedRelaunchFailure(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  return /window was closed|not allowed|already exiting|no such window/i.test(raw);
}

/** One line for the button and the banner, so both surfaces say the same thing. */
export function describeStatus(status: UpdateStatus): string {
  switch (status.kind) {
    case "idle": return "Check for updates";
    case "checking": return "Checking…";
    case "current": return `Nova ${status.version} is the latest version`;
    case "available": return `Nova ${status.update.version} is available`;
    case "downloading": return status.percent === undefined ? "Downloading…" : `Downloading… ${status.percent}%`;
    case "installing": return "Installing…";
    case "restarting": return "Restarting into the new version…";
    case "failed": return status.while === "checking" ? `Could not check: ${status.message}` : `Update failed: ${status.message}`;
  }
}

/**
 * How often the app looks for a new version on its own.
 *
 * Eight hours rather than daily. A window that stays open for a working week would otherwise check
 * five times, and a fix shipped on Monday morning would not reach someone until Tuesday; eight
 * hours means a release is picked up within a working day without the feed being polled at any
 * rate a person would notice.
 */
export const UPDATE_CHECK_INTERVAL_MS = 8 * 60 * 60_000;

/**
 * How often that interval is *examined* — which is not the same thing.
 *
 * A single eight-hour timer is the obvious implementation and the wrong one: a laptop that sleeps
 * suspends the timer, so a machine closed each night fires it hours late or not at all, and the
 * app that most needs the update is the one that checks least. Waking often and comparing real
 * clock time means a suspended machine performs its overdue check shortly after it wakes.
 */
export const UPDATE_POLL_INTERVAL_MS = 15 * 60_000;

/**
 * Whether it is time to look again.
 *
 * Refuses while anything is in flight, and refuses once an update is already found: the banner is
 * on screen and re-checking cannot improve on it, but it can replace a `available` state that the
 * user is halfway through acting on. `lastCheckedAt` of `undefined` means "never checked", which
 * is due immediately — that is the launch check.
 */
export function shouldCheckForUpdate(input: {
  lastCheckedAt?: number;
  now: number;
  status: UpdateStatus;
  intervalMs?: number;
}): boolean {
  if (isBusy(input.status) || input.status.kind === "available") return false;
  if (input.lastCheckedAt === undefined) return true;
  return input.now - input.lastCheckedAt >= (input.intervalMs ?? UPDATE_CHECK_INTERVAL_MS);
}

/** Whether the app is mid-update, so the button stays disabled and nothing else starts one. */
export function isBusy(status: UpdateStatus): boolean {
  return status.kind === "checking" || status.kind === "downloading" || status.kind === "installing" || status.kind === "restarting";
}
