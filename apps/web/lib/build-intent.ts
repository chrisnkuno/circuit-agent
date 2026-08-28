/**
 * Whether a message is asking Nova to actually build something, rather than to discuss it.
 *
 * Nova used to answer every build request by telling the person to press a button they had
 * already, in effect, pressed. The gate that matters is the priced approval, not a second round
 * of asking: when someone plainly asks for the work, create the priced run and let them approve
 * it. This decides only whether to *quote* the work — money still moves on approval alone.
 */
const BUILD_VERB = /\b(build|create|make|develop|scaffold|implement|write|code)\b/i;
const ARTIFACT = /\b(app|application|website|web ?app|site|dashboard|api|service|script|tool|game|bot|calculator|clone|program)\b/i;
/** Unambiguous "stop asking and do it" phrasing, which needs no artifact noun to be clear. */
const IMPERATIVE = /\b(go ahead|just do it|do it|start it|run it|build it|already|proceed|yes,? build|make it)\b/i;
/** Asking *about* building is a question, not an instruction to spend. */
const ASKING_ABOUT = /^(can|could|would|should|do|does|is|are|what|how|why|which|who|when)\b/i;

export function detectBuildIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (ASKING_ABOUT.test(text) && text.includes("?")) return false;
  if (IMPERATIVE.test(text) && (BUILD_VERB.test(text) || ARTIFACT.test(text))) return true;
  return BUILD_VERB.test(text) && ARTIFACT.test(text);
}
