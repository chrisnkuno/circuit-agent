/**
 * Live smoke for the Wander pipeline. Skips when EXA_API_KEY is unset.
 * Run: `bunx vitest run lib/wander-live.smoke.test.ts`
 */
import { describe, expect, it } from "vitest";
import { buildCodingPlannerPrompt } from "@circuit-nova/nova-core/coding-prompt";
import { buildStepRequest } from "./coding-step-request";
import { createExaClient } from "@circuit-nova/nova-core/providers/exa";
import {
  buildWanderObjective,
  resolveExecutionSession,
  WANDER_LAB_FILES,
  WANDER_MARKER,
  WANDER_SESSION,
} from "@circuit-nova/nova-core/wander";
import { gatherWanderEvidence, wanderRepositoryContext, wanderTopicHash } from "./wander-research";

const apiKey = process.env.EXA_API_KEY?.trim();

describe.runIf(Boolean(apiKey))("Wander live smoke (Exa + session + planner)", () => {
  it("scouts literature once, injects the briefing, and keeps the 8-minute lab session", async () => {
    const client = createExaClient({ EXA_API_KEY: apiKey });
    expect(client).toBeDefined();

    const topic = "how sleep stages affect memory consolidation";
    const objective = buildWanderObjective(topic);
    const session = resolveExecutionSession(objective);
    expect(session).toEqual(WANDER_SESSION);

    const dossier = await gatherWanderEvidence({ topic, client: client! });
    expect(dossier.exaCalls).toBe(1);
    expect(dossier.sourceCount).toBeGreaterThan(0);
    expect(dossier.briefMarkdown).toMatch(/Literature briefing/i);
    expect(dossier.sources[0]?.url).toMatch(/^https?:\/\//);

    // Same topic within TTL must not spend another Exa call.
    const cached = await gatherWanderEvidence({
      topic,
      client: client!,
      cached: {
        briefMarkdown: dossier.briefMarkdown,
        fetchedAt: dossier.fetchedAt,
        sourceCount: dossier.sourceCount,
        query: dossier.query,
        exaRequestId: dossier.exaRequestId,
      },
    });
    expect(cached.exaCalls).toBe(0);
    expect(wanderTopicHash(topic)).toHaveLength(32);

    // Use a human title that does NOT start with [Wander] — this is what exposed a real bug:
    // title-prefixed objectives must still activate the lab protocol.
    const request = buildStepRequest("Wander daily", objective, "task_smoke", "step_smoke", undefined, dossier.briefMarkdown);
    expect(request.objective.startsWith("[Wander]")).toBe(false);
    expect(request.objective).toContain(WANDER_MARKER);
    expect(request.timeoutMs).toBe(WANDER_SESSION.modelTimeoutMs);
    expect(request.maxOutputTokens).toBe(WANDER_SESSION.maxOutputTokens);
    expect(request.workspaceSeedFiles?.[0]?.path).toBe(WANDER_LAB_FILES.evidence);
    expect(request.repositoryContext).toContain(dossier.sources[0]!.url);

    const prompt = buildCodingPlannerPrompt({
      objective: request.objective,
      repositoryContext: wanderRepositoryContext(dossier.briefMarkdown),
      workspaceRoot: request.workspaceRoot,
      maxCommands: request.maxCommands,
    });
    expect(prompt.instructions).toMatch(/Wander scientific-lab/);
    expect(prompt.instructions).toMatch(/Principal investigator/i);
    expect(prompt.instructions).toMatch(/Methodologist/i);
    expect(prompt.instructions).toMatch(/Rival theorist/i);
    expect(prompt.instructions).toMatch(/Consensus editor/i);
    expect(prompt.instructions).toContain(WANDER_LAB_FILES.hypotheses);
    expect(prompt.instructions).toContain(WANDER_LAB_FILES.consensus);
    expect(prompt.input).toContain(dossier.sources[0]!.url);

    console.log(
      JSON.stringify({
        exaCalls: dossier.exaCalls,
        sourceCount: dossier.sourceCount,
        firstSource: dossier.sources[0]?.title,
        sessionLeaseMin: WANDER_SESSION.claimLeaseMs / 60_000,
        modelTimeoutSec: WANDER_SESSION.modelTimeoutMs / 1000,
        labProtocolInjected: true,
      }),
    );
  }, 30_000);
});
