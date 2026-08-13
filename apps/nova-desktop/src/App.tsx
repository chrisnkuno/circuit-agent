import { useCallback, useEffect, useState } from "react";
import { check as checkForUpdate, type Update } from "@tauri-apps/plugin-updater";
import {
  ensureSidecar,
  loadPersistedSettings,
  onSidecarEvent,
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

export default function App() {
  const [ready, setReady] = useState(false);
  const [sidecarReady, setSidecarReady] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [settings, setSettings] = useState<NovaSettings>(defaultSettings());
  const [bootError, setBootError] = useState<string | null>(null);
  const [events, setEvents] = useState<IpcEvent[]>([]);
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  const clearEvents = useCallback(() => setEvents([]), []);

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
          setEvents((prev) => [...prev, event]);
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
    return (
      <>
        <UpdateBanner update={update} busy={updateBusy} error={updateError} onInstall={handleInstallUpdate} />
        {bootError ? (
          <div className="settings-hero" style={{ paddingBottom: 0 }}>
            <div className="settings-card">
              <p className="error-banner">{bootError}</p>
              <p className="lede">You can still enter settings — Save will retry the agent runtime.</p>
            </div>
          </div>
        ) : null}
        <SettingsScreen initial={settings} onSave={handleSave} />
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
        events={events}
        clearEvents={clearEvents}
      />
    </div>
  );
}
