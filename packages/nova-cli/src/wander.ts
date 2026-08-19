import {
  parseWanderResults,
  wanderGradeCounts,
  WANDER_GRADES,
  type WanderResults,
  buildWanderObjective,
  buildWanderScheduleObjective,
  isWanderRandomScheduleObjective,
  pickWanderTopic,
  wanderPlannerInstructions,
  WANDER_LAB_FILES,
  WANDER_MARKER,
  type WanderCadence,
} from "@circuit-nova/nova-core/wander";
import type { ExaSearchClient, ExaSearchHit } from "@circuit-nova/nova-core/providers/exa";
import type { Expense } from "@circuit-nova/nova-core/nova-cli/cost";
import { barChart } from "./charts";
import { heading, note, panel, type SectionStyle } from "./sections";

/**
 * Wander, from the terminal.
 *
 * The protocol — the topics, the lab roles, the grading vocabulary — already lives in the core
 * package, where the hosted worker drives it. Nothing here reimplements it; this is the missing
 * connection between that protocol and a CLI that could not reach it.
 *
 * The one thing the terminal must add is evidence. The lab's rule is that it may cite only what is
 * in `wander/EVIDENCE.md`, and the sandbox has no network, so the search happens out here, once,
 * before the agent starts. Without that step the lab has nothing to ground on and every claim it
 * makes is speculation with a citation shape.
 */

export type WanderCommand =
  | { kind: "once"; topic: string; random: boolean }
  | { kind: "schedule"; cadence: Exclude<WanderCadence, "once">; topic?: string }
  | { kind: "invalid"; reason: string };

/**
 * Parses `/wander`, `/wander <topic>`, `/wander random`, `/wander daily [topic]`.
 *
 * A bare `/wander` picks a curated topic rather than erroring, because the command is for the times
 * someone wants to explore *something* and asking them to name it first defeats the point.
 */
export function parseWanderCommand(input: string, seed = `${Date.now()}`): WanderCommand | null {
  const match = /^\/wander(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const rest = (match[1] ?? "").trim().replace(/\s+/g, " ");

  if (!rest || rest.toLowerCase() === "random") return { kind: "once", topic: pickWanderTopic(seed), random: true };

  const scheduled = /^(daily|weekly)(?:\s+([\s\S]+))?$/i.exec(rest);
  if (scheduled) {
    const cadence = scheduled[1].toLowerCase() as Exclude<WanderCadence, "once">;
    const topic = scheduled[2]?.trim();
    return { kind: "schedule", cadence, ...(topic && topic.toLowerCase() !== "random" ? { topic } : {}) };
  }

  // Guard the shape the objective builder enforces anyway, so the message names the problem rather
  // than surfacing a length error from three layers down.
  if (rest.length > 140) return { kind: "invalid", reason: "Topic is too long — keep it under 140 characters." };
  return { kind: "once", topic: rest, random: false };
}

export type WanderEvidence = {
  markdown: string;
  hits: ExaSearchHit[];
  /** What the search cost, for the ledger. Absent when no search ran. */
  expense?: Expense;
};

/**
 * Builds the dossier the lab is allowed to cite.
 *
 * Deliberately returns a usable document even with no results and no search client: a Wander run
 * with a thin dossier is supposed to grade its claims as speculative and say the evidence was thin,
 * which is a real outcome. Refusing to start would just hide that.
 */
export async function gatherWanderEvidence(topic: string, search: ExaSearchClient | undefined, numResults = 8): Promise<WanderEvidence> {
  if (!search) {
    return {
      markdown: evidenceDocument(topic, [], "No search provider is configured (set EXA_API_KEY), so this lab has no external briefing."),
      hits: [],
    };
  }

  let hits: ExaSearchHit[] = [];
  let note: string | undefined;
  try {
    // Highlights at their default quality: a lab briefing is read, not skimmed for one fact, and
    // Exa documents the bare `true` as the better setting than any explicit character cap.
    const response = await search.search({ query: topic, numResults, type: "auto" });
    hits = response.results;
  } catch (error) {
    note = `Literature search failed (${error instanceof Error ? error.message : "unknown error"}). Treat every claim below as unsupported.`;
  }

  return {
    markdown: evidenceDocument(topic, hits, note),
    hits,
    ...(note ? {} : {
      expense: {
        provider: "exa",
        meter: "search",
        quantities: { request: 1, contents: hits.length },
        label: `wander evidence: ${topic.length > 40 ? `${topic.slice(0, 39)}…` : topic}`,
      } satisfies Expense,
    }),
  };
}

function evidenceDocument(topic: string, hits: readonly ExaSearchHit[], note?: string): string {
  const lines = [
    "# Literature scout — evidence dossier",
    "",
    `Topic: ${topic}`,
    `Gathered: ${new Date().toISOString()}`,
    "",
    // Stated in the file itself, not only in the prompt: this is the document the later roles read
    // directly, and the constraint has to travel with it.
    "Only the URLs in this file may be cited. Do not invent citations, DOIs, quotes or statistics.",
    "",
  ];
  if (note) lines.push(`> ${note}`, "");
  if (hits.length === 0) {
    lines.push("No sources were retrieved. Grade essentially every claim as speculative and say so plainly.");
  } else {
    for (const [index, hit] of hits.entries()) {
      lines.push(`## [${index + 1}] ${hit.title}`, "", hit.url, "");
      if (hit.publishedDate || hit.author) lines.push(`${[hit.author, hit.publishedDate].filter(Boolean).join(" · ")}`, "");
      for (const highlight of hit.highlights.slice(0, 3)) lines.push(`> ${highlight.replace(/\s+/g, " ").trim()}`, "");
    }
  }
  return lines.join("\n");
}

/**
 * The turn text for a Wander run.
 *
 * The lab protocol rides in the prompt rather than the system prompt because it applies to exactly
 * one turn. Putting it in the system prompt would leave the agent role-playing a research group for
 * the rest of the session, and would invalidate the prompt cache for every ordinary turn after it.
 */
export function buildWanderPrompt(topic: string, evidencePath: string = WANDER_LAB_FILES.evidence): string {
  return [
    buildWanderObjective(topic),
    "",
    `The evidence dossier has already been written to ${evidencePath}. Read it first. Do not overwrite it.`,
    "",
    ...wanderPlannerInstructions(),
  ].join("\n");
}

/** The files a completed lab should have produced, for reporting what actually landed. */
export function wanderArtifacts(): string[] {
  return Object.values(WANDER_LAB_FILES);
}

/**
 * What a durable Wander job stores as its objective.
 *
 * A named topic is written down literally, so every occurrence of a daily "coral reefs" job keeps
 * exploring coral reefs. A schedule with no topic stores the schedule marker itself rather than a
 * topic picked once at creation time — the point of "random" is a fresh curiosity each occurrence,
 * and picking once up front would make every future run explore whatever today happened to pick.
 */
export function wanderJobObjective(command: { cadence: Exclude<WanderCadence, "once">; topic?: string }): string {
  return command.topic ? `${WANDER_MARKER} ${command.topic}` : buildWanderScheduleObjective(command.cadence);
}

/**
 * Resolves a stored job objective to the topic this occurrence should explore.
 *
 * The `seed` should vary per occurrence (include a timestamp, not just the job id, which stays
 * constant across every firing of a recurring job) — a fixed seed would make "random" pick the same
 * topic forever, which defeats the reason someone chose it over naming one.
 */
export function resolveWanderJobTopic(objective: string, seed: string): string {
  if (isWanderRandomScheduleObjective(objective)) return pickWanderTopic(seed);
  return objective.replace(WANDER_MARKER, "").trim();
}

/**
 * What the lab concluded, as a chart rather than a paragraph.
 *
 * A wander run produces five files of prose, and the one question a person asks first — did this
 * find anything, or is it all speculation — is answered by three numbers buried in the last one.
 * The bars answer it in a glance, and the claims under them say what was actually graded, which is
 * the part a summary of a summary would lose.
 *
 * Reads the structured `RESULTS.json` the lab writes, never the prose: a chart scraped out of
 * model-written markdown is a chart that empties itself the first time a heading changes.
 */
export function renderWanderResults(source: string, style: SectionStyle, width: number): string | null {
  const results = parseWanderResults(source);
  if (!results) return null;
  return renderWanderChart(results, style, width);
}

export function renderWanderChart(results: WanderResults, style: SectionStyle, width: number): string {
  const counts = wanderGradeCounts(results);
  const bars = barChart(
    counts.map(({ grade, count }) => ({ label: grade.replace("_", " "), value: count })),
    // A fixed ceiling of the total, so the three bars are read against the whole lab rather than
    // against whichever grade happened to win: "two of nine verified" is the finding, and bars
    // scaled to their own maximum would draw that as a full bar.
    { width: Math.max(24, Math.min(width, 72)), depth: style.depth, glyphs: style.glyphs, max: results.claims.length },
  );
  const strongest = WANDER_GRADES.find((grade) => counts.find((entry) => entry.grade === grade)?.count);
  const lines = [
    ...bars,
    "",
    ...results.claims
      .slice()
      .sort((left, right) => WANDER_GRADES.indexOf(left.grade) - WANDER_GRADES.indexOf(right.grade))
      .map((claim) => `${claim.grade === strongest ? "•" : "·"} ${claim.claim}`),
    ...(results.unknowns.length > 0 ? ["", `still unknown: ${results.unknowns.join("; ")}`] : []),
  ];
  return [
    heading(results.topic || "wander", 2, style),
    panel(lines, style, { title: `${results.claims.length} claim${results.claims.length === 1 ? "" : "s"}`, tone: "accent" }),
  ].join("\n");
}
