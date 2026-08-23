import { describe, expect, it } from "vitest";
import {
  scoreReliability,
  type ReliabilityAudit,
  type ReliabilityCase,
} from "./reliability";

const healthy: ReliabilityCase = {
  name: "debug",
  completed: true,
  verified: true,
  scopeKept: true,
  stateCorrect: true,
  actualTokens: 10_000,
  economicalTokenTarget: 12_000,
  predictedTokensLow: 8_000,
  predictedTokensHigh: 14_000,
  failedToolCalls: 0,
  unavailableToolCalls: 0,
  toolCalls: 3,
  elapsedMs: 1_000,
  latencyTargetMs: 2_000,
  outputQualityChecksPassed: 3,
  outputQualityChecksTotal: 3,
  costReported: true,
};

const categories: ReliabilityAudit["categories"] = [
  "ui",
  "taskExecution",
  "memoryResume",
  "security",
  "approvals",
  "costAccuracy",
  "portability",
].map((name) => ({
  name: name as ReliabilityAudit["categories"][number]["name"],
  passed: true,
  tests: 10,
  failed: 0,
  durationMs: 50,
}));
const audits: ReliabilityAudit[] = ["linux", "darwin", "win32"].map(
  (platform) => ({
    platform,
    architecture: "x64",
    generatedAt: "2026-08-23T00:00:00.000Z",
    categories,
    historyStartupP50Ms: 20,
  }),
);

describe("Nova reliability score", () => {
  it("gives fully evidenced, economical, cross-platform work 100", () => {
    expect(scoreReliability([healthy], audits, { exaScore: 100 })).toMatchObject({
      score: 100,
      grade: "excellent",
      passed: 1,
      predictionCoverage: 100,
      toolFailureRate: 0,
      completionRate: 100,
      outputQualityRate: 100,
      auditPlatforms: ["darwin", "linux", "win32"],
      auditTests: 210,
    });
  });

  it("does not award unmeasured controls", () => {
    const report = scoreReliability([healthy]);
    expect(report.score).toBeLessThan(90);
    expect(report.components.security).toBe(0);
    expect(report.components.approvals).toBe(0);
    expect(report.components.ui).toBe(0);
    expect(report.components.portability).toBe(0);
    expect(report.components.research).toBe(0);
  });

  it("penalizes tool failures, slowness, token waste, prediction misses, and scope drift independently", () => {
    const report = scoreReliability(
      [
        {
          ...healthy,
          actualTokens: 40_000,
          predictedTokensHigh: 15_000,
          failedToolCalls: 2,
          scopeKept: false,
          elapsedMs: 10_000,
          latencyTargetMs: 1_000,
        },
      ],
      audits,
      { exaScore: 100 },
    );
    expect(report.score).toBeLessThan(80);
    expect(report.components.toolReliability).toBeLessThan(10);
    expect(report.components.speed).toBeLessThan(7);
    expect(report.components.economy).toBeLessThan(7);
    expect(report.components.prediction).toBeLessThan(5);
    expect(report.components.scope).toBe(0);
  });

  it("caps false success, failed security, and silent permission escalation regardless of averages", () => {
    expect(
      scoreReliability([{ ...healthy, misleadingSuccess: true }], audits, { exaScore: 100 }).score,
    ).toBe(40);
    expect(
      scoreReliability([{ ...healthy, permissionEscalation: true }], audits, { exaScore: 100 })
        .score,
    ).toBe(30);
    const insecure = audits.map((audit, index) =>
      index === 0
        ? {
            ...audit,
            categories: audit.categories.map((item) =>
              item.name === "security"
                ? { ...item, passed: false, failed: 1 }
                : item,
            ),
          }
        : audit,
    );
    expect(scoreReliability([healthy], insecure, { exaScore: 100 }).score).toBe(49);
  });

  it("never labels an incomplete suite reliable", () => {
    expect(
      scoreReliability(
        [healthy, { ...healthy, name: "build", completed: false }],
        audits,
        { exaScore: 100 },
      ).score,
    ).toBeLessThanOrEqual(69);
  });
});
