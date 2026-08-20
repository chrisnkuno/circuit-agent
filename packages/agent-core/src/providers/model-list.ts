/**
 * The parts of model listing that touch nothing but data.
 *
 * Split from `model-fetch.ts` because the desktop renderer needs them and that module reads and
 * writes a cache file: importing it into a browser bundle pulls `node:fs` in behind it. The rules
 * here — what a `/v1/models` body means, which ids can hold a conversation, and how a live list
 * folds into a known one — have to be identical in the terminal and in the window, so they live in
 * one place rather than being reimplemented on whichever side cannot reach the other.
 */

import type { ProviderId } from "./provider-specs";

/**
 * Joins a base URL to the models path without doubling the version segment.
 *
 * OpenAI-compatible gateways are conventionally configured with the version *included*
 * (`https://gateway/v1`), because that is what the official SDKs take. Blindly appending
 * `/v1/models` to one produces `/v1/v1/models`, which 404s in a way that looks like the provider
 * being down rather than the URL being wrong.
 */
export function modelsUrl(base: string): string {
  const trimmed = base.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/**
 * Where a provider's list lives.
 *
 * They all speak the same shape — `GET /v1/models` returning `{ data: [{ id }] }` — but they do
 * not agree on how a key is presented, and getting that wrong is a 401 that looks like an outage.
 */
export function modelsEndpoint(provider: ProviderId, environment: Record<string, string | undefined>): { url: string; headers: Record<string, string> } | undefined {
  const trimmed = (value: string | undefined) => value?.trim() || undefined;
  switch (provider) {
    case "anthropic": {
      const key = trimmed(environment.ANTHROPIC_API_KEY);
      if (!key) return undefined;
      const base = trimmed(environment.ANTHROPIC_BASE_URL) ?? "https://api.anthropic.com";
      return {
        url: `${modelsUrl(base)}?limit=1000`,
        // Anthropic authenticates with `x-api-key` and *requires* a version header; omitting the
        // version is a 400 that reads like a malformed request rather than a missing header.
        headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
      };
    }
    case "openai": {
      const key = trimmed(environment.OPENAI_API_KEY);
      if (!key) return undefined;
      const base = trimmed(environment.OPENAI_BASE_URL) ?? "https://api.openai.com";
      return { url: modelsUrl(base), headers: { authorization: `Bearer ${key}` } };
    }
    case "circuitnotion": {
      const key = trimmed(environment.CIRCUITNOTION_API_KEY);
      if (!key) return undefined;
      const base = trimmed(environment.CIRCUITNOTION_BASE_URL) ?? "https://api.circuitnotion.com";
      return { url: modelsUrl(base), headers: { authorization: `Bearer ${key}` } };
    }
    case "ollama": {
      // The one provider with nothing to authenticate. Leaving it out of this switch did not make
      // it un-askable — `PROVIDERS.ollama.requires` is empty, so it is always "configured" and was
      // asked on every refresh, answered `undefined` here, and reported back as "no key
      // configured". A provider that needs no key, told it has no key, on every single fetch.
      //
      // Locally installed models are also the case that most needs asking: nothing about
      // `llama3.3:70b-instruct-q5_K_M` is guessable, and no price catalog will ever list it.
      const base = trimmed(environment.OLLAMA_BASE_URL) ?? "http://localhost:11434/v1";
      return { url: modelsUrl(base), headers: {} };
    }
  }
}

/**
 * Model ids out of a `/v1/models` body.
 *
 * Tolerant by design: `{data:[…]}` is the common shape, a bare array happens on proxies, and each
 * entry may be a string or an object with `id` or `name`. A list that half-parses is worth more
 * than an exception, because the alternative is showing the user nothing.
 */
export function parseModelsResponse(body: unknown): string[] {
  const entries = Array.isArray(body)
    ? body
    : Array.isArray((body as { data?: unknown })?.data)
      ? (body as { data: unknown[] }).data
      : Array.isArray((body as { models?: unknown })?.models)
        ? (body as { models: unknown[] }).models
        : [];

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") { ids.push(entry); continue; }
    if (entry && typeof entry === "object") {
      const record = entry as { id?: unknown; name?: unknown };
      const id = typeof record.id === "string" ? record.id : typeof record.name === "string" ? record.name : undefined;
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/**
 * Models that cannot hold a conversation.
 *
 * Offering `text-embedding-3-large` in a menu of things to talk to is offering a mistake, and the
 * error it produces arrives one turn later from three layers down. Matched on the id because that
 * is all `/v1/models` reliably returns — capability metadata is not consistently present.
 */
const NON_CHAT = [
  /embed/i, /moderation/i, /whisper/i, /^tts/i, /audio/i, /dall-?e/i, /^stable-/i,
  /image/i, /vision-encoder/i, /rerank/i, /guard/i, /^text-similarity/i, /^text-search/i,
  /transcribe/i, /realtime/i, /^omni-moderation/i, /^davinci/i, /^babbage/i, /codex-mini/i,
];

export function isConversationalModel(id: string): boolean {
  return !NON_CHAT.some((pattern) => pattern.test(id));
}

/**
 * Folds a live list into the models this build already knew about.
 *
 * Known models keep their order — the provider's default first, then the catalog's — because that
 * order was chosen and a live list is alphabetical noise by comparison. Everything new is appended,
 * sorted, so the list a user has learned does not reshuffle when a provider ships something.
 */
export function mergeModelLists(known: readonly string[], live: readonly string[] | undefined): string[] {
  if (!live || live.length === 0) return [...known];
  const seen = new Set(known);
  const added = live.filter((model) => !seen.has(model)).sort();
  return [...known, ...added];
}
