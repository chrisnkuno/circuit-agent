import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one fetch every surface shares.
 *
 * The model picker and the settings form ask the same question of the same key, and the answer
 * costs a round trip through the sidecar to three providers. These tests pin the sharing itself:
 * asking twice must not fetch twice, a failure must leave the catalog menu working rather than
 * emptying it, and a saved key must not go on being answered by the previous key's list.
 */

const sidecarRequest = vi.fn();
vi.mock("./ipc", () => ({ sidecarRequest: (payload: unknown) => sidecarRequest(payload) }));

async function freshModule() {
  vi.resetModules();
  return await import("./live-models");
}

beforeEach(() => {
  sidecarRequest.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the shared live-model result", () => {
  it("asks the sidecar once, however many callers want the answer", async () => {
    const { fetchLiveModels } = await freshModule();
    sidecarRequest.mockResolvedValue({ providers: [{ provider: "anthropic", models: ["claude-vega-6"] }], fromCache: false });

    const [first, second] = await Promise.all([fetchLiveModels(), fetchLiveModels()]);
    await fetchLiveModels(); // a third caller, after the first has already settled

    expect(sidecarRequest).toHaveBeenCalledTimes(1);
    expect(first.models.anthropic).toEqual(["claude-vega-6"]);
    expect(second.models.anthropic).toEqual(["claude-vega-6"]);
  });

  it("asks again when told to refresh, since a pasted key changes the answer", async () => {
    const { fetchLiveModels } = await freshModule();
    sidecarRequest.mockResolvedValue({ providers: [], fromCache: false });

    await fetchLiveModels();
    await fetchLiveModels(true);
    expect(sidecarRequest).toHaveBeenCalledTimes(2);
    expect(sidecarRequest).toHaveBeenLastCalledWith({ type: "models.list", refresh: true });
  });

  it("forgets the previous key's answer when settings are saved", async () => {
    const { fetchLiveModels, invalidateLiveModels } = await freshModule();
    sidecarRequest.mockResolvedValue({ providers: [], fromCache: false });

    await fetchLiveModels();
    invalidateLiveModels();
    await fetchLiveModels();
    // Two fetches for two keys. Without this the picker goes on offering the old account's models
    // and, worse, goes on hiding the new key's.
    expect(sidecarRequest).toHaveBeenCalledTimes(2);
  });

  it("leaves the catalog menu working when the sidecar cannot answer", async () => {
    const { fetchLiveModels } = await freshModule();
    sidecarRequest.mockRejectedValue(new Error("sidecar is not up"));

    // Never rejects: the caller renders a menu, and a menu that fails closed is worse than one
    // that is merely shorter than it could have been.
    const state = await fetchLiveModels();
    expect(state.models).toEqual({});
    expect(state.loading).toBe(false);
  });

  it("keeps each provider's failure beside the lists that did arrive", async () => {
    const { fetchLiveModels } = await freshModule();
    sidecarRequest.mockResolvedValue({
      providers: [
        { provider: "anthropic", models: ["claude-opus-5"] },
        { provider: "openai", models: [], error: "provider returned 401" },
      ],
      fromCache: false,
    });

    const state = await fetchLiveModels();
    expect(state.models.anthropic).toEqual(["claude-opus-5"]);
    expect(state.models.openai).toBeUndefined();
    expect(state.errors.openai).toBe("provider returned 401");
  });
});
