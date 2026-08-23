import { describe, expect, it } from "vitest";
import {
  scoreExaReliability,
  type ExaReliabilityCase,
} from "./exa-reliability";

const healthy = (name: ExaReliabilityCase["name"]): ExaReliabilityCase => ({
  name,
  resultCount: 20,
  targetResults: 20,
  relevantResults: 20,
  uniqueUrls: 20,
  uniqueDomains: 10,
  targetDomains: 10,
  highlightedResults: 20,
  elapsedMs: 1_000,
  latencyTargetMs: 2_000,
  costDollars: 0.01,
  ...(name === "freshness" ? { datedResults: 20, freshResults: 20 } : {}),
  ...(name === "alpha"
    ? { findings: 5, groundedFindings: 5, triangulatedFindings: 5 }
    : {}),
  ...(name === "defender"
    ? {
        findings: 5,
        groundedFindings: 5,
        triangulatedFindings: 5,
        toolCandidates: 5,
        qualifiedToolCandidates: 5,
      }
    : {}),
});

describe("Exa reliability scoring", () => {
  it("awards 100 only to broad, relevant, diverse, current, grounded evidence", () => {
    expect(
      scoreExaReliability([
        healthy("breadth"),
        healthy("freshness"),
        healthy("alpha"),
        healthy("defender"),
      ]),
    ).toMatchObject({
      score: 100,
      grade: "excellent",
      passed: 4,
      relevanceRate: 100,
      duplicateRate: 0,
      highlightCoverage: 100,
      totalCostDollars: 0.04,
    });
  });

  it("penalizes shallow, repetitive, noisy and opaque search independently", () => {
    const report = scoreExaReliability([
      {
        ...healthy("freshness"),
        resultCount: 10,
        targetResults: 20,
        relevantResults: 4,
        uniqueUrls: 5,
        uniqueDomains: 2,
        highlightedResults: 4,
        freshResults: 5,
        elapsedMs: 10_000,
        latencyTargetMs: 1_000,
        costDollars: null,
      },
    ]);
    expect(report.score).toBeLessThan(60);
    expect(report.components.coverage).toBe(9);
    expect(report.components.deduplication).toBe(2.5);
    expect(report.components.costTransparency).toBe(0);
  });

  it("caps a zero-result case even when another case is healthy", () => {
    expect(
      scoreExaReliability([
        healthy("breadth"),
        {
          ...healthy("alpha"),
          resultCount: 0,
          relevantResults: 0,
          uniqueUrls: 0,
          uniqueDomains: 0,
          highlightedResults: 0,
        },
      ]).score,
    ).toBeLessThanOrEqual(49);
  });
});
