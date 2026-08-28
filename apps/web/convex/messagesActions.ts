"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { api } from "./_generated/api";
import { internal } from "./_generated/api";
import { createAgentTurnProvider } from "@circuit-nova/nova-core/providers/factory";
import type { AgentMessage } from "@circuit-nova/nova-core/agent-runtime";

const SYSTEM_PROMPT = `You are Nova inside Circuit Nova's web messenger. Be concise, warm, and operationally honest.
The task list supplied in the system context is authoritative. Never say a task is running in E2B unless its status says running and it has live execution evidence.
Chatting is not authorization to deploy, send, merge, delete, or take any action outside this system. Those always wait for the visible approval controls.
When someone asks you to build or change software, a cloud sandbox is quoted and, if the quote is within their automation ceiling, started immediately — say what you are building in one short sentence, and say it is already running. Only a quote above their ceiling waits for approval; say that instead when it happens. Never tell them to press a button for work they already asked for, and never offer a hand-written copy of the code instead of the run.
Ask a clarifying question only when the objective is genuinely unworkable as stated; a reasonable default beats an interrogation.`;

export const generateNovaReply = internalAction({
  args: { conversationId: v.id("conversations"), novaMessageId: v.id("conversationMessages") },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const context = await ctx.runQuery(internal.messages.getReplyContext, args);
    if (!context) return null;
    const env = process.env as Record<string, string | undefined>;
    const selectedProvider = context.preferences?.provider === "deployment" || !context.preferences?.provider
      ? undefined
      : context.preferences.provider;
    const provider = createAgentTurnProvider(env, selectedProvider, context.preferences?.modelId);
    if (!provider) {
      await ctx.runMutation(internal.messages.failNovaReply, {
        ...args,
        message: "Nova messaging is connected to the durable conversation, but its model provider is not configured on this deployment yet.",
      });
      return null;
    }
    const taskContext = context.tasks.length === 0
      ? "No cloud tasks exist for this workspace."
      : context.tasks.map((task) => `- ${task.title}: ${task.status}; spent ${task.spentRwf.toString()} of ${task.maxRwf.toString()} RWF`).join("\n");
    const messages: AgentMessage[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\nCurrent cloud task snapshot:\n${taskContext}` },
      ...context.messages
        .filter((message) => context.preferences?.memoryEnabled !== false || message._id === context.messages.at(-1)?._id)
        .filter((message) => message.sender === "user" || (message.sender === "nova" && message.status === "sent"))
        .map((message): AgentMessage => ({ role: message.sender === "user" ? "user" : "assistant", content: message.content })),
    ];
    try {
      const turn = await provider.complete({
        messages,
        tools: [],
        maxOutputTokens: 900,
        safetyIdentifier: `conversation-${context.conversation.organizationId}`,
        effort: "low",
      });
      const content = turn.refusal?.trim() || turn.content.trim() || "I couldn’t produce a response.";
      await ctx.runMutation(internal.messages.completeNovaReply, {
        ...args,
        content,
        provider: selectedProvider ?? env.CODING_MODEL_PROVIDER ?? "unknown",
        model: turn.model,
        inputTokens: turn.usage.inputTokens,
        outputTokens: turn.usage.outputTokens,
      });
    } catch (error) {
      await ctx.runMutation(internal.messages.failNovaReply, {
        ...args,
        message: `Nova could not answer right now: ${error instanceof Error ? error.message.slice(0, 360) : "provider request failed"}`,
      });
    }
    return null;
  },
});


/**
 * Quotes a build the person asked for in conversation. This creates a priced, approval-gated run —
 * it never starts execution, so the money gate is untouched; it only removes the second ask.
 */
export const quoteBuildRequest = internalAction({
  args: {
    conversationId: v.id("conversations"),
    organizationId: v.id("organizations"),
    objective: v.string(),
    idempotencyKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    try {
      await ctx.runAction(api.terminalRuns.startLiveCodingRun, {
        organizationId: args.organizationId,
        objective: args.objective,
        idempotencyKey: args.idempotencyKey,
      });
    } catch (error) {
      // A failed quote must not break the conversation: Nova's own reply still arrives, and the
      // person can start the task from the composer.
      console.error("quoteBuildRequest failed", error);
    }
    return null;
  },
});
