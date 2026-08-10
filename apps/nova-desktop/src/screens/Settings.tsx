import { useMemo, useState } from "react";
import { defaultBaseUrl, defaultSettings, DEFAULT_MODELS, type NovaSettings, type ProviderId } from "../lib/settings";

export function SettingsScreen(props: {
  initial: NovaSettings;
  onSave: (settings: NovaSettings) => Promise<void>;
}) {
  const [settings, setSettings] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = useMemo(() => settings.apiKey.trim().length > 0 && settings.model.trim().length > 0, [settings]);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await props.onSave(settings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function setProvider(provider: ProviderId) {
    setSettings((prev) => ({
      ...prev,
      provider,
      baseUrl: defaultBaseUrl(provider) || prev.baseUrl,
      model: DEFAULT_MODELS[provider],
    }));
  }

  return (
    <div className="settings-hero">
      <div className="settings-card">
        <div className="brand">
          <strong style={{ fontSize: "0.85rem", letterSpacing: "0.14em", color: "var(--accent)" }}>CIRCUIT NOTION</strong>
        </div>
        <h1>Nova</h1>
        <p className="lede">A coding agent for your desktop. Connect a model provider to start — CircuitNotion is the default.</p>

        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select id="provider" value={settings.provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
            <option value="circuitnotion">CircuitNotion</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </div>

        <div className="field">
          <label htmlFor="apiKey">API key</label>
          <input
            id="apiKey"
            type="password"
            autoComplete="off"
            value={settings.apiKey}
            placeholder="Paste your API key"
            onChange={(e) => setSettings((prev) => ({ ...prev, apiKey: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="baseUrl">API base URL</label>
          <input
            id="baseUrl"
            value={settings.baseUrl}
            placeholder={defaultBaseUrl(settings.provider) || "Provider default"}
            onChange={(e) => setSettings((prev) => ({ ...prev, baseUrl: e.target.value }))}
          />
        </div>

        <div className="field-row">
          <div className="field">
            <label htmlFor="model">Model</label>
            <input
              id="model"
              value={settings.model}
              onChange={(e) => setSettings((prev) => ({ ...prev, model: e.target.value }))}
            />
          </div>
          <div className="field">
            <label htmlFor="budget">Budget ({settings.currency || "RWF"})</label>
            <input
              id="budget"
              type="number"
              min={0}
              value={settings.budget ?? ""}
              placeholder="Optional"
              onChange={(e) =>
                setSettings((prev) => ({
                  ...prev,
                  budget: e.target.value === "" ? undefined : Number(e.target.value),
                }))
              }
            />
          </div>
        </div>

        <div className="field">
          <label htmlFor="e2b">E2B API key (sandbox)</label>
          <input
            id="e2b"
            type="password"
            autoComplete="off"
            value={settings.e2bApiKey ?? ""}
            placeholder="Optional — required for sandbox mode"
            onChange={(e) => setSettings((prev) => ({ ...prev, e2bApiKey: e.target.value }))}
          />
        </div>

        <div className="field">
          <label htmlFor="relay">Relay secret</label>
          <input
            id="relay"
            type="password"
            autoComplete="off"
            value={settings.relaySecret ?? ""}
            placeholder="Optional — only if using CircuitNotion relay"
            onChange={(e) => setSettings((prev) => ({ ...prev, relaySecret: e.target.value }))}
          />
        </div>

        {error ? <div className="error-banner">{error}</div> : null}

        <button className="btn primary" type="button" disabled={!canSave || saving} onClick={save}>
          {saving ? "Saving…" : "Save and continue"}
        </button>

        <button
          className="btn ghost"
          type="button"
          onClick={() => setSettings({ ...defaultSettings(), apiKey: settings.apiKey })}
        >
          Reset defaults
        </button>
      </div>
    </div>
  );
}
