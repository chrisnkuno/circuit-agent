import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

function normalizeCode(value: string, length: number, label: string): string {
  const normalized = value.trim().toUpperCase();
  if (normalized.length !== length || !/^[A-Z]+$/.test(normalized)) throw new Error(`${label} must be a ${length}-letter code`);
  return normalized;
}

function slugify(value: string): string {
  const base = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return base || "workspace";
}

/** Returns the caller's active organization membership, or null if none exists yet. */
export const getCurrentMembership = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    const membership = await ctx.db.query("memberships")
      .withIndex("by_subject", (q) => q.eq("identitySubject", identity.subject))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (!membership) return null;
    const organization = await ctx.db.get(membership.organizationId);
    if (!organization) return null;
    return { membership, organization };
  },
});

/** Creates a personal organization and owner membership for a first-time signed-in user. Idempotent. */
export const ensureOrganization = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const existing = await ctx.db.query("memberships")
      .withIndex("by_subject", (q) => q.eq("identitySubject", identity.subject))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (existing) {
      // Self-healing contact details: members created before notifications existed have no
      // address, and a member who changes their sign-in email should not keep receiving mail
      // at the old one. Both converge here on the next sign-in.
      if (identity.email && existing.notificationEmail !== identity.email) {
        await ctx.db.patch(existing._id, { notificationEmail: identity.email });
      }
      return existing.organizationId;
    }

    const now = Date.now();
    const label = identity.name ?? identity.email ?? "Workspace";
    const baseSlug = slugify(label);
    let slug = baseSlug;
    let attempt = 0;
    while (await ctx.db.query("organizations").withIndex("by_slug", (q) => q.eq("slug", slug)).first()) {
      attempt += 1;
      slug = `${baseSlug}-${attempt}`;
    }

    const organizationId = await ctx.db.insert("organizations", { name: `${label}'s workspace`, slug, createdAt: now });
    await ctx.db.insert("memberships", { organizationId, identitySubject: identity.subject, role: "owner", status: "active", notificationEmail: identity.email, createdAt: now });
    return organizationId;
  },
});

/** Saves only the signed-in member's display preference; it cannot alter another member. */
export const updateMoneyPreferences = mutation({
  args: {
    countryCode: v.string(),
    currencyCode: v.string(),
    source: v.union(v.literal("automatic"), v.literal("manual")),
  },
  returns: v.null(),
  handler: async (ctx, { countryCode, currencyCode, source }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");
    const membership = await ctx.db.query("memberships")
      .withIndex("by_subject", (q) => q.eq("identitySubject", identity.subject))
      .filter((q) => q.eq(q.field("status"), "active"))
      .first();
    if (!membership) throw new Error("Active workspace membership not found");
    await ctx.db.patch(membership._id, {
      countryCode: normalizeCode(countryCode, 2, "countryCode"),
      currencyCode: normalizeCode(currencyCode, 3, "currencyCode"),
      currencySource: source,
      moneyPreferencesUpdatedAt: Date.now(),
    });
    return null;
  },
});
