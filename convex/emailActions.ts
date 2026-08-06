"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { composeRunNotification, type RunLifecycleEvent } from "../lib/notifications";
import { sendEmail } from "../lib/providers/resend";

const lifecycleEvent = v.union(v.literal("started"), v.literal("completed"), v.literal("failed"), v.literal("cancelled"));

/**
 * Emails an organization about one run lifecycle event.
 *
 * Best-effort by design, exactly like the Telegram push: a mail provider outage must never fail
 * or roll back the run that triggered the notification. It is also configuration-gated — with no
 * RESEND_API_KEY this does nothing at all rather than erroring on every run — so the feature can
 * ship dark and light up when credentials exist, the same way the Telegram path does.
 */
export const notifyRunLifecycle = internalAction({
  args: {
    organizationId: v.id("organizations"),
    event: lifecycleEvent,
    taskTitle: v.string(),
    objective: v.string(),
    spentRwf: v.number(),
    maxRwf: v.number(),
    detail: v.optional(v.string()),
  },
  returns: v.object({ sent: v.number() }),
  handler: async (ctx, args): Promise<{ sent: number }> => {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!apiKey || !from) return { sent: 0 };

    const recipients: string[] = await ctx.runQuery(internal.notificationsModel.listRecipients, { organizationId: args.organizationId });
    if (recipients.length === 0) return { sent: 0 };

    const siteUrl = process.env.SITE_URL;
    const message = composeRunNotification({
      event: args.event as RunLifecycleEvent,
      taskTitle: args.taskTitle,
      objective: args.objective,
      spentRwf: args.spentRwf,
      maxRwf: args.maxRwf,
      detail: args.detail,
      workspaceUrl: siteUrl ? `${siteUrl.replace(/\/$/, "")}/terminal` : undefined,
    });

    try {
      await sendEmail({ apiKey, from, to: recipients, subject: message.subject, text: message.text });
      return { sent: recipients.length };
    } catch {
      // Best-effort — see the doc comment above.
      return { sent: 0 };
    }
  },
});
