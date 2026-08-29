/**
 * Whether an exchange is asking Nova to actually build something, and what it is being asked for.
 *
 * Nova cannot start a run itself; a quote is created by the control plane when this says the
 * person asked for the work. So when this misses, Nova has nothing to point at and rationalises
 * the silence — telling someone "I can't start the sandbox from this thread" for work they had
 * just asked for twice.
 *
 * The failure that drove this rewrite was reading one message at a time. A real request is built
 * up over several turns and confirmed with two words:
 *
 *     person: a simple api of your choosing
 *     Nova:   I'll build a small FastAPI in-memory notes API ... Estimated sandbox quote: $0.02.
 *     person: go ahead and start
 *
 * Neither of those messages carries the request on its own. Together they are unmistakable, so
 * the last thing Nova said is part of the input.
 */

const BUILD_VERB = /\b(build|create|make|develop|scaffold|implement|write|code|generate|set up|spin up)\b/i;
const ARTIFACT = /\b(app|application|website|web ?app|site|page|dashboard|api|endpoint|service|server|script|tool|game|bot|calculator|clone|program|cli|library)\b/i;
/** Unambiguous "stop asking and do it" phrasing, which needs no artifact noun to be clear. */
const IMPERATIVE = /\b(go ahead|just do it|do it|start it|run it|build it|already|proceed|yes,? build|make it)\b/i;
/** Asking *about* building is a question, not an instruction to spend. */
const ASKING_ABOUT = /^(can|could|would|should|do|does|is|are|what|how|why|which|who|when)\b/i;

/**
 * A short reply that means "yes, that one". Anchored to the whole message: "go" is agreement,
 * "go through the options again" is not.
 */
const AFFIRMATION = /^(y|ye|yes|yep|yeah|yup|ok|okay|k|sure|please|please do|do it|go|go ahead|go for it|start|start it|run it|begin|proceed|continue|sounds good|looks good|perfect|great|do that|that one|build it|make it|ship it|lets go|let's go)\b/i;
/** A reply that agrees and then adds a condition is still an agreement to build. */
const DISAGREEMENT = /\b(no|not|don't|dont|stop|wait|hold on|cancel|instead|actually|nevermind|never mind)\b/i;

/** Nova stating what it is about to build. Its own quote line is the strongest signal. */
const NOVA_PROPOSAL = /\b(i['’]?ll|i will|i can|let me|i'?d)\b[^.!?]{0,80}\b(build|create|make|implement|scaffold|write|generate|set up|spin up)\b/i;
const NOVA_QUOTE = /\b(sandbox quote|estimated (sandbox )?quote|quoted at)\b/i;

/** Whether Nova's last message put a concrete build on the table for the person to accept. */
export function proposesBuild(novaMessage: string | undefined): boolean {
  if (!novaMessage?.trim()) return false;
  return NOVA_QUOTE.test(novaMessage) || NOVA_PROPOSAL.test(novaMessage);
}

/** Whether a reply accepts what was just proposed, rather than redirecting it. */
export function acceptsProposal(message: string): boolean {
  const text = message.trim();
  if (!text || text.length > 200) return false;
  if (DISAGREEMENT.test(text)) return false;
  return AFFIRMATION.test(text);
}

/** Whether a single message asks for the work on its own terms. */
export function detectBuildIntent(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (ASKING_ABOUT.test(text) && text.includes("?")) return false;
  if (IMPERATIVE.test(text) && (BUILD_VERB.test(text) || ARTIFACT.test(text))) return true;
  return BUILD_VERB.test(text) && ARTIFACT.test(text);
}

/**
 * The objective to quote, or null when nothing was asked for.
 *
 * When the trigger is an acceptance, the objective is Nova's proposal rather than the person's
 * reply: "go ahead and start" describes nothing a planner could act on, while the sentence it
 * agrees with says exactly what to build.
 */
export function resolveBuildRequest(input: { message: string; priorNovaMessage?: string }): { objective: string; from: "message" | "acceptance" } | null {
  const message = input.message.trim();
  if (!message) return null;
  if (detectBuildIntent(message)) return { objective: message, from: "message" };
  if (proposesBuild(input.priorNovaMessage) && acceptsProposal(message)) {
    return { objective: input.priorNovaMessage!.trim(), from: "acceptance" };
  }
  return null;
}
