import { v } from "convex/values";
import { internalQuery } from "./_generated/server";
import { selectNotificationRecipients } from "../lib/notifications";

/**
 * Email addresses to notify for one organization. Internal-only: this is the one place that
 * turns membership rows into contact details, and nothing client-callable should be able to
 * enumerate an organization's members' addresses.
 */
export const listRecipients = internalQuery({
  args: { organizationId: v.id("organizations") },
  returns: v.array(v.string()),
  handler: async (ctx, { organizationId }) => {
    const members = await ctx.db
      .query("memberships")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(50);
    return selectNotificationRecipients(members);
  },
});
