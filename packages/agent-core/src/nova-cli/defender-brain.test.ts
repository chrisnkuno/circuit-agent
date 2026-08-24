import { describe, expect, it } from "vitest";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
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

  it("falls back to the bundled corpus when native validation rejects a signed replica", async () => {
    const rejected = await fs.mkdtemp(path.join(os.tmpdir(), "nova-rejected-replica-"));
    const rebuilt: string[] = [];
    const client = {
      async rebuildDefenderBrain(source: string): Promise<DefenderBrainReport> {
        rebuilt.push(source);
        if (source === rejected) throw new Error("replica rejected");
        return { records: 1, rejected: 0, sourceFiles: 1, changed: true };
      },
      async searchDefenderBrain() { return [hit]; },
      async close() {},
    };
    try {
      const brain = new DefenderBrain(path.resolve(".nova/test-brain"), async () => client, [corpus], async () => rejected);
      const result = await brain.search("PQC");
      expect(result.hits).toEqual([hit]);
      expect(rebuilt).toEqual([rejected, corpus]);
    } finally { await fs.rm(rejected, { recursive: true, force: true }); }
  });
});
