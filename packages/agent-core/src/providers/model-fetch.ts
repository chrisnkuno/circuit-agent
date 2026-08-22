import { promises as fs } from "node:fs";
import path from "node:path";
import { PROVIDER_INFO, type ProviderId } from "./provider-specs";
import { isConversationalModel, modelsEndpoint, parseModelsResponse } from "./model-list";

// Re-exported so every existing importer of this module goes on working unchanged.
export { isConversationalModel, mergeModelLists, modelsEndpoint, modelsUrl, parseModelsResponse } from "./model-list";
import { novaConfigDirectory } from "../nova-cli/memory";

/**
 * The models a provider will actually accept today, not the ones this build was compiled knowing.
 *
 * The catalog in `models.ts` is derived from the *price* catalog, which means a model is only
 * offerable if someone has written down what it costs. That is exactly backwards for a list whose
 * job is "what can I switch to": every provider ships models faster than any price table is
 * updated, and the ones missing from the list are disproportionately the new ones people want.
 *
 * So the list is the union of two sources:
 *
 * - the **price catalog**, which knows rates and is always available, and
 * - the **provider's own `/v1/models`**, which knows what exists.
 *
 * Neither is dropped. A model with no known price is offered and labelled as such, because "I do
 * not know what this costs" is a true and useful thing to say, and refusing to show it is not.
 *
 * Every network detail here is injected, so the whole module is tested without a socket.
 */

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type ModelFetchResult = {
  provider: ProviderId;
  models: string[];
  /** Absent on success; a short reason otherwise, for the CLI to report without a stack trace. */
  error?: string;
};

/**
 * Where a provider's model list lives.
 *
 * All three speak the same shape — `GET /v1/models` returning `{ data: [{ id }] }` — but they do
 * not agree on how a key is presented, and getting that wrong is a 401 that looks like an outage.
 */
/** Asks one provider what it has. Never throws — a failure is a reported reason. */
export async function fetchProviderModels(
  provider: ProviderId,
  environment: Record<string, string | undefined>,
  fetchImpl: FetchLike,
  timeoutMs = 4_000,
): Promise<ModelFetchResult> {
  const endpoint = modelsEndpoint(provider, environment);
  if (!endpoint) return { provider, models: [], error: "no key configured" };

  try {
    // Raced rather than aborted: the CLI is holding a prompt open, and a provider that never
    // answers must not be able to hold `/models` hostage.
    const response = await Promise.race([
      fetchImpl(endpoint.url, { method: "GET", headers: endpoint.headers }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("timed out")), timeoutMs)),
    ]);
    if (!response.ok) return { provider, models: [], error: `provider returned ${response.status}` };
    const models = parseModelsResponse(await response.json()).filter(isConversationalModel);
    return { provider, models: models.sort() };
  } catch (error) {
    return { provider, models: [], error: error instanceof Error ? error.message : String(error) };
  }
}

export type ModelCache = {
  /** Epoch millis of the fetch. */
  fetchedAt: number;
  models: Partial<Record<ProviderId, string[]>>;
};

/** How long a fetched list is trusted. Long enough to be free at the prompt, short enough to be current. */
export const MODEL_CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

export function modelCacheFile(environment: Record<string, string | undefined>): string {
  return path.join(novaConfigDirectory(environment), "models.json");
}

export function isCacheFresh(cache: ModelCache | undefined, now = Date.now(), ttlMs = MODEL_CACHE_TTL_MS): boolean {
  if (!cache) return false;
  // A cache stamped in the future is a clock that moved, not a fresh cache; treated as stale so a
  // corrected clock cannot leave a session pinned to a list from a machine's imagined future.
  return cache.fetchedAt <= now && now - cache.fetchedAt < ttlMs;
}

export async function readModelCache(environment: Record<string, string | undefined>): Promise<ModelCache | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(modelCacheFile(environment), "utf8")) as ModelCache;
    return typeof parsed?.fetchedAt === "number" && parsed.models ? parsed : undefined;
  } catch {
    // No cache, unreadable cache, or a cache written by an older shape — all mean "fetch again".
    return undefined;
  }
}

export async function writeModelCache(environment: Record<string, string | undefined>, cache: ModelCache): Promise<void> {
  const file = modelCacheFile(environment);
  try {
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Written through a temp file: a half-written cache read by the next session is a parse error
    // at startup, which is a worse outcome than no cache at all.
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
    await fs.rename(temporary, file);
  } catch {
    // A cache that cannot be written costs a fetch next time and nothing else.
  }
}

/**
 * Every provider's live list, from cache when it is fresh.
 *
 * Providers are asked in parallel: one slow provider should cost the wait once, not once per
 * provider, and the whole call is bounded by the slowest single request.
 */
export async function loadLiveModels(
  providers: readonly ProviderId[],
  environment: Record<string, string | undefined>,
  options: { fetchImpl?: FetchLike; now?: number; refresh?: boolean } = {},
): Promise<{ models: Partial<Record<ProviderId, string[]>>; fromCache: boolean; errors: ModelFetchResult[] }> {
  const now = options.now ?? Date.now();
  if (!options.refresh) {
    const cached = await readModelCache(environment);
    if (isCacheFresh(cached, now)) return { models: cached!.models, fromCache: true, errors: [] };
  }

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl) return { models: {}, fromCache: false, errors: [] };

  const results = await Promise.all(providers.map((provider) => fetchProviderModels(provider, environment, fetchImpl)));
  const models: Partial<Record<ProviderId, string[]>> = {};
  for (const result of results) if (result.models.length > 0) models[result.provider] = result.models;

  if (Object.keys(models).length > 0) await writeModelCache(environment, { fetchedAt: now, models });
  return { models, fromCache: false, errors: results.filter((result) => result.error) };
}


/**
 * The provider ids worth asking: those with a key present.
 *
 * Generic in the id type so a caller that offers a subset of providers gets that subset back.
 * A front end with three providers narrowing to the core's four would otherwise have to assert
 * its way out of a type it already knew, at exactly the point where being wrong means asking a
 * provider it cannot select from.
 */
export function fetchableProviders<P extends ProviderId>(
  environment: Record<string, string | undefined>,
  providers: readonly P[],
): P[] {
  return providers.filter((provider) => PROVIDER_INFO[provider].requires.every((name) => environment[name]?.trim()));
}
