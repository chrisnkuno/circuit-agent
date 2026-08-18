import { useCallback, useEffect, useRef, useState } from "react";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import {
  ensureSidecar,
  loadPersistedSettings,
  onSidecarEvent,
  onSidecarExit,
  savePersistedSettings,
  setSettings as pushSettings,
} from "./lib/ipc";
import { defaultSettings, type IpcEvent, type NovaSettings } from "./lib/settings";
import { ChatScreen } from "./screens/Chat";
import { SettingsScreen } from "./screens/Settings";

function UpdateBanner({
  update,
  busy,
  error,
  onInstall,
}: {
  update: Update | null;
  busy: boolean;
  error: string | null;
  onInstall: () => void;
}) {
  if (!update) return null;
  return (
    <div className="update-banner">
      <span className="update-banner-text">
        Nova {update.version} is available
        {error ? <span className="update-banner-error"> — {error}</span> : null}
      </span>
      <button
        className="btn primary"
        type="button"
        disabled={busy}
        onClick={onInstall}
      >
        {busy ? "Installing…" : "Restart & install"}
      </button>
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
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const takeEvents = useCallback(() => eventQueue.current.splice(0), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const next = await checkForUpdate();
        if (!cancelled && next) setUpdate(next);
      } catch {
        // No update server reachable (offline / dev) — ignore silently.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleInstallUpdate() {
    if (!update || updateBusy) return;
    setUpdateBusy(true);
    setUpdateError(null);
    try {
      await update.downloadAndInstall();
      setUpdate(null);
    } catch (error) {
      setUpdateError(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdateBusy(false);
    }
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
    await savePersistedSettings(next);
    if (!sidecarReady) {
      await ensureSidecar();
      setSidecarReady(true);
    }
    await pushSettings(next);
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
        <UpdateBanner update={update} busy={updateBusy} error={updateError} onInstall={handleInstallUpdate} />
        <SettingsScreen initial={settings} onSave={handleSave} notice={bootError} />
      </>
    );
  }

  if (bootError && !sidecarReady) {
    return (
      <div className="settings-hero">
        <UpdateBanner update={update} busy={updateBusy} error={updateError} onInstall={handleInstallUpdate} />
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
      <UpdateBanner update={update} busy={updateBusy} error={updateError} onInstall={handleInstallUpdate} />
      <ChatScreen
        settings={settings}
        onOpenSettings={() => setShowSettings(true)}
        eventTick={eventTick}
        takeEvents={takeEvents}
      />
    </div>
  );
}
