import { z } from "zod";

export const PresetSuggestionSchema = z.object({
  label: z.string().min(1).max(40),
  objective: z.string().min(1).max(240),
});

export const DynamicPresetsSchema = z.object({
  presets: z.array(PresetSuggestionSchema).min(1).max(3),
});

export type PresetSuggestion = z.infer<typeof PresetSuggestionSchema>;

export type PresetContext = {
  hasConnectedRepository: boolean;
  /** Most recent first; the caller decides how many/how far back to include. */
  recentObjectives: string[];
};

/**
 * A stable key that only changes when the context meaningfully changes — the Convex layer
 * uses this to decide whether a cached suggestion set is still valid, so a real model call
 * only happens on an actual context change, not on every terminal load.
 */
export function presetContextKey(context: PresetContext): string {
  const repo = context.hasConnectedRepository ? "repo" : "norepo";
  const recent = context.recentObjectives.slice(0, 5).join("|");
  return `${repo}::${recent}`;
}

export function buildDynamicPresetsPrompt(context: PresetContext): { instructions: string; input: string } {
  const instructions = [
    "You suggest exactly 3 short one-click preset buttons for a coding agent terminal.",
    "Each preset is a { label, objective } pair. label is a short button caption, five words or fewer.",
    "objective is a single imperative sentence the agent will execute literally as a real coding task.",
    context.hasConnectedRepository
      ? "A real repository IS connected — objectives may reference existing code, tests, or checks in it."
      : "No repository is connected — the workspace is empty. Every objective must be fully self-contained (e.g. create a small script or utility from scratch) and must NOT assume any pre-existing code.",
    "Keep every objective concrete, verifiable, and completable in a few minutes.",
  ].join(" ");
  const input = context.recentObjectives.length > 0
    ? `Recent tasks this user already ran, most recent first — suggest different objectives, not near-duplicates:\n${context.recentObjectives.map((objective) => `- ${objective}`).join("\n")}`
    : "This user has no task history yet.";
  return { instructions, input };
}
