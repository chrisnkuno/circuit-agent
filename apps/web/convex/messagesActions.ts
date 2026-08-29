"use node";

import { v } from "convex/values";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { createAgentTurnProvider } from "@circuit-nova/nova-core/providers/factory";
import type { AgentMessage } from "@circuit-nova/nova-core/agent-runtime";
import { startCodingRun } from "./codingRunPlan";

const SYSTEM_PROMPT = `You are Nova inside Circuit Nova's web messenger. Be concise, warm, and operationally honest.
The task list supplied in the system context is authoritative. Never say a task is running in E2B unless its status says running and it has live execution evidence.
Chatting is not authorization to deploy, send, merge, delete, or take any action outside this system. Those always wait for the visible approval controls.
When someone asks you to build or change software, say what you are building in one short sentence and stop. Starting it is not yours to do and not yours to refuse: this system quotes the run and starts it whenever the quote is within the person's automation ceiling. Report status only from the task list — if a sandbox for it is not there yet, say it is being set up, never that it has finished or that it is already producing output.
Never describe yourself as unable to start, run, or execute work, and never say that execution control is unavailable to you. That is false, it reads as a refusal of something the person already asked for twice, and the run is being created while you write. If you have proposed a build and they agree, the work is already under way — acknowledge it, do not re-offer it, and never ask them to press a button.
Never offer a hand-written copy of the code instead of the run.
Ask a clarifying question only when the objective is genuinely unworkable as stated; a reasonable default beats an interrogation. Once you have proposed something concrete, a short yes is an answer — build on it rather than asking again.`;

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
 * Quotes a build the person asked for in conversation. Automation policy either starts the
 * budget-bounded run immediately or leaves it approval-gated; the person is never asked twice.
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
      // This action runs after the browser mutation has committed, so it has no Better Auth
      // identity of its own. The organization was already authenticated and copied from the
      // conversation by sendToNova; re-enter the shared orchestration through its trusted-org
      // path instead of calling the public action and failing auth before a task is created.
      await startCodingRun(ctx, {
        organizationId: args.organizationId,
        objective: args.objective,
        idempotencyKey: args.idempotencyKey,
        authorization: "trusted-organization",
        costApproval: "required",
      });
    } catch (error) {
      // A failed quote must not break the conversation: Nova's own reply still arrives, and the
      // person can start the task from the composer.
      console.error("quoteBuildRequest failed", error);
    }
    return null;
  },
});
