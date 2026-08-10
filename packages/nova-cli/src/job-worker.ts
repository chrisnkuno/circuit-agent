import os from "node:os";
import { NovaAgent, type NovaEvent } from "@circuit-nova/nova-core/nova-cli/agent";
import type { ApprovalPrompt } from "@circuit-nova/nova-core/nova-cli/permissions";
import { loadSession } from "@circuit-nova/nova-core/nova-cli/session";
import { LocalWorkspace, type NovaWorkspace } from "@circuit-nova/nova-core/nova-cli/backends";
import type { AgentTurnProvider } from "@circuit-nova/nova-core/agent-runtime";
import type { ModelPriceCatalog } from "@circuit-nova/nova-core/model-cost";
import type { ExaSearchClient } from "@circuit-nova/nova-core/providers/exa";
import { isWanderObjective, WANDER_LAB_FILES } from "@circuit-nova/nova-core/wander";
import {
  appendJobLog,
  claimJob,
  consumeJobApproval,
  finishJob,
  getJob,
  heartbeatJob,
  requestJobApproval,
  type Job,
} from "@circuit-nova/nova-core";
import { describeToolCall, summarizeToolResult } from "./transcript";
import { buildWanderPrompt, gatherWanderEvidence, resolveWanderJobTopic } from "./wander";

/**
 * The process that actually does the work once a job has been handed to it.
 *
 * Everything above this file — the store, the state machine — exists so that a job survives its
 * worker dying. This file is the worker: it claims one job, runs the same `NovaAgent` the
 * interactive CLI runs, and reports back through the same store. Nothing about the agent loop is
 * reimplemented; a fix or a regression in how Nova executes a turn applies identically whether the
 * turn is being watched or not.
 */

export function workerId(hostname = os.hostname(), pid = process.pid): string {
  return `${hostname}:${pid}`;
}

export const DEFAULT_LEASE_MS = 4 * 60_000;
export const DEFAULT_HEARTBEAT_MS = Math.floor(DEFAULT_LEASE_MS / 3);
export const DEFAULT_APPROVAL_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_APPROVAL_POLL_MS = 3_000;

export const CONTINUATION_OBJECTIVE =
  "Continue the work from where the session left off. Check the current state of the workspace before assuming anything is still pending — some of it may already be done.";

/**
 * Turns a pending approval into a decision, without a person at this terminal.
 *
 * The request is written to the job so `/jobs` and `/attach` can show it, then this waits — polling
 * rather than blocking on an event, because the decision is written by an entirely different
 * process and a file is the only channel the two share. Silence past the timeout resolves to deny:
 * of the two ways an unanswered request can fail safe, refusing the action is the one a human can
 * always retry, where a default allow cannot be undone.
 */
export function detachedApprovalPrompt(options: {
  root: string;
  jobId: string;
  ownerId: string;
  pollMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): ApprovalPrompt {
  const pollMs = options.pollMs ?? DEFAULT_APPROVAL_POLL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async (request) => {
    await requestJobApproval(options.root, options.jobId, options.ownerId, { summary: request.summary, toolName: request.tool.name });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await sleep(pollMs);
      const decision = await consumeJobApproval(options.root, options.jobId, options.ownerId);
      if (decision) return decision;
      if (Date.now() >= deadline) return "deny";
    }
  };
}

export type JobLogState = { pendingText: string };

export function emptyJobLogState(): JobLogState {
  return { pendingText: "" };
}

/**
 * One `NovaEvent` in, zero or more finished log lines out.
 *
 * Kept as an explicit state transition — not a class with hidden fields — for the same reason
 * `advancePalette` is: the buffering logic (hold assistant text until a natural boundary, then
 * flush it as one line) is worth being able to feed events at directly in a test, without standing
 * up an agent or a filesystem to prove it groups correctly.
 */
export function stepJobLog(state: JobLogState, event: NovaEvent): { state: JobLogState; lines: string[] } {
  const flush = (): string[] => (state.pendingText.trim() ? [`» ${state.pendingText.trim()}`] : []);

  if (event.type === "checkpoint") return { state, lines: [`✓ checkpoint: ${event.checkpoint.label}`] };
  if (event.type === "compaction") return { state, lines: [`… compacted ${event.messagesBefore} messages to ${event.messagesAfter}`] };

  const inner = event.event;
  if (inner.type === "assistant_delta") return { state: { pendingText: state.pendingText + inner.text }, lines: [] };
  if (inner.type === "tool_call") {
    const lines = [...flush(), `→ ${describeToolCall(inner.toolName, inner.arguments)}`];
    return { state: emptyJobLogState(), lines };
  }
  if (inner.type === "tool_result") return { state, lines: [`  ${summarizeToolResult(inner.toolName, inner.content, inner.isError)}`] };
  if (inner.type === "runtime_stop") return { state: emptyJobLogState(), lines: [...flush(), `= ${inner.status}: ${inner.summary}`] };
  return { state, lines: [] };
}

export type JobWorkerDeps = {
  root: string;
  jobId: string;
  provider: AgentTurnProvider;
  prices: ModelPriceCatalog;
  workspace?: NovaWorkspace;
  search?: ExaSearchClient;
  ownerId?: string;
  leaseMs?: number;
  heartbeatMs?: number;
  approvalTimeoutMs?: number;
  approvalPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Handed the constructed agent so a process-level SIGTERM handler can call `.cancel()`. */
  onAgentReady?: (agent: NovaAgent) => void;
};

export type JobWorkerOutcome =
  | { outcome: "not-claimed" }
  | { outcome: "completed"; summary: string }
  | { outcome: "failed"; error: string }
  | { outcome: "requeued" };

/**
 * Runs exactly one occurrence: claim, work, report. The caller decides whether to loop — this stays
 * a single pass so a scripted test can drive it without waiting out a real schedule.
 */
export async function runJobWorkerOnce(deps: JobWorkerDeps): Promise<JobWorkerOutcome> {
  const owner = deps.ownerId ?? workerId();
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const job = await claimJob(deps.root, owner, leaseMs);
  if (!job) return { outcome: "not-claimed" };

  const heartbeat = setInterval(() => {
    void heartbeatJob(deps.root, job.id, owner, leaseMs);
  }, deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);

  let logState = emptyJobLogState();
  let logChain = Promise.resolve();
  const writeLog = (line: string) => {
    // Appends are queued rather than awaited inline, so one slow write cannot reorder itself
    // behind the next event — but every one of them still lands before the function returns,
    // since the final `await logChain` closes the chain out.
    logChain = logChain.then(() => appendJobLog(deps.root, job.id, line));
  };

  try {
    const workspace = deps.workspace ?? new LocalWorkspace(deps.root);
    const approve = detachedApprovalPrompt({
      root: deps.root, jobId: job.id, ownerId: owner,
      pollMs: deps.approvalPollMs, timeoutMs: deps.approvalTimeoutMs, sleep: deps.sleep,
    });
    const agent = new NovaAgent({
      root: deps.root,
      model: deps.provider,
      prices: deps.prices,
      // Auto, never build: nobody is at the keyboard to answer an ordinary edit prompt, and plan
      // mode could not do the work at all. Genuinely sensitive actions still reach `approve`.
      mode: "auto",
      approve,
      workspace,
      search: deps.search,
      onEvent: (event) => {
        const step = stepJobLog(logState, event);
        logState = step.state;
        for (const line of step.lines) writeLog(line);
      },
    });
    deps.onAgentReady?.(agent);

    let objective = job.objective;
    if (job.sessionId) {
      const record = await loadSession(deps.root, job.sessionId);
      if (record) agent.resume(record);
      objective = CONTINUATION_OBJECTIVE;
    } else if (isWanderObjective(job.objective)) {
      // The lab may cite only what its dossier holds, and the sandbox has no network — so, exactly
      // like the interactive `/wander` command, the search has to happen out here before the turn
      // starts, not something the agent is asked to do for itself.
      const topic = resolveWanderJobTopic(job.objective, `${job.id}:${Date.now()}`);
      writeLog(`  researching: ${topic}`);
      const evidence = await gatherWanderEvidence(topic, deps.search);
      await workspace.writeFile(WANDER_LAB_FILES.evidence, evidence.markdown);
      writeLog(`  ${evidence.hits.length} source${evidence.hits.length === 1 ? "" : "s"} → ${WANDER_LAB_FILES.evidence}`);
      objective = buildWanderPrompt(topic);
    }

    writeLog(`▶ ${new Date().toISOString()} ${job.sessionId ? "resuming" : "starting"}: ${job.objective}`);
    const result = await agent.send(objective);
    await logChain;

    if (result.status === "completed") {
      await finishJob(deps.root, job.id, owner, "completed");
      return { outcome: "completed", summary: result.summary };
    }
    await finishJob(deps.root, job.id, owner, "failed", { error: result.summary });
    return { outcome: "failed", error: result.summary };
  } catch (error) {
    await logChain.catch(() => undefined);
    const message = error instanceof Error ? error.message : String(error);
    await writeLogSafely(deps.root, job.id, `✗ ${message}`);
    await finishJob(deps.root, job.id, owner, "failed", { error: message });
    return { outcome: "failed", error: message };
  } finally {
    clearInterval(heartbeat);
    await workspaceDispose(deps.workspace);
  }
}

async function writeLogSafely(root: string, id: string, line: string): Promise<void> {
  await appendJobLog(root, id, line).catch(() => undefined);
}

async function workspaceDispose(workspace: NovaWorkspace | undefined): Promise<void> {
  if (workspace) await workspace.dispose().catch(() => undefined);
}

/**
 * The long-lived form: after a recurring occurrence finishes, sleeps until the next one is due and
 * claims it in turn — one process carrying the whole schedule rather than a new one per firing.
 *
 * Stops the moment the job is no longer there to claim again: cancelled, deleted, or reassigned to
 * someone else. It does not stop merely because one occurrence failed — a bad run of a nightly job
 * is a reason to look at the log, not a reason to cancel tomorrow's.
 */
export async function runJobWorkerForever(deps: JobWorkerDeps): Promise<JobWorkerOutcome> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  for (;;) {
    const outcome = await runJobWorkerOnce(deps);
    if (outcome.outcome === "not-claimed") return outcome;
    const fresh = await getJob(deps.root, deps.jobId);
    if (!fresh || fresh.status !== "queued" || fresh.nextRunAt === undefined) return outcome;
    await sleep(fresh.nextRunAt - Date.now());
  }
}

/** Truthy job-record fields worth a one-line status for `/jobs`. */
export function describeJobForHuman(job: Job): string {
  const parts = [job.status, job.objective];
  if (job.pendingApproval) parts.push(`— waiting on you: ${job.pendingApproval.summary}`);
  return parts.join(" ");
}
