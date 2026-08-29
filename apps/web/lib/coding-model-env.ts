/**
 * Which model the sandbox planner runs on, as distinct from the one the conversation runs on.
 *
 * They have opposite cost shapes. A chat turn sends a long-ish prompt and gets a short answer, so
 * its bill is dominated by input tokens. A coding plan sends a short prompt and returns a large
 * structured document, so its bill is dominated by output tokens. One deployment-wide model has to
 * be wrong for one of them, which is what `CODING_MODEL_ID` exists to fix.
 *
 * Precedence, most specific first: what a workspace explicitly chose, then the deployment's
 * coding-only override, then the provider's own default.
 */
export type CodingModelSelection = { provider?: string; modelId?: string };

/** The env var each provider reads its model id from. */
const MODEL_VAR: Record<string, string> = {
  openai: "OPENAI_MODEL",
  circuitnotion: "CIRCUITNOTION_MODEL",
};

export function applyCodingModelEnv(
  base: Record<string, string | undefined>,
  selection: CodingModelSelection = {},
): Record<string, string | undefined> {
  const env = { ...base };
  if (selection.provider) env.CODING_MODEL_PROVIDER = selection.provider;

  const provider = env.CODING_MODEL_PROVIDER;
  const variable = provider ? MODEL_VAR[provider] : undefined;
  if (!variable) return env;

  // A workspace's own choice is never overridden by a deployment default.
  const chosen = selection.modelId?.trim();
  if (chosen && selection.provider === provider) {
    env[variable] = chosen;
    return env;
  }
  const codingDefault = base.CODING_MODEL_ID?.trim();
  if (codingDefault) env[variable] = codingDefault;
  return env;
}
