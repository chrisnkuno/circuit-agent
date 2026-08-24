"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api, internal } from "./_generated/api";
import { formatRwf } from "../lib/task-cost";
import { parseChannelCommand, sendTelegramMessage } from "../lib/telegram";
import { startCodingRun } from "./codingRunPlan";

function botToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  return token;
}

async function reply(chatId: string, text: string): Promise<void> {
  await sendTelegramMessage({ botToken: botToken(), chatId, text });
}

/** The webhook route calls this only after verifying the request really came from Telegram. Org membership is resolved purely from channelLinks — nothing about the sender's claimed identity is ever trusted directly. */
export const handleIncomingMessage = internalAction({
  args: { chatId: v.string(), text: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const parsed = parseChannelCommand(args.text);

    if (parsed.kind === "link") {
      const result: { status: "linked" | "expired" | "invalid" } = await ctx.runMutation(internal.channels.completeLinkAttempt, { channel: "telegram", code: parsed.code, channelUserId: args.chatId });
      if (result.status === "linked") await reply(args.chatId, "Linked. Try /run <objective> for a real coding task, or /status for your recent tasks.");
      else if (result.status === "expired") await reply(args.chatId, "That code expired or was already used — generate a new one from the web app.");
      else await reply(args.chatId, "That code isn't valid — generate a new one from the web app.");
      return null;
    }

    if (parsed.kind === "help") {
      await reply(args.chatId, "Commands:\n/link <code> — pair this chat with your Circuit-Nova workspace\n/run <objective> — start a real, billed coding task\n/status — your most recent tasks");
      return null;
    }

    const link = await ctx.runQuery(internal.channels.resolveChannelUser, { channel: "telegram", channelUserId: args.chatId });
    if (!link) {
      await reply(args.chatId, "This chat isn't linked yet. Get a pairing code from the web app, then send /link <code>.");
      return null;
    }

    if (parsed.kind === "run") {
      try {
        await startCodingRun(ctx, { organizationId: link.organizationId, objective: parsed.objective, idempotencyKey: crypto.randomUUID(), authorization: "trusted-organization", costApproval: "pre-authorized" });
        await reply(args.chatId, `Started: "${parsed.objective}". I'll message you here when it finishes.`);
      } catch (error) {
        await reply(args.chatId, `Could not start that run: ${error instanceof Error ? error.message : "unknown error"}`);
      }
      return null;
    }

    if (parsed.kind === "status") {
      const tasks: Array<{ status: string; title: string; spentRwf: bigint; maxRwf: bigint }> = await ctx.runQuery(api.tasks.listRecent, { organizationId: link.organizationId });
      if (tasks.length === 0) { await reply(args.chatId, "No tasks yet — try /run <objective>."); return null; }
      const lines = tasks.slice(0, 5).map((task) => `${task.status} — ${task.title} (${formatRwf(Number(task.spentRwf))} of ${formatRwf(Number(task.maxRwf))})`);
      await reply(args.chatId, lines.join("\n"));
      return null;
    }

    await reply(args.chatId, "Unrecognized command. Send /help for what I understand.");
    return null;
  },
});

/** Pushes a message to every channel linked to an organization. A channel outage must never fail or roll back the run that triggered it — best-effort only. */
export const notifyLinkedChannels = internalAction({
  args: { organizationId: v.id("organizations"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const links: Array<{ channel: "telegram"; channelUserId: string }> = await ctx.runQuery(internal.channels.listLinkedForOrganization, { organizationId: args.organizationId });
    for (const link of links) {
      if (link.channel !== "telegram") continue;
      try {
        await sendTelegramMessage({ botToken: botToken(), chatId: link.channelUserId, text: args.message });
      } catch {
        // best-effort — see doc comment above
      }
    }
    return null;
  },
});
