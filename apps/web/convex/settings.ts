import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

const provider = v.union(v.literal("deployment"), v.literal("openai"), v.literal("circuitnotion"));
const mode = v.union(v.literal("ask"), v.literal("plan"), v.literal("build"));

export const getNovaPreferences = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const stored = await ctx.db.query("novaPreferences").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).unique();
    return stored ?? { organizationId, provider: "deployment" as const, modelId: undefined, mode: "ask" as const, memoryEnabled: true, updatedAt: 0 };
  },
});

export const updateNovaPreferences = mutation({
  args: { organizationId: v.id("organizations"), provider, modelId: v.optional(v.string()), mode, memoryEnabled: v.boolean() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await requireOrganizationPermission(ctx, args.organizationId, "task:create");
    const modelId = args.modelId?.trim() || undefined;
    if (modelId && (!/^[a-zA-Z0-9._:/-]+$/.test(modelId) || modelId.length > 120)) throw new Error("Invalid model id");
    const existing = await ctx.db.query("novaPreferences").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).unique();
    const value = { provider: args.provider, modelId, mode: args.mode, memoryEnabled: args.memoryEnabled, updatedAt: Date.now() };
    if (existing) await ctx.db.patch(existing._id, value);
    else await ctx.db.insert("novaPreferences", { organizationId: args.organizationId, ...value });
    return null;
  },
});

export const getNovaPreferencesInternal = internalQuery({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    return ctx.db.query("novaPreferences").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).unique();
  },
});
