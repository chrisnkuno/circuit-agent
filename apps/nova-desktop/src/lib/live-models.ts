import { useEffect, useState } from "react";
import { sidecarRequest } from "./ipc";
import type { ProviderId } from "./settings";

/**
 * What each provider will actually accept, asked with the key the user pasted in.
 *
 * The menu used to be built entirely from the price catalog, which lists a model only once someone
 * has written down what it costs. For a menu whose question is "what can I switch to" that is
 * backwards: providers ship models faster than any rate table is updated, and the ones missing
 * from the catalog are disproportionately the new ones people are looking for. So the catalog
 * stays — it is what knows prices, and it works offline — and this widens it.
 *
 * One module-level result shared by every caller, because the model picker and the settings form
 * ask the same question and there is no reason for opening a menu to cost a round trip each time.
 * The sidecar holds the real six-hour cache; this only stops the app asking it repeatedly.
 */

export type LiveModels = Partial<Record<ProviderId, string[]>>;

export type LiveModelsState = {
  models: LiveModels;
  /** Provider ids that answered with a reason instead of a list, for an honest empty menu. */
  errors: Partial<Record<ProviderId, string>>;
  loading: boolean;
};

type ModelsListResult = {
  providers: Array<{ provider: ProviderId; models: string[]; error?: string }>;
  fromCache: boolean;
};

const EMPTY: LiveModelsState = { models: {}, errors: {}, loading: false };

let cached: LiveModelsState | undefined;
let inFlight: Promise<LiveModelsState> | undefined;
const listeners = new Set<(state: LiveModelsState) => void>();

function publish(state: LiveModelsState): LiveModelsState {
  cached = state;
  for (const listener of listeners) listener(state);
  return state;
}

/**
 * Asks the sidecar, once, unless `refresh` says otherwise.
 *
 * Never rejects. A sidecar that is not up yet, or a provider that is unreachable, has to leave the
 * picker showing the catalog rather than showing nothing: a menu that fails closed is worse than
 * one that is merely shorter than it could be.
 */
export async function fetchLiveModels(refresh = false): Promise<LiveModelsState> {
  if (!refresh && cached) return cached;
  if (!refresh && inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const result = await sidecarRequest<ModelsListResult>({ type: "models.list", refresh });
      const models: LiveModels = {};
      const errors: Partial<Record<ProviderId, string>> = {};
      for (const entry of result.providers ?? []) {
        if (entry.models?.length > 0) models[entry.provider] = entry.models;
        if (entry.error) errors[entry.provider] = entry.error;
      }
      return publish({ models, errors, loading: false });
    } catch {
      // Deliberately not surfaced as an error state: the catalog is still a complete, usable menu,
      // and an alarming banner over a working picker is worse than a slightly shorter list.
      return publish(cached ? { ...cached, loading: false } : EMPTY);
    } finally {
      inFlight = undefined;
    }
  })();
  return inFlight;
}

/** Drops the shared result, so the next ask goes back to the sidecar. For a changed key. */
export function invalidateLiveModels(): void {
  cached = undefined;
}

/**
 * The live list, fetched on mount and shared with every other caller.
 *
 * `enabled` exists so a closed menu costs nothing: the picker asks the first time it opens, which
 * is the first moment the answer can matter to anyone.
 */
export function useLiveModels(enabled = true): LiveModelsState {
  const [state, setState] = useState<LiveModelsState>(() => cached ?? EMPTY);

  useEffect(() => {
    listeners.add(setState);
    return () => { listeners.delete(setState); };
  }, []);

  useEffect(() => {
    if (!enabled || cached) return;
    setState((previous) => ({ ...previous, loading: true }));
    void fetchLiveModels();
  }, [enabled]);

  return state;
}
