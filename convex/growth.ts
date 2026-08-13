import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

const featureStatus = v.union(v.literal("idea"), v.literal("building"), v.literal("shipped"));
const evidence = v.union(v.literal("hypothesis"), v.literal("interviews"), v.literal("usage"), v.literal("revenue"));
const feedbackStatus = v.union(v.literal("new"), v.literal("validated"), v.literal("acted_on"));

function bounded(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(value) || value < 0 || value > maximum) throw new Error(`${label} must be between 0 and ${maximum}`);
  return value;
}

function requiredText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > maximum) throw new Error(`${label} must be at most ${maximum} characters`);
  return normalized;
}

export const getWorkspace = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const [baseline, features, feedback] = await Promise.all([
      ctx.db.query("growthBaselines").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).unique(),
      ctx.db.query("growthFeatures").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").collect(),
      ctx.db.query("growthFeedback").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").collect(),
    ]);
    return { baseline, features, feedback };
  },
});

export const saveBaseline = mutation({
  args: {
    organizationId: v.id("organizations"),
    activeUsers: v.number(),
    monthlyNewUsers: v.number(),
    monthlyChurnPercent: v.number(),
    monthlyRevenueUsd: v.number(),
    monthlyCostsUsd: v.number(),
    valuationRevenueMultiple: v.number(),
  },
  handler: async (ctx, args) => {
    const { identity } = await requireOrganizationPermission(ctx, args.organizationId, "task:create");
    const values = {
      activeUsers: bounded(args.activeUsers, "Active users"),
      monthlyNewUsers: bounded(args.monthlyNewUsers, "Monthly new users"),
      monthlyChurnPercent: bounded(args.monthlyChurnPercent, "Monthly churn", 100),
      monthlyRevenueUsd: bounded(args.monthlyRevenueUsd, "Monthly revenue"),
      monthlyCostsUsd: bounded(args.monthlyCostsUsd, "Monthly costs"),
      valuationRevenueMultiple: bounded(args.valuationRevenueMultiple, "Revenue multiple", 100),
      updatedAt: Date.now(),
      updatedBy: identity.subject,
    };
    const existing = await ctx.db.query("growthBaselines").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).unique();
    if (existing) {
      await ctx.db.patch(existing._id, values);
      return existing._id;
    }
    return ctx.db.insert("growthBaselines", { organizationId: args.organizationId, ...values });
  },
});

export const addFeature = mutation({
  args: {
    organizationId: v.id("organizations"),
    name: v.string(),
    status: featureStatus,
    reachPercent: v.number(),
    adoptionPercent: v.number(),
    monthlyValuePerAdopterUsd: v.number(),
    monthlyRevenuePerAdopterUsd: v.number(),
    retentionLiftPercent: v.number(),
    evidence,
  },
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "task:create");
    const now = Date.now();
    return ctx.db.insert("growthFeatures", {
      organizationId: args.organizationId,
      name: requiredText(args.name, "Feature name", 100),
      status: args.status,
      reachPercent: bounded(args.reachPercent, "Reach", 100),
      adoptionPercent: bounded(args.adoptionPercent, "Adoption", 100),
      monthlyValuePerAdopterUsd: bounded(args.monthlyValuePerAdopterUsd, "Created value"),
      monthlyRevenuePerAdopterUsd: bounded(args.monthlyRevenuePerAdopterUsd, "Revenue per adopter"),
      retentionLiftPercent: bounded(args.retentionLiftPercent, "Retention lift", 100),
      evidence: args.evidence,
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const addFeedback = mutation({
  args: {
    organizationId: v.id("organizations"),
    featureId: v.optional(v.id("growthFeatures")),
    source: v.string(),
    summary: v.string(),
    kind: v.union(v.literal("problem"), v.literal("request"), v.literal("praise")),
    affectedUsers: v.number(),
    willingnessToPay: v.union(v.literal("unknown"), v.literal("no"), v.literal("maybe"), v.literal("yes")),
  },
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "task:create");
    if (args.featureId) {
      const feature = await ctx.db.get(args.featureId);
      if (!feature || feature.organizationId !== args.organizationId) throw new Error("Feature does not belong to this workspace");
    }
    return ctx.db.insert("growthFeedback", {
      organizationId: args.organizationId,
      featureId: args.featureId,
      source: requiredText(args.source, "Feedback source", 80),
      summary: requiredText(args.summary, "Feedback", 500),
      kind: args.kind,
      affectedUsers: bounded(args.affectedUsers, "Affected users"),
      willingnessToPay: args.willingnessToPay,
      status: "new",
      createdAt: Date.now(),
    });
  },
});

export const setFeedbackStatus = mutation({
  args: { feedbackId: v.id("growthFeedback"), status: feedbackStatus },
  handler: async (ctx, { feedbackId, status }) => {
    const item = await ctx.db.get(feedbackId);
    if (!item) throw new Error("Feedback not found");
    await requireOrganizationPermission(ctx, item.organizationId, "task:create");
    await ctx.db.patch(feedbackId, { status });
    return null;
  },
});
