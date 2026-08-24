import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { requireOrganizationPermission } from "./lib/authz";

const presetValidator = v.object({ label: v.string(), objective: v.string() });

/** Read-only, permission-checked — lets the terminal show the last generated set instantly while a context change is (maybe) still being generated. */
export const getCached = query({
  args: { organizationId: v.id("organizations") },
  returns: v.union(v.object({ contextKey: v.string(), presets: v.array(presetValidator), generatedAt: v.number() }), v.null()),
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    const cached = await ctx.db.query("terminalPresets").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").first();
    if (!cached) return null;
    return { contextKey: cached.contextKey, presets: cached.presets, generatedAt: cached.generatedAt };
  },
});

export const getCachedInternal = internalQuery({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    return ctx.db.query("terminalPresets").withIndex("by_organization", (q) => q.eq("organizationId", organizationId)).order("desc").first();
  },
});

export const upsertCache = internalMutation({
  args: { organizationId: v.id("organizations"), contextKey: v.string(), presets: v.array(presetValidator) },
  handler: async (ctx, args) => {
    const existing = await ctx.db.query("terminalPresets").withIndex("by_organization", (q) => q.eq("organizationId", args.organizationId)).order("desc").first();
    const patch = { organizationId: args.organizationId, contextKey: args.contextKey, presets: args.presets, generatedAt: Date.now() };
    if (existing) await ctx.db.replace(existing._id, patch);
    else await ctx.db.insert("terminalPresets", patch);
  },
});
