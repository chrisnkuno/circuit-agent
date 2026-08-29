/**
 * Wander — a small scientific lab that reuses the live coding sandbox worker.
 *
 * Mentality: not a single summarizer, but a group of scientists with conflicting jobs —
 * literature scout (Exa dossier), principal investigator (hypotheses), methodologist,
 * rival theorist, and consensus editor. Discovery is one control-plane Exa search per run
 * (topic-cached); the sandbox has no network and never calls Exa.
 */

export type WanderCadence = "once" | "daily" | "weekly";

export const WANDER_MARKER = "[Wander]";
export const WANDER_OBJECTIVE_MAX = 500;

/** Artifact paths the lab must produce (plus the prefetched evidence dossier). */
export const WANDER_LAB_FILES = {
  evidence: "wander/EVIDENCE.md",
  hypotheses: "wander/HYPOTHESES.md",
  reviewMethods: "wander/REVIEW_METHODS.md",
  reviewRival: "wander/REVIEW_RIVAL.md",
  consensus: "wander/CONSENSUS.md",
  /**
   * The consensus table again, as data.
   *
   * The grades exist in `CONSENSUS.md` as prose, which is right for a person and useless for
   * anything else: charting them meant scraping generated markdown, and a chart built on a regex
   * over model-written prose is a chart that silently empties the first time the editor changes a
   * heading. One extra file the lab writes deliberately is cheaper than that, forever.
   */
  results: "wander/RESULTS.json",
} as const;

/** Curated discovery topics — curious, concrete, and suitable for multi-scientist critique. */
export const WANDER_TOPIC_CATALOG = [
  "why coral reefs bleach and which interventions have the strongest evidence",
  "how mRNA vaccines train immune memory without integrating into DNA",
  "the strongest evidence for and against the hygiene hypothesis",
  "how lithium-ion batteries degrade and what actually extends cycle life",
  "what we know about adult neurogenesis in humans versus rodents",
  "how language models hallucinate and which mitigation techniques hold up",
  "the evidence behind intermittent fasting for metabolic health",
  "how GPS relativity corrections work and why clocks must disagree",
  "what causes antibiotic resistance to spread between bacterial species",
  "how CRISPR off-target effects are measured and bounded in practice",
  "the economics of electricity storage versus transmission upgrades",
  "what paleoclimate records say about current warming rates",
  "how sleep stages affect memory consolidation with current evidence grades",
  "the most robust findings in behavioral genetics of educational attainment",
  "how decentralized identity systems fail closed under key loss",
  "what we can honestly claim about psychedelics for treatment-resistant depression",
  "how bird navigation uses magnetoreception — competing models and evidence",
  "the real limits of carbon capture relative to emissions reduction",
  "how consensus forms in distributed systems under Byzantine faults",
  "what nutrition RCTs actually show about ultra-processed food and satiety",
] as const;

export const WANDER_CADENCE_CRON: Record<Exclude<WanderCadence, "once">, string> = {
  daily: "0 9 * * *",
  weekly: "0 9 * * 1",
};

/**
 * Ideal Wander wall-clock: ~8 minutes (happy path 4–6; hard ceiling ~10 to match Convex actions).
 * Coding stays on the tighter defaults — only Wander objectives use this budget.
 */
/**
 * Session budgets for Wander.
 *
 * The lab plan is a large JSON notebook that routinely takes longer to write than the ~90s a
 * single buffered response survives on the Cloudflare Worker relay. The model call streams, so
 * the deadline that matters is silence (`modelIdleTimeoutMs`), not elapsed time: an 85s total cap
 * killed every run mid-generation and then spent all three attempts rediscovering that.
 */
export const WANDER_SESSION = {
  /** E2B sandbox lifetime: a full eight minutes of lab bench for the notebook step. */
  sandboxRuntimeSeconds: 480,
  /** Step claim / heartbeat lease — must cover model call (no mid-call heartbeat) + sandbox work. */
  claimLeaseMs: 600_000,
  /**
   * Everything the step may spend, model call included, enforced by the worker itself.
   *
   * The whole step runs inside one Convex action, which is killed at 10 minutes with no chance to
   * record an outcome — the run would just lose its lease and retry from nothing. Stopping at 9
   * minutes of our own accord means the lab always gets to keep the notebook it has written so far.
   */
  stepDeadlineMs: 540_000,
  /** Backstop only: a healthy stream finishes well inside this, leaving the bench its eight minutes. */
  modelTimeoutMs: 120_000,
  /** Tokens must keep arriving; this much silence means the call is gone, not slow. */
  modelIdleTimeoutMs: 45_000,
  // DeepSeek V4 Flash shares reasoning and visible JSON in one output budget. Ten thousand can
  // expire while it is still thinking, before a valid plan exists for the sandbox to execute.
  maxOutputTokens: 24_000,
  maxCommands: 8,
  // "medium" routinely overruns the relay ceiling on lab-sized JSON plans; structure carries the quality.
  reasoningEffort: "low" as const,
} as const;

/**
 * Everyday coding-step budgets.
 *
 * The clock here is sized around `maxOutputTokens`, not the other way round: plan and build run
 * serially inside one Convex action that dies at ten minutes, so the allowance a plan can actually
 * spend is whatever streams before the sandbox still gets its bench time.
 */
export const CODING_SESSION = {
  /** Sandbox lifetime, sized so model backstop + bench time still fit `stepDeadlineMs`. */
  sandboxRuntimeSeconds: 240,
  claimLeaseMs: 600_000,
  /** Self-enforced stop, safely inside the 10-minute Convex action that runs the whole step. */
  stepDeadlineMs: 540_000,
  /**
   * Backstop for the whole call, not a target: a small plan still returns in seconds.
   *
   * This must be large enough to actually stream `maxOutputTokens` at a pessimistic rate,
   * otherwise the token budget is unreachable and every large plan fails on the clock instead of
   * on its merits. `modelIdleTimeoutMs` — not this — is what detects a genuinely dead stream.
   */
  modelTimeoutMs: 300_000,
  /** Tokens must keep arriving; this much silence means the call is gone, not slow. */
  modelIdleTimeoutMs: 45_000,
  // Reasoning models spend from this allowance before emitting the plan JSON. The former 8K cap
  // truncated a small REST API plan, and 16K still truncated a detailed webhook API plan on
  // DeepSeek V4 Flash, so neither request ever reached its sandbox.
  maxOutputTokens: 32_000,
  maxCommands: 6,
  reasoningEffort: "low" as const,
} as const;

/**
 * Pessimistic streaming rate used to check a session's token budget against its own clock.
 *
 * Well below observed relay throughput on purpose: this exists to catch a budget raised without
 * the timeout that would let it finish, which is exactly how a 32K allowance behind a 90s
 * backstop silently became "every detailed plan times out and burns its lease".
 */
export const MIN_PLAN_STREAM_TOKENS_PER_SECOND = 120;

/** True when a session can actually stream its whole output allowance before the backstop fires. */
export function tokenBudgetFitsModelTimeout(session: {
  maxOutputTokens: number;
  modelTimeoutMs: number;
}): boolean {
  return session.maxOutputTokens / MIN_PLAN_STREAM_TOKENS_PER_SECOND <= session.modelTimeoutMs / 1_000;
}

export type ExecutionSessionBudgets = {
  sandboxRuntimeSeconds: number;
  claimLeaseMs: number;
  modelTimeoutMs: number;
  modelIdleTimeoutMs: number;
  stepDeadlineMs: number;
  maxOutputTokens: number;
  maxCommands: number;
  reasoningEffort: "low" | "medium";
};

/** Pick step-runtime budgets from the run objective. */
export function resolveExecutionSession(objective: string): ExecutionSessionBudgets {
  return isWanderObjective(objective) ? { ...WANDER_SESSION } : { ...CODING_SESSION };
}

/**
 * True when this run is a Wander lab. Matches the marker at the start or after a task-title
 * prefix — `buildStepRequest` concatenates `title. objective`, and titles like "Wander daily"
 * must not strip the lab protocol from the planner.
 */
export function isWanderObjective(objective: string): boolean {
  return objective.includes(WANDER_MARKER);
}

/** Schedule placeholder whose topic is chosen when the occurrence is claimed. */
export function isWanderRandomScheduleObjective(objective: string): boolean {
  return /^\[Wander\]\s+cadence=(daily|weekly)\s+topic=random\s*$/i.test(objective.trim());
}

export function buildWanderScheduleObjective(cadence: Exclude<WanderCadence, "once">): string {
  return `${WANDER_MARKER} cadence=${cadence} topic=random`;
}

/** Deterministic topic pick so a given schedule occurrence is reproducible. */
export function pickWanderTopic(seed = `${Date.now()}`): string {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const index = Math.abs(hash) % WANDER_TOPIC_CATALOG.length;
  return WANDER_TOPIC_CATALOG[index];
}

/**
 * Bounded objective stored on the task/run. The fuller lab protocol is injected into
 * the coding planner when `isWanderObjective` is true (lib/coding-prompt.ts), so this string
 * stays inside the 500-character orchestration limit.
 */
export function buildWanderObjective(topic: string): string {
  const clean = topic.trim().replace(/\s+/g, " ");
  if (!clean) throw new Error("Wander topic is required");
  const clipped = clean.slice(0, 140);
  const body = `${WANDER_MARKER} Topic: ${clipped}. Scientific lab: ground in wander/EVIDENCE.md; PI→HYPOTHESES.md; methodologist→REVIEW_METHODS.md; rival theorist→REVIEW_RIVAL.md; editor→CONSENSUS.md grading verified|strong_plausible|speculative.`;
  if (body.length > WANDER_OBJECTIVE_MAX) throw new Error(`Wander objective exceeds ${WANDER_OBJECTIVE_MAX} characters`);
  return body;
}

/** Resolves a stored schedule marker into a concrete topic objective for this occurrence. */
export function expandWanderObjective(objective: string, seed: string): string {
  if (isWanderRandomScheduleObjective(objective)) return buildWanderObjective(pickWanderTopic(seed));
  return objective;
}

/**
 * Extra planner instructions — only attached when the step's objective is a Wander run.
 * Written as a lab of distinct scientists so the model does not collapse into one bland summary.
 */
export function wanderPlannerInstructions(): string[] {
  return [
    "This is a Wander scientific lab, not a software-change task and not a single-author blog post.",
    "Role-play a small research group. Each notebook file is written in a different scientific voice with a different job. Do not let the PI, methodologist, rival, and editor agree politely — disagreement is the point.",
    "The sandbox has no network. Do not fetch URLs, install packages, or call external APIs. Literature discovery already happened once on the control plane via Exa; the briefing is in repository context and at wander/EVIDENCE.md (seeded for you — do not overwrite it).",
    "Lab protocol (write each file as that scientist; sign the top of each file with the role name):",
    "1) Literature scout (already done): treat wander/EVIDENCE.md as the only citable primary briefing. Map coverage gaps before anyone theorizes.",
    "2) Principal investigator → wander/HYPOTHESES.md (≤ ~800 words): pose sharp research questions, working hypotheses, proposed mechanisms, and what observation would falsify each claim. Prefer risky, testable claims over safe vagueness.",
    "3) Methodologist → wander/REVIEW_METHODS.md (≤ ~600 words): independent peer review focused on methods — study design, measurement validity, sample/power, confounders, p-hacking/publication bias, and whether the Exa highlights actually support the PI's leaps. Be harsh; cite EVIDENCE.md URLs when rejecting a claim.",
    "4) Rival theorist → wander/REVIEW_RIVAL.md (≤ ~600 words): a second independent scientist with a competing stance — alternative mechanisms, selection effects, boundary conditions, and results that would favor the rival view. Do not repeat the methodologist; attack substance and interpretation.",
    "5) Consensus editor → wander/CONSENSUS.md (≤ ~1000 words plus a short claim table): reconcile the lab after reading all prior files. For every retained claim use exactly one grade: verified (supported by the Exa dossier or uncontroversial textbook mechanism), strong_plausible (good evidence but contested/incomplete), or speculative (interesting, weakly supported). Include explicit unknowns and the next experiment or observation that would upgrade each open claim.",
    `6) Consensus editor, same pass → ${"wander/RESULTS.json"}: the same claim table as data, so it can be charted without re-reading prose. Exactly this shape: {"topic": string, "claims": [{"claim": string (≤ 160 chars), "grade": "verified" | "strong_plausible" | "speculative"}], "unknowns": [string]}. Valid JSON, no comments, no trailing prose, and every grade one of the three words. It must agree with CONSENSUS.md — it is the same table, not a second opinion.`,
    "Time budget: the bench is yours for about eight minutes, so a few substantial commands are fine — but the step stops itself before its host would, and anything still running is lost.",
    "Length discipline: this is a short lab session, not a monograph. Keep each notebook file inside its word cap. Prefer a compact plan JSON — long reasoning before the JSON risks aborting the model call.",
    "Epistemic rules: never invent citations, DOIs, quotes, statistics, or study results. Cite only URLs present in wander/EVIDENCE.md. If the dossier is thin, say so and keep most claims speculative. Fewer precise claims beat encyclopedic hedging.",
    "Between roles: re-read the previous scientist's file before writing the next; carry forward only what survived critique.",
    "Do not write wander/REPORT.html yourself — the control plane harvests a print-ready report from these notebook files after the step succeeds.",
    "Verification may be a short python/node script that checks EVIDENCE.md, HYPOTHESES.md, REVIEW_METHODS.md, REVIEW_RIVAL.md, CONSENSUS.md and RESULTS.json exist, that CONSENSUS.md contains the three grade labels, and that RESULTS.json parses and every claim carries one of the three grades — not an application test suite.",
  ];
}

/** The three grades the lab may award, strongest first — the order every chart of them uses. */
export const WANDER_GRADES = ["verified", "strong_plausible", "speculative"] as const;
export type WanderGrade = typeof WANDER_GRADES[number];

export type WanderClaim = { claim: string; grade: WanderGrade };
export type WanderResults = { topic: string; claims: WanderClaim[]; unknowns: string[] };

function isGrade(value: unknown): value is WanderGrade {
  return typeof value === "string" && (WANDER_GRADES as readonly string[]).includes(value);
}

/**
 * Reads `RESULTS.json` if the lab wrote one that means anything.
 *
 * Tolerant of everything except the part that would make a chart lie. A missing `unknowns`, a
 * claim without text, an extra field, a topic that is not a string — all survivable, and each is
 * dropped or defaulted. A claim whose grade is not one of the three is *dropped*, never coerced:
 * inventing a grade for it would put a bar on the chart that no scientist awarded.
 *
 * Returns `null` rather than an empty result when there is nothing usable, so a caller can tell
 * "the lab graded nothing" apart from "the lab wrote no file".
 */
export function parseWanderResults(source: string): WanderResults | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const value = parsed as Record<string, unknown>;
  const claims = Array.isArray(value.claims)
    ? value.claims.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const item = entry as Record<string, unknown>;
        if (!isGrade(item.grade) || typeof item.claim !== "string" || !item.claim.trim()) return [];
        return [{ claim: item.claim.trim(), grade: item.grade }];
      })
    : [];
  if (claims.length === 0) return null;
  return {
    topic: typeof value.topic === "string" ? value.topic : "",
    claims,
    unknowns: Array.isArray(value.unknowns) ? value.unknowns.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "") : [],
  };
}

/** How many claims landed on each grade, in `WANDER_GRADES` order and including the empty ones. */
export function wanderGradeCounts(results: WanderResults): Array<{ grade: WanderGrade; count: number }> {
  return WANDER_GRADES.map((grade) => ({ grade, count: results.claims.filter((claim) => claim.grade === grade).length }));
}
