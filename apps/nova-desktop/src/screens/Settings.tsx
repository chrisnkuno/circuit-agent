import { useMemo, useState } from "react";
import { verifyCredentials } from "../lib/ipc";
import { buildModelOptions } from "../lib/models";
import { defaultBaseUrl, defaultSettings, DEFAULT_MODELS, type NovaSettings, type ProviderId } from "../lib/settings";

/**
 * First run, and everything after it.
 *
 * This was seven fields of equal weight, of which exactly one is required. Someone installing Nova
 * to use Claude had to read past a relay secret and an E2B key to find out that pasting an API key
 * is the whole task. The optional settings are still all here — behind a disclosure, because the
 * answer to "which of these do I need?" should be visible without reading any of them.
 *
 * The other change is that you can now find out whether the key works *here*, instead of saving,
 * opening a project, sending a message and reading the failure.
 */

type Verification =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; message: string }
  | { state: "failed"; message: string; hint?: string };

export function SettingsScreen(props: {
  initial: NovaSettings;
  onSave: (settings: NovaSettings) => Promise<void>;
  /** A boot failure to explain in place, above the fields that can fix it. */
  notice?: string | null;
}) {
  const [settings, setSettings] = useState(props.initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [verification, setVerification] = useState<Verification>({ state: "idle" });

  const missingKey = settings.apiKey.trim().length === 0;
  const canSave = !missingKey && settings.model.trim().length > 0;
  const models = useMemo(
    () => buildModelOptions(settings.provider).filter((option) => option.provider === settings.provider),
    [settings.provider],
  );

  function edit(patch: Partial<NovaSettings>) {
    setSettings((prev) => ({ ...prev, ...patch }));
    // Any edit invalidates a previous check — a green tick beside changed values is a lie.
    setVerification({ state: "idle" });
  }

  function setProvider(provider: ProviderId) {
    edit({ provider, baseUrl: defaultBaseUrl(provider), model: DEFAULT_MODELS[provider] });
  }

  async function check() {
    setVerification({ state: "checking" });
    try {
      const result = await verifyCredentials(settings);
      setVerification(result.ok
        ? { state: "ok", message: result.note ?? `Connected. This key can reach ${result.models ?? 0} models.` }
        : { state: "failed", message: result.reason ?? "The check failed.", ...(result.hint ? { hint: result.hint } : {}) });
    } catch (err) {
      // The sidecar being down is itself useful to know here, and is not the same as a bad key.
      setVerification({ state: "failed", message: "Could not run the check.", hint: err instanceof Error ? err.message : String(err) });
    }
  }

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

  return (
    <div className="settings-hero">
      <div className="settings-card">
        <div className="brand">
          <strong style={{ fontSize: "0.85rem", letterSpacing: "0.14em", color: "var(--accent)" }}>CIRCUIT NOTION</strong>
        </div>
        <h1>Nova</h1>
        <p className="lede">A coding agent for your desktop. Paste an API key to start — everything else has a sensible default.</p>

        {props.notice ? (
          <div className="notice warn" role="status">
            <strong>The agent runtime did not start.</strong>
            <span>{props.notice}</span>
            <span className="notice-hint">Your settings still save, and Save will start it again.</span>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="provider">Provider</label>
          <select id="provider" value={settings.provider} onChange={(event) => setProvider(event.target.value as ProviderId)}>
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
            autoFocus
            value={settings.apiKey}
            placeholder="Paste your API key"
            onChange={(event) => edit({ apiKey: event.target.value })}
          />
        </div>

        <div className="field">
          <label htmlFor="model">Model</label>
          {/* A list, not a text box: knowing that the default is `gpt-5.6-luna` was previously a
              prerequisite for changing it. `list` keeps it typeable for models not in the catalog. */}
          <input
            id="model"
            list="model-options"
            value={settings.model}
            onChange={(event) => edit({ model: event.target.value })}
          />
          <datalist id="model-options">
            {models.map((option) => (
              <option key={option.model} value={option.model}>{option.price ?? "unpriced"}</option>
            ))}
          </datalist>
        </div>

        <div className="verify-row">
          <button className="btn" type="button" onClick={check} disabled={missingKey || verification.state === "checking"}>
            {verification.state === "checking" ? "Checking…" : "Test this key"}
          </button>
          {verification.state === "ok" ? <span className="verify ok">✓ {verification.message}</span> : null}
          {verification.state === "failed" ? (
            <span className="verify failed">
              ✕ {verification.message}
              {verification.hint ? <em>{verification.hint}</em> : null}
            </span>
          ) : null}
        </div>

        <details className="advanced" open={advanced} onToggle={(event) => setAdvanced((event.target as HTMLDetailsElement).open)}>
          <summary>Everything else — base URL, budget, sandbox, relay</summary>

          <div className="field">
            <label htmlFor="baseUrl">API base URL</label>
            <input
              id="baseUrl"
              value={settings.baseUrl}
              placeholder={defaultBaseUrl(settings.provider) || "Provider default"}
              onChange={(event) => edit({ baseUrl: event.target.value })}
            />
          </div>

          <div className="field-row">
            <div className="field">
              <label htmlFor="budget">Budget ({settings.currency || "RWF"})</label>
              <input
                id="budget"
                type="number"
                min={0}
                value={settings.budget ?? ""}
                placeholder="Optional cap per session"
                onChange={(event) => edit({ budget: event.target.value === "" ? undefined : Number(event.target.value) })}
              />
            </div>
            <div className="field">
              <label htmlFor="currency">Display currency</label>
              <input
                id="currency"
                value={settings.currency ?? ""}
                placeholder="RWF"
                onChange={(event) => edit({ currency: event.target.value.toUpperCase() })}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="e2b">E2B API key</label>
            <input
              id="e2b"
              type="password"
              autoComplete="off"
              value={settings.e2bApiKey ?? ""}
              placeholder="Only needed to run work in a remote sandbox"
              onChange={(event) => edit({ e2bApiKey: event.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="relay">Relay secret</label>
            <input
              id="relay"
              type="password"
              autoComplete="off"
              value={settings.relaySecret ?? ""}
              placeholder="Only if you route CircuitNotion through a relay"
              onChange={(event) => edit({ relaySecret: event.target.value })}
            />
          </div>
        </details>

        {error ? <div className="notice danger" role="alert"><span>{error}</span></div> : null}

        <button className="btn primary" type="button" disabled={!canSave || saving} onClick={save}>
          {saving ? "Saving…" : "Save and continue"}
        </button>
        {/* A disabled button that does not say why is a dead end. */}
        {missingKey ? <p className="save-hint">Paste an API key above to continue.</p> : null}

        <button
          className="btn ghost"
          type="button"
          onClick={() => { setSettings({ ...defaultSettings(), apiKey: settings.apiKey }); setVerification({ state: "idle" }); }}
        >
          Reset defaults
        </button>
      </div>
    </div>
  );
}
