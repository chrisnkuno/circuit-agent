"use node";

import { v } from "convex/values";
import { action } from "./_generated/server";
import { internal, api } from "./_generated/api";
import { presetContextKey } from "../lib/dynamic-presets";
import { createDynamicPresetsProvider } from "../lib/providers/factory";

const presetValidator = v.object({ label: v.string(), objective: v.string() });

/**
 * Regenerates the terminal's preset suggestions only when the context actually changed since
 * the last call — repo-connection state and recent objectives are re-derived server-side from
 * the same permission-checked queries the client already trusts (tasks.listRecent,
 * githubModel.listForOrganization), so this never trusts client-supplied context. Returns
 * `{ presets: null }` rather than throwing whenever the feature isn't configured or the model
 * call fails, since this is a cosmetic suggestion, not billed agent work — the terminal falls
 * back to its static presets in that case.
 */
export const generate = action({
  args: { organizationId: v.id("organizations") },
  returns: v.object({ presets: v.union(v.array(presetValidator), v.null()) }),
  handler: async (ctx, { organizationId }): Promise<{ presets: { label: string; objective: string }[] | null }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Unauthenticated");

    const [tasks, installations] = await Promise.all([
      ctx.runQuery(api.tasks.listRecent, { organizationId }),
      ctx.runQuery(api.githubModel.listForOrganization, { organizationId }),
    ]);
    const hasConnectedRepository = installations.some((installation) => installation.status === "connected");
    const recentObjectives = tasks.slice(0, 5).map((task) => task.title);
    const contextKey = presetContextKey({ hasConnectedRepository, recentObjectives });

    const cached = await ctx.runQuery(internal.terminalPresets.getCachedInternal, { organizationId });
    if (cached && cached.contextKey === contextKey) return { presets: cached.presets };

    const provider = createDynamicPresetsProvider(process.env as Record<string, string | undefined>);
    if (!provider) return { presets: null };

    try {
      const presets = await provider.generate({ hasConnectedRepository, recentObjectives });
      await ctx.runMutation(internal.terminalPresets.upsertCache, { organizationId, contextKey, presets });
      return { presets };
    } catch (error) {
      console.error("dynamic preset generation failed", error);
      return { presets: null };
    }
  },
});
