import { describe, expect, it } from "vitest";
import { projectNovaGrowth, type GrowthBaseline, type GrowthFeature } from "./growth-model";

const baseline: GrowthBaseline = {
  activeUsers: 100,
  monthlyNewUsers: 20,
  monthlyChurnPercent: 5,
  monthlyRevenueUsd: 2_000,
  monthlyCostsUsd: 1_200,
  valuationRevenueMultiple: 5,
};

const feature: GrowthFeature = {
  id: "feature-1",
  name: "Team memory",
  status: "building",
  reachPercent: 60,
  adoptionPercent: 50,
  monthlyValuePerAdopterUsd: 80,
  monthlyRevenuePerAdopterUsd: 12,
  retentionLiftPercent: 2,
  evidence: "usage",
};

describe("projectNovaGrowth", () => {
  it("attributes adoption, created value, revenue, and valuation lift to a feature", () => {
    const result = projectNovaGrowth(baseline, [feature], []);
    expect(result.featureProjections[0]).toMatchObject({ adopters: 23, monthlyCustomerValueUsd: 1_840 });
    expect(result.featureProjections[0]!.incrementalMonthlyRevenueUsd).toBeGreaterThan(0);
    expect(result.featureProjections[0]!.valuationLiftUsd).toBeGreaterThan(0);
    expect(result.potentialValuationUsd).toBeGreaterThan(result.currentValuationUsd);
  });

  it("raises confidence when user evidence is validated", () => {
    const withoutEvidence = projectNovaGrowth(baseline, [feature], []);
    const withEvidence = projectNovaGrowth(baseline, [feature], [
      { id: "feedback-1", featureId: feature.id, kind: "request", affectedUsers: 4, willingnessToPay: "yes", status: "validated" },
    ]);
    expect(withEvidence.featureProjections[0]!.confidencePercent).toBeGreaterThan(withoutEvidence.featureProjections[0]!.confidencePercent);
    expect(withEvidence.featureProjections[0]!.adopters).toBeGreaterThan(withoutEvidence.featureProjections[0]!.adopters);
  });

  it("asks for missing evidence instead of presenting an empty forecast as certain", () => {
    const result = projectNovaGrowth({ ...baseline, activeUsers: 0, monthlyRevenueUsd: 0, monthlyNewUsers: 0 }, [], []);
    expect(result.confidencePercent).toBeLessThan(50);
    expect(result.questions).toContain("How many people used Nova in the last 30 days?");
    expect(result.questions).toContain("What has Nova earned in the last 30 days, and from how many paying users?");
  });

  it("does not hide a projected loss", () => {
    const result = projectNovaGrowth({ ...baseline, monthlyCostsUsd: 50_000 }, [], []);
    expect(result.month12ProfitUsd).toBeLessThan(0);
  });
});
