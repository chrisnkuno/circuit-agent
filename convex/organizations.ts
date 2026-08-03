import { mutation, query } from "./_generated/server";

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
    if (existing) return existing.organizationId;

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
    await ctx.db.insert("memberships", { organizationId, identitySubject: identity.subject, role: "owner", status: "active", createdAt: now });
    return organizationId;
  },
});
