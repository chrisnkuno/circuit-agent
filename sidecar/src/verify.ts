import type { NovaSettings } from "./protocol.js";
import { defaultBaseUrl } from "./settings.js";

/**
 * Checking a key before the user commits to it.
 *
 * Previously the only way to find out whether a key worked was to save it, open a project, send a
 * message and read the failure. That is a slow, expensive way to learn you pasted the key with a
 * trailing space — and it fails at the worst moment, once someone believes they are set up.
 *
 * The check is a `GET` of the provider's model list. It is the cheapest authenticated call each
 * provider offers: no tokens are generated, so nothing is billed, and it exercises exactly the
 * three things that go wrong — the key, the base URL, and reachability.
 */

export type VerifyResult =
  | { ok: true; models: number; note?: string }
  | { ok: false; reason: string; hint?: string };

/** Distinguishes the failures a user can act on from the ones they cannot. */
function explain(status: number, provider: string): { reason: string; hint?: string } {
  if (status === 401 || status === 403) {
    return { reason: "The provider rejected this key.", hint: "Check for a copied space, or that the key belongs to this provider." };
  }
  if (status === 404) {
    return { reason: "That base URL has no model list.", hint: "It usually ends in /v1 — check the address." };
  }
  if (status === 429) {
    return { reason: "The key is valid but rate-limited right now.", hint: "It will work; the provider is asking you to slow down." };
  }
  if (status >= 500) {
    return { reason: `${provider} returned a server error (${status}).`, hint: "Nothing is wrong with your settings — try again shortly." };
  }
  return { reason: `Unexpected response from ${provider} (${status}).` };
}

/**
 * Verifies credentials without spending anything.
 *
 * Never throws: a settings screen asking "is this right?" must answer, and an exception here would
 * surface as a crash on a form the user is still filling in.
 */
export async function verifyCredentials(settings: NovaSettings, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const key = settings.apiKey.trim();
  if (!key) return { ok: false, reason: "No API key to check yet." };

  const base = (settings.baseUrl.trim() || defaultBaseUrl(settings.provider) || "https://api.anthropic.com").replace(/\/+$/, "");
  const anthropic = settings.provider === "anthropic";
  const url = anthropic ? `${base}/v1/models`.replace("/v1/v1/", "/v1/") : `${base}/models`;

  const headers: Record<string, string> = anthropic
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` };
  if (settings.provider === "circuitnotion" && settings.relaySecret?.trim()) {
    headers["x-relay-secret"] = settings.relaySecret.trim();
  }

  try {
    // Bounded, because a settings form that hangs is worse than one that says it could not tell.
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return { ok: false, ...explain(response.status, settings.provider) };

    const payload = await response.json().catch(() => null) as { data?: unknown[] } | null;
    const models = Array.isArray(payload?.data) ? payload.data.length : 0;
    const names = Array.isArray(payload?.data)
      ? payload.data.map((entry) => (entry as { id?: string }).id).filter((id): id is string => typeof id === "string")
      : [];

    // A key that works but cannot reach the configured model is still a broken setup, and saying
    // so here costs nothing while finding out later costs a failed turn.
    if (names.length > 0 && settings.model.trim() && !names.includes(settings.model.trim())) {
      return { ok: true, models, note: `Connected, but "${settings.model.trim()}" is not in this provider's list.` };
    }
    return { ok: true, models };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) return { ok: false, reason: "The provider did not answer in time.", hint: "Check the base URL and your connection." };
    return { ok: false, reason: "Could not reach the provider.", hint: message };
  }
}
