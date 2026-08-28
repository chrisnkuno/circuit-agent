import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireOrganizationPermission } from "./lib/authz";
import { detectBuildIntent } from "../lib/build-intent";

const MAX_MESSAGE_LENGTH = 8_000;
const MESSAGE_WINDOW = 120;

function preview(content: string): string {
  return content.replace(/\s+/g, " ").trim().slice(0, 120);
}

export const listConversations = query({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:read");
    return ctx.db.query("conversations")
      .withIndex("by_organization_updated", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .take(40);
  },
});

export const listMessages = query({
  args: { conversationId: v.id("conversations") },
  handler: async (ctx, { conversationId }) => {
    const conversation = await ctx.db.get(conversationId);
    if (!conversation) throw new Error("Conversation not found");
    await requireOrganizationPermission(ctx, conversation.organizationId, "task:read");
    const messages = await ctx.db.query("conversationMessages")
      .withIndex("by_conversation_created", (q) => q.eq("conversationId", conversationId))
      .order("desc")
      .take(MESSAGE_WINDOW);
    return messages.reverse();
  },
});

export const ensureNovaConversation = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("conversations"),
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:create");
    const existing = await ctx.db.query("conversations")
      .withIndex("by_organization_updated", (q) => q.eq("organizationId", organizationId))
      .filter((q) => q.and(q.eq(q.field("kind"), "nova"), q.eq(q.field("status"), "active")))
      .order("desc")
      .first();
    if (existing) return existing._id;
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, title: "Nova", kind: "nova", status: "active", createdAt: now, updatedAt: now,
    });
    // Says what actually happens now: within the workspace's automation ceiling a sandbox starts on
    // its own, and only a quote above it stops to ask. The old wording promised an approval for
    // every paid task, which stopped being true when the ceiling was introduced.
    const welcome = "I’m Nova. Tell me what to build and I’ll start a cloud sandbox for it straight away — you’ll see it working beside this conversation, and several can run at once. Anything quoted above your automation ceiling stops and asks first.";
    await ctx.db.insert("conversationMessages", {
      organizationId, conversationId, sender: "nova", content: welcome, status: "sent", createdAt: now,
    });
    await ctx.db.patch(conversationId, { lastMessagePreview: preview(welcome), lastMessageAt: now });
    return conversationId;
  },
});

export const createNovaConversation = mutation({
  args: { organizationId: v.id("organizations") },
  returns: v.id("conversations"),
  handler: async (ctx, { organizationId }) => {
    await requireOrganizationPermission(ctx, organizationId, "task:create");
    const now = Date.now();
    const conversationId = await ctx.db.insert("conversations", {
      organizationId, title: "Nova", kind: "nova", status: "active", createdAt: now, updatedAt: now,
    });
    const welcome = "New thread, same Nova. Your cloud tasks keep running independently, and their live state remains visible beside this conversation.";
    await ctx.db.insert("conversationMessages", { organizationId, conversationId, sender: "nova", content: welcome, status: "sent", createdAt: now });
    await ctx.db.patch(conversationId, { lastMessagePreview: preview(welcome), lastMessageAt: now });
    return conversationId;
  },
});

export const sendToNova = mutation({
  args: { conversationId: v.id("conversations"), content: v.string(), clientMessageId: v.string() },
  returns: v.object({ userMessageId: v.id("conversationMessages"), novaMessageId: v.id("conversationMessages") }),
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    if (!conversation || conversation.status !== "active") throw new Error("Active conversation not found");
    await requireOrganizationPermission(ctx, conversation.organizationId, "task:create");
    const content = args.content.trim();
    if (!content || content.length > MAX_MESSAGE_LENGTH) throw new Error(`Message must contain 1 to ${MAX_MESSAGE_LENGTH} characters`);
    if (!args.clientMessageId.trim() || args.clientMessageId.length > 100) throw new Error("Invalid client message id");
    const replay = await ctx.db.query("conversationMessages")
      .withIndex("by_conversation_client", (q) => q.eq("conversationId", conversation._id).eq("clientMessageId", args.clientMessageId))
      .unique();
    if (replay) {
      const reply = await ctx.db.query("conversationMessages")
        .withIndex("by_conversation_created", (q) => q.eq("conversationId", conversation._id))
        .filter((q) => q.eq(q.field("replyToMessageId"), replay._id))
        .first();
      if (!reply) throw new Error("Message is already being accepted");
      return { userMessageId: replay._id, novaMessageId: reply._id };
    }
    const now = Date.now();
    const userMessageId = await ctx.db.insert("conversationMessages", {
      organizationId: conversation.organizationId,
      conversationId: conversation._id,
      sender: "user",
      content,
      status: "sent",
      clientMessageId: args.clientMessageId,
      createdAt: now,
    });
    const novaMessageId = await ctx.db.insert("conversationMessages", {
      organizationId: conversation.organizationId,
      conversationId: conversation._id,
      sender: "nova",
      content: "",
      status: "generating",
      replyToMessageId: userMessageId,
      createdAt: now + 1,
    });
    await ctx.db.patch(conversation._id, { lastMessagePreview: preview(content), lastMessageAt: now, updatedAt: now });
    await ctx.scheduler.runAfter(0, internal.messagesActions.generateNovaReply, { conversationId: conversation._id, novaMessageId });
    // Asking Nova to build something *is* the request. Quote it now so the person approves a real
    // price instead of being told to press a button; nothing runs until that approval.
    if (detectBuildIntent(content)) {
      await ctx.scheduler.runAfter(0, internal.messagesActions.quoteBuildRequest, {
        conversationId: conversation._id,
        organizationId: conversation.organizationId,
        objective: content,
        idempotencyKey: `conversation:${args.clientMessageId}`,
      });
    }
    return { userMessageId, novaMessageId };
  },
});

export const getReplyContext = internalQuery({
  args: { conversationId: v.id("conversations"), novaMessageId: v.id("conversationMessages") },
  handler: async (ctx, args) => {
    const conversation = await ctx.db.get(args.conversationId);
    const pending = await ctx.db.get(args.novaMessageId);
    if (!conversation || !pending || pending.conversationId !== conversation._id || pending.status !== "generating") return null;
    const [messages, tasks, preferences] = await Promise.all([
      ctx.db.query("conversationMessages").withIndex("by_conversation_created", (q) => q.eq("conversationId", conversation._id)).order("desc").take(30),
      ctx.db.query("tasks").withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId)).order("desc").take(10),
      ctx.db.query("novaPreferences").withIndex("by_organization", (q) => q.eq("organizationId", conversation.organizationId)).unique(),
    ]);
    return { conversation, messages: messages.reverse().filter((message) => message._id !== pending._id), tasks, preferences };
  },
});

export const completeNovaReply = internalMutation({
  args: {
    conversationId: v.id("conversations"), novaMessageId: v.id("conversationMessages"), content: v.string(),
    provider: v.string(), model: v.string(), inputTokens: v.number(), outputTokens: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.novaMessageId);
    if (!pending || pending.conversationId !== args.conversationId || pending.status !== "generating") return null;
    const content = args.content.trim() || "I couldn’t produce a response.";
    const now = Date.now();
    await ctx.db.patch(pending._id, { content, status: "sent", provider: args.provider, model: args.model, inputTokens: args.inputTokens, outputTokens: args.outputTokens });
    await ctx.db.patch(args.conversationId, { lastMessagePreview: preview(content), lastMessageAt: now, updatedAt: now });
    return null;
  },
});

export const failNovaReply = internalMutation({
  args: { conversationId: v.id("conversations"), novaMessageId: v.id("conversationMessages"), message: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const pending = await ctx.db.get(args.novaMessageId);
    if (!pending || pending.conversationId !== args.conversationId || pending.status !== "generating") return null;
    const content = args.message.slice(0, 500);
    const now = Date.now();
    await ctx.db.patch(pending._id, { content, status: "failed" });
    await ctx.db.patch(args.conversationId, { lastMessagePreview: preview(content), lastMessageAt: now, updatedAt: now });
    return null;
  },
});
