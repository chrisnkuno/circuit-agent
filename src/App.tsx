import { useCallback, useEffect, useState } from "react";
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

export default function App() {
  const [ready, setReady] = useState(false);
  const [sidecarReady, setSidecarReady] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [settings, setSettings] = useState<NovaSettings>(defaultSettings());
  const [bootError, setBootError] = useState<string | null>(null);
  const [events, setEvents] = useState<IpcEvent[]>([]);

  const clearEvents = useCallback(() => setEvents([]), []);

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
    <ChatScreen
      settings={settings}
      onOpenSettings={() => setShowSettings(true)}
      events={events}
      clearEvents={clearEvents}
    />
  );
}
