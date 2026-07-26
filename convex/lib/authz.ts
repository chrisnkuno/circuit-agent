import type { Permission } from "../../lib/authz";
import { hasPermission } from "../../lib/authz";
import type { MutationCtx, QueryCtx } from "../_generated/server";

type AuthContext = QueryCtx | MutationCtx;

/** Backend trust boundary shared by all user-callable organization functions. */
export async function requireOrganizationPermission(ctx: AuthContext, organizationId: any, permission: Permission) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  const membership = await ctx.db.query("memberships")
    .withIndex("by_organization_subject", (query) => query.eq("organizationId", organizationId).eq("identitySubject", identity.subject))
    .unique();
  if (!membership || membership.status !== "active") throw new Error("Organization access denied");
  if (!hasPermission(membership.role, permission)) throw new Error(`Missing permission: ${permission}`);
  return { identity, membership };
}
