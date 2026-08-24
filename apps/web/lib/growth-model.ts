export type EvidenceStrength = "hypothesis" | "interviews" | "usage" | "revenue";

export type GrowthBaseline = {
  activeUsers: number;
  monthlyNewUsers: number;
  monthlyChurnPercent: number;
  monthlyRevenueUsd: number;
  monthlyCostsUsd: number;
  valuationRevenueMultiple: number;
};

export type GrowthFeature = {
  id: string;
  name: string;
  status: "idea" | "building" | "shipped";
  reachPercent: number;
  adoptionPercent: number;
  monthlyValuePerAdopterUsd: number;
  monthlyRevenuePerAdopterUsd: number;
  retentionLiftPercent: number;
  evidence: EvidenceStrength;
};

export type GrowthFeedback = {
  id: string;
  featureId?: string;
  kind: "problem" | "request" | "praise";
  affectedUsers: number;
  willingnessToPay: "unknown" | "no" | "maybe" | "yes";
  status: "new" | "validated" | "acted_on";
};

export type FeatureProjection = {
  featureId: string;
  adopters: number;
  incrementalMonthlyRevenueUsd: number;
  monthlyCustomerValueUsd: number;
  retainedUsersAtMonth12: number;
  valuationLiftUsd: number;
  confidencePercent: number;
};

export type GrowthProjection = {
  currentValuationUsd: number;
  month12Users: number;
  month12RevenueUsd: number;
  month12ProfitUsd: number;
  potentialValuationUsd: number;
  valuationLowUsd: number;
  valuationHighUsd: number;
  totalMonthlyCustomerValueUsd: number;
  featureProjections: FeatureProjection[];
  confidencePercent: number;
  questions: string[];
};

const evidenceWeight: Record<EvidenceStrength, number> = {
  hypothesis: 0.35,
  interviews: 0.55,
  usage: 0.78,
  revenue: 0.95,
};

function finite(value: number, minimum = 0): number {
  return Number.isFinite(value) ? Math.max(minimum, value) : minimum;
}

function percent(value: number): number {
  return Math.min(100, finite(value)) / 100;
}

function money(value: number): number {
  return Math.round(finite(value));
}

function signedMoney(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

export function projectNovaGrowth(
  rawBaseline: GrowthBaseline,
  features: GrowthFeature[],
  feedback: GrowthFeedback[],
): GrowthProjection {
  const baseline = {
    activeUsers: finite(rawBaseline.activeUsers),
    monthlyNewUsers: finite(rawBaseline.monthlyNewUsers),
    monthlyChurnPercent: Math.min(100, finite(rawBaseline.monthlyChurnPercent)),
    monthlyRevenueUsd: finite(rawBaseline.monthlyRevenueUsd),
    monthlyCostsUsd: finite(rawBaseline.monthlyCostsUsd),
    valuationRevenueMultiple: finite(rawBaseline.valuationRevenueMultiple, 0.1),
  };
  const baselineArpu = baseline.activeUsers > 0 ? baseline.monthlyRevenueUsd / baseline.activeUsers : 0;

  const featureProjections = features.map((feature): FeatureProjection => {
    const relatedFeedback = feedback.filter((item) => item.featureId === feature.id);
    const validatedSignals = relatedFeedback.filter((item) => item.status !== "new").length;
    const payingSignals = relatedFeedback.filter((item) => item.willingnessToPay === "yes").length;
    const evidence = Math.min(1, evidenceWeight[feature.evidence] + Math.min(0.12, validatedSignals * 0.03) + Math.min(0.08, payingSignals * 0.04));
    const reachableUsers = baseline.activeUsers * percent(feature.reachPercent);
    const adopters = Math.round(reachableUsers * percent(feature.adoptionPercent) * evidence);
    const incrementalMonthlyRevenueUsd = adopters * finite(feature.monthlyRevenuePerAdopterUsd);
    const monthlyCustomerValueUsd = adopters * finite(feature.monthlyValuePerAdopterUsd);
    const retainedUsersAtMonth12 = Math.round(baseline.activeUsers * percent(feature.retentionLiftPercent) * evidence);
    const retainedRevenue = retainedUsersAtMonth12 * baselineArpu;
    const valuationLiftUsd = (incrementalMonthlyRevenueUsd + retainedRevenue) * 12 * baseline.valuationRevenueMultiple;
    return {
      featureId: feature.id,
      adopters,
      incrementalMonthlyRevenueUsd: money(incrementalMonthlyRevenueUsd),
      monthlyCustomerValueUsd: money(monthlyCustomerValueUsd),
      retainedUsersAtMonth12,
      valuationLiftUsd: money(valuationLiftUsd),
      confidencePercent: Math.round(evidence * 100),
    };
  });

  let month12Users = baseline.activeUsers;
  const churn = percent(baseline.monthlyChurnPercent);
  for (let month = 0; month < 12; month += 1) {
    month12Users = Math.max(0, month12Users * (1 - churn) + baseline.monthlyNewUsers);
  }
  month12Users += featureProjections.reduce((sum, item) => sum + item.retainedUsersAtMonth12, 0);

  const recurringFeatureRevenue = featureProjections.reduce((sum, item) => sum + item.incrementalMonthlyRevenueUsd, 0);
  const organicRevenue = baseline.activeUsers > 0 ? baseline.monthlyRevenueUsd * (month12Users / baseline.activeUsers) : baseline.monthlyRevenueUsd;
  const month12RevenueUsd = money(organicRevenue + recurringFeatureRevenue);
  const currentValuationUsd = money(baseline.monthlyRevenueUsd * 12 * baseline.valuationRevenueMultiple);
  const potentialValuationUsd = money(month12RevenueUsd * 12 * baseline.valuationRevenueMultiple);
  const averageConfidence = featureProjections.length
    ? featureProjections.reduce((sum, item) => sum + item.confidencePercent, 0) / featureProjections.length
    : 35;
  const baselineCompleteness = [baseline.activeUsers, baseline.monthlyRevenueUsd, baseline.monthlyNewUsers].filter((value) => value > 0).length / 3;
  const confidencePercent = Math.round(Math.min(92, averageConfidence * 0.65 + baselineCompleteness * 35));
  const uncertainty = 0.55 - confidencePercent / 200;

  const questions: string[] = [];
  if (baseline.activeUsers === 0) questions.push("How many people used Nova in the last 30 days?");
  if (baseline.monthlyRevenueUsd === 0) questions.push("What has Nova earned in the last 30 days, and from how many paying users?");
  if (baseline.monthlyNewUsers === 0) questions.push("How many genuinely new users arrived in the last 30 days?");
  if (feedback.length < 5) questions.push("What are the five most recent user requests or complaints, and how many users share each one?");
  if (!feedback.some((item) => item.willingnessToPay === "yes")) questions.push("Which users have explicitly said they would pay for a requested outcome?");
  const weakest = featureProjections.reduce<FeatureProjection | undefined>((candidate, item) => !candidate || item.confidencePercent < candidate.confidencePercent ? item : candidate, undefined);
  if (weakest) {
    const feature = features.find((item) => item.id === weakest.featureId)!;
    if (weakest.confidencePercent < 70) questions.push(`What observed usage, interview, or payment evidence supports “${feature.name}”?`);
  }

  return {
    currentValuationUsd,
    month12Users: Math.round(month12Users),
    month12RevenueUsd,
    month12ProfitUsd: signedMoney(month12RevenueUsd - baseline.monthlyCostsUsd),
    potentialValuationUsd,
    valuationLowUsd: money(potentialValuationUsd * (1 - uncertainty)),
    valuationHighUsd: money(potentialValuationUsd * (1 + uncertainty)),
    totalMonthlyCustomerValueUsd: money(featureProjections.reduce((sum, item) => sum + item.monthlyCustomerValueUsd, 0)),
    featureProjections,
    confidencePercent,
    questions: questions.slice(0, 4),
  };
}
