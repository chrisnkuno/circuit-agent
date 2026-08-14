import { describe, expect, it } from "vitest";
import type { StateIndexReport, StateSearchHit, StateSessionSummary } from "@circuit-nova/nova-core/nova-cli/state-client";
import { CliStateHistory } from "./state-history";

function fakeState() {
  let rebuilds = 0;
  let closes = 0;
  const report: StateIndexReport = { sessions: 1, events: 2, documents: 3, failures: [] };
  const sessions: StateSessionSummary[] = [{
    sessionId: "session-a", title: "Payment repair", createdAt: 1, updatedAt: 2, revision: 3,
    eventCount: 2, lastSequence: 2, hasSnapshot: true, hasJournal: true,
  }];
  const hits = [{ sessionId: "session-a", title: "Payment repair" }] as StateSearchHit[];
  return {
    reader: {
      rebuild: async () => { rebuilds += 1; return report; },
      sessions: async () => sessions,
      search: async () => hits,
      close: async () => { closes += 1; },
    },
    counts: () => ({ rebuilds, closes }),
  };
}

describe("CliStateHistory", () => {
  it("connects lazily and coalesces a generation into one rebuild", async () => {
    const state = fakeState();
    let connects = 0;
    const history = new CliStateHistory("/repo", {}, async () => { connects += 1; return state.reader; });

    await Promise.all([history.refresh(), history.refresh(), history.sessions()]);
    expect(connects).toBe(1);
    expect(state.counts().rebuilds).toBe(1);

    history.markDirty();
    await history.sessions();
    expect(state.counts().rebuilds).toBe(2);
    await history.close();
    expect(state.counts().closes).toBe(1);
  });

  it("uses native ranked search only after the projection is current", async () => {
    const state = fakeState();
    const history = new CliStateHistory("/repo", {}, async () => state.reader);
    await expect(history.search("PaymentIntent")).resolves.toMatchObject([{ sessionId: "session-a" }]);
    expect(state.counts().rebuilds).toBe(1);
  });

  it("replays again when a session is saved during an in-flight rebuild", async () => {
    let rebuilds = 0;
    let announceStarted!: () => void;
    let releaseFirst!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const history = new CliStateHistory("/repo", {}, async () => ({
      rebuild: async () => {
        rebuilds += 1;
        if (rebuilds === 1) { announceStarted(); await firstMayFinish; }
        return { sessions: 1, events: 2, documents: 3, failures: [] };
      },
      sessions: async () => [],
      search: async () => [],
      close: async () => undefined,
    }));

    const refreshing = history.refresh();
    await started;
    history.markDirty();
    releaseFirst();
    await refreshing;
    expect(rebuilds).toBe(2);
    await expect(history.status()).resolves.toMatchObject({ mode: "native", indexed: true });
  });

  it("falls back permanently when no native package is installed", async () => {
    let connects = 0;
    const history = new CliStateHistory("/repo", {}, async () => { connects += 1; return null; });
    await expect(history.sessions()).resolves.toBeNull();
    await expect(history.search("anything")).resolves.toBeNull();
    await expect(history.status()).resolves.toMatchObject({ mode: "fallback", indexed: false });
    expect(connects).toBe(1);
  });

  it("closes a failed sidecar and keeps subsequent history reads on the fallback", async () => {
    let closes = 0;
    const history = new CliStateHistory("/repo", {}, async () => ({
      rebuild: async () => { throw new Error("projection unavailable"); },
      sessions: async () => [],
      search: async () => [],
      close: async () => { closes += 1; },
    }));
    await expect(history.sessions()).resolves.toBeNull();
    await expect(history.status()).resolves.toMatchObject({ mode: "fallback", reason: "projection unavailable" });
    expect(closes).toBe(1);
  });
});
