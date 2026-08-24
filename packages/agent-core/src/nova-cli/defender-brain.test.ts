import { describe, expect, it } from "vitest";
import path from "node:path";
import { DefenderBrain, defenderKnowledgeCandidates } from "./defender-brain";
import type { DefenderBrainHit, DefenderBrainReport } from "./state-client";

const hit: DefenderBrainHit = {
  id: "record", domain: "cryptographic-research", title: "PQC migration", summary: "Inventory first.",
  guidance: "Use current standards.", tags: ["PQC"], sources: [], reviewedAt: "2026-08-24",
  expiresAt: "2026-11-24", confidence: "high", stale: false, score: 1,
};

describe("DefenderBrain", () => {
  const corpus = path.resolve("packages/nova-state/defender-knowledge");
  it("resolves source and bundled corpus layouts without using cwd", () => {
    const candidates = defenderKnowledgeCandidates("file:///repo/packages/agent-core/src/nova-cli/defender-brain.ts");
    expect(candidates).toEqual([
      "/repo/packages/agent-core/src/nova-cli/defender-knowledge",
      "/repo/packages/nova-state/defender-knowledge",
    ]);
  });

  it("coalesces rebuilds and bounds caller-provided limits", async () => {
    let rebuilds = 0;
    let receivedLimit = 0;
    const client = {
      async rebuildDefenderBrain(): Promise<DefenderBrainReport> { rebuilds += 1; return { records: 1, rejected: 0, sourceFiles: 1, changed: true }; },
      async searchDefenderBrain(_source: string, _data: string, _query: string, limit: number) { receivedLimit = limit; return [hit]; },
      async close() {},
    };
    const brain = new DefenderBrain(path.resolve(".nova/test-brain"), async () => client, [corpus]);
    const [left, right] = await Promise.all([brain.search("PQC", 99), brain.search("PQC", 99)]);
    expect(left.hits).toEqual([hit]);
    expect(right.hits).toEqual([hit]);
    expect(rebuilds).toBe(1);
    expect(receivedLimit).toBe(8);
  });

  it("returns a visible downgrade instead of throwing", async () => {
    const brain = new DefenderBrain(path.resolve(".nova/test-brain"), async () => null, [corpus]);
    const result = await brain.search("identity");
    expect(result.hits).toEqual([]);
    expect(result.reason).toContain("unavailable");
  });
});
