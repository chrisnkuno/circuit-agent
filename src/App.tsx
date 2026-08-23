import { useCallback, useEffect, useRef, useState } from "react";
import { checkForUpdate, installUpdate, describeStatus, isBusy, shouldCheckForUpdate, tauriUpdater, UPDATE_POLL_INTERVAL_MS, type UpdateStatus } from "./lib/updates";
import {
  ensureSidecar,
  loadPersistedSettings,
  onSidecarEvent,
  onSidecarExit,
  savePersistedSettings,
  setSettings as pushSettings,
} from "./lib/ipc";
import { withProvider, defaultSettings, type IpcEvent, type NovaSettings } from "./lib/settings";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";

/**
 * The one thing worth interrupting someone for: a version that is ready to install.
 *
 * Shown only while there is something to act on or something going wrong. "You are up to date"
 * belongs in Settings beside the button that asked the question, not across the top of a
 * conversation nobody wanted interrupted.
 */
function UpdateBanner({ status, onInstall }: { status: UpdateStatus; onInstall: () => void }) {
  const showing = status.kind === "available" || isBusy(status) || (status.kind === "failed" && status.while === "installing");
  if (!showing) return null;
  return (
    <div className="update-banner">
      <span className="update-banner-text">{describeStatus(status)}</span>
      {status.kind === "available" ? (
        <button className="btn primary" type="button" onClick={onInstall}>
          Update &amp; restart
        </button>
      ) : null}
    </div>
  );
}

/** Kept in step with the same sentence the Rust side sends to any request left in flight. */
const SIDECAR_STOPPED = "Nova's engine stopped unexpectedly. Your session is saved — send another message to restart it.";

export default function App() {
  const [ready, setReady] = useState(false);
  const [sidecarReady, setSidecarReady] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [settings, setSettings] = useState<NovaSettings>(defaultSettings());
  const [bootError, setBootError] = useState<string | null>(null);
  /**
   * Sidecar events waiting to be folded into the transcript.
   *
   * A ref holding a mutable queue, plus a counter to wake the consumer — deliberately not a state
   * array that the consumer clears. That earlier shape had two defects, and both of them showed up
   * as garbled output rather than as an error:
   *
   * - **Duplicated tokens.** React StrictMode double-invokes effects on mount, so the drain effect
   *   ran twice against the same captured array and appended every delta twice ("HelloHello").
   * - **Dropped tokens.** The drain cleared the whole buffer unconditionally, so any event that
   *   arrived between the effect reading the array and the clear landing was silently discarded.
   *
   * `splice(0)` fixes both at once: it is an atomic take, so a second invocation finds an empty
   * queue and does nothing, and it only ever removes what it actually returned.
   */
  const eventQueue = useRef<IpcEvent[]>([]);
  const [eventTick, setEventTick] = useState(0);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ kind: "idle" });
  /** Mirrors `updateStatus` for the polling timer, which is mounted once and must not be re-armed. */
  const updateStatusRef = useRef<UpdateStatus>(updateStatus);
  updateStatusRef.current = updateStatus;

  const takeEvents = useCallback(() => eventQueue.current.splice(0), []);

  /**
   * The check that happens without being asked: at startup, and every eight hours after.
   *
   * Silent about its result: a banner is worth an interruption only when there is something to
   * act on. The "you are up to date" half of the answer lives in Settings, next to the button
   * that asks the question on purpose.
   *
   * A window left open for days used to check exactly once, at launch, so the people running Nova
   * the hardest were the last to receive a fix. It polls on a short timer and compares real clock
   * time rather than sleeping for eight hours in one call, because a suspended laptop suspends the
   * timer with it — see `shouldCheckForUpdate`.
   */
  const lastUpdateCheck = useRef<number | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;

    const maybeCheck = async () => {
      // Read through the ref: this closure outlives several renders, and `updateStatus` captured
      // at mount would still say "idle" long after a banner went up, re-checking over the top of it.
      if (!shouldCheckForUpdate({ lastCheckedAt: lastUpdateCheck.current, now: Date.now(), status: updateStatusRef.current })) return;
      lastUpdateCheck.current = Date.now();
      const status = await checkForUpdate(tauriUpdater, __APP_VERSION__);
      // A failed automatic check is not shown. Nobody asked, there is nothing to do about it, and
      // a scary banner on every offline launch teaches people to ignore the one that matters.
      if (!cancelled && status.kind === "available") setUpdateStatus(status);
    };

    void maybeCheck();
    const timer = setInterval(() => void maybeCheck(), UPDATE_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  /** The deliberate check, from the button in Settings — this one reports whatever it finds. */
  async function handleCheckForUpdate() {
    if (isBusy(updateStatus)) return;
    setUpdateStatus({ kind: "checking" });
    setUpdateStatus(await checkForUpdate(tauriUpdater, __APP_VERSION__));
  }

  async function handleInstallUpdate() {
    if (updateStatus.kind !== "available" || isBusy(updateStatus)) return;
    // `installUpdate` reports its own progress and ends by relaunching, so there is no success
    // branch to write here: on every platform but Windows the process this code is running in has
    // been replaced by the time it would run.
    await installUpdate(tauriUpdater, updateStatus.update, setUpdateStatus);
  }

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      // Show the settings form immediately so API-key input is never blocked on sidecar boot.
      try {
        const stored = await loadPersistedSettings();
        if (!cancelled && stored) {
          setSettings(stored);
          if (stored.apiKey) setShowSettings(false);
        }
      } catch {
        // Empty store is fine on first launch.
      }
      if (!cancelled) setReady(true);

      try {
        await ensureSidecar();
        unlisten = await onSidecarEvent((event) => {
          eventQueue.current.push(event);
          setEventTick((tick) => tick + 1);
        });
        // The engine dying is not a session event — there is no session left to report it to — so
        // it is surfaced the same way a failed boot is: the app stops claiming to be ready and
        // says why, rather than leaving a dead window that looks merely busy.
        unlistenExit = await onSidecarExit(() => {
          setSidecarReady(false);
          setBootError(SIDECAR_STOPPED);
        });
        if (cancelled) return;
        setSidecarReady(true);
        setBootError(null);
        const stored = await loadPersistedSettings();
        if (stored?.apiKey) {
          await pushSettings(stored);
          setShowSettings(false);
        }
      } catch (error) {
        if (!cancelled) {
          setBootError(error instanceof Error ? error.message : String(error));
          setSidecarReady(false);
        }
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
      unlistenExit?.();
    };
  }, []);

  async function handleSave(next: NovaSettings) {
    // Ensure the sidecar is running before validation.
    if (!sidecarReady) {
      await ensureSidecar();
      setSidecarReady(true);
    }
    // Push settings to the sidecar — this validates the API key.
    // If the key is invalid the sidecar throws and we stay on the Settings screen.
    await pushSettings(next);
    // Only persist after validation passes.
    await savePersistedSettings(next);
    setSettings(next);
    setBootError(null);
    setShowSettings(false);
  }

  if (!ready) {
    return (
      <div className="settings-hero">
        <div className="settings-card">
          <h1>Nova</h1>
          <p className="lede">Starting…</p>
        </div>
      </div>
    );
  }

  if (showSettings) {
    // The boot error is passed *into* the form rather than stacked above it. As its own
    // `settings-hero` it claimed a full viewport of its own, which put the form a whole screen
    // below the fold — a message reading "you can still enter settings" with the settings
    // scrolled out of sight is worse than no message.
    return (
      <>
        <UpdateBanner status={updateStatus} onInstall={handleInstallUpdate} />
        <SettingsScreen
          initial={settings}
          onSave={handleSave}
          notice={bootError}
          update={{
            currentVersion: __APP_VERSION__,
            status: updateStatus,
            onCheck: handleCheckForUpdate,
            onInstall: handleInstallUpdate,
          }}
        />
      </>
    );
  }

  if (bootError && !sidecarReady) {
    return (
      <div className="settings-hero">
        <UpdateBanner status={updateStatus} onInstall={handleInstallUpdate} />
        <div className="settings-card">
          <h1>Nova</h1>
          <p className="error-banner">{bootError}</p>
          <button className="btn primary" type="button" onClick={() => setShowSettings(true)}>
            Open settings
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <UpdateBanner status={updateStatus} onInstall={handleInstallUpdate} />
      <ChatScreen
        settings={settings}
        onOpenSettings={() => setShowSettings(true)}
        onDefaultModel={(provider, model) => {
          // Saved to the same store the settings form writes, so the next launch and every new tab
          // open on the model last chosen rather than on whatever was last typed into Settings.
          const next = withProvider(settings, provider, model);
          setSettings(next);
          void savePersistedSettings(next);
        }}
        eventTick={eventTick}
        takeEvents={takeEvents}
      />
    </div>
  );
}
