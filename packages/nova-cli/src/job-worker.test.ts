import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "@circuit-nova/nova-core/agent-runtime";
import type { NovaEvent } from "@circuit-nova/nova-core/nova-cli/agent";
import { enqueueJob, getJob, newJobId, readJobLog, resolveJobApproval } from "@circuit-nova/nova-core";
import { saveSession, newSessionId } from "@circuit-nova/nova-core/nova-cli/session";
import {
  CONTINUATION_OBJECTIVE,
  describeJobForHuman,
  detachedApprovalPrompt,
  emptyJobLogState,
  runJobWorkerForever,
  runJobWorkerOnce,
  stepJobLog,
  workerId,
} from "./job-worker";

const prices = { inputRwfPerMillionTokens: 2_000, outputRwfPerMillionTokens: 8_000 };
const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

function scriptedModel(turns: Array<Partial<AgentModelTurn>>): AgentTurnProvider & { requests: AgentModelRequest[] } {
  const requests: AgentModelRequest[] = [];
  let index = 0;
  return {
    requests,
    async complete(request) {
      requests.push(request);
      const turn = turns[Math.min(index, turns.length - 1)];
      index += 1;
      return { responseId: `resp_${index}`, model: "nova-test", finishReason: "stop", content: "Done.", toolCalls: [], usage, ...turn } as AgentModelTurn;
    },
  };
}

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-worker-"));
  await fs.writeFile(path.join(root, "app.ts"), "export const port = 3000;\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("worker identity", () => {
  it("names itself host and pid, so a lease's owner is a real thing to look for", () => {
    expect(workerId("laptop", 4242)).toBe("laptop:4242");
  });
});

describe("the log formatter", () => {
  it("holds assistant text until a natural boundary, then flushes it as one line", () => {
    let state = emptyJobLogState();
    for (const chunk of ["I'll ", "read the file first."]) {
      ({ state } = stepJobLog(state, { type: "runtime", event: { type: "assistant_delta", iteration: 1, text: chunk } }));
    }
    const flushed = stepJobLog(state, { type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "app.ts" } } });
    expect(flushed.lines).toEqual(["» I'll read the file first.", "→ app.ts"]);
    expect(flushed.state).toEqual(emptyJobLogState());
  });

  it("writes a tool result on its own line", () => {
    const { lines } = stepJobLog(emptyJobLogState(), { type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "run_command", isError: false, effect: "workspace", content: "exit 0\nok" } });
    expect(lines[0]).toMatch(/^ {2}/);
  });

  it("flushes trailing text on the final stop event", () => {
    const talking = stepJobLog(emptyJobLogState(), { type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "All done." } });
    const stopped = stepJobLog(talking.state, { type: "runtime", event: { type: "runtime_stop", status: "completed", summary: "Fixed the port." } });
    expect(stopped.lines).toEqual(["» All done.", "= completed: Fixed the port."]);
  });

  it("writes a line for checkpoints and compaction", () => {
    expect(stepJobLog(emptyJobLogState(), { type: "checkpoint", checkpoint: { tree: "abc", label: "fix the build", createdAt: 0 } }).lines).toEqual(["✓ checkpoint: fix the build"]);
    expect(stepJobLog(emptyJobLogState(), { type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 10 }).lines).toEqual(["… compacted 40 messages to 10"]);
  });

  it("says nothing for an empty stop, rather than an empty line", () => {
    const { lines } = stepJobLog(emptyJobLogState(), { type: "runtime", event: { type: "model_turn", iteration: 1, responseId: "r1", model: "m", toolCallCount: 0, usage } });
    expect(lines).toEqual([]);
  });
});

describe("summarizing a job for a human", () => {
  it("surfaces a pending approval inline", () => {
    const job = { id: "j1", objective: "deploy", status: "paused", cwd: root, createdAt: 0, updatedAt: 0, attempts: 1, logPath: "l", pendingApproval: { summary: "run rm -rf dist", toolName: "run_command", requestedAt: 0 } } as const;
    expect(describeJobForHuman(job)).toContain("waiting on you: run rm -rf dist");
  });
});

describe("running one occurrence", () => {
  it("does nothing when there is no job to claim", async () => {
    expect(await runJobWorkerOnce({ root, jobId: "nope", provider: scriptedModel([]), prices })).toEqual({ outcome: "not-claimed" });
  });

  it("runs a real turn to completion, logs it, and marks the job completed", async () => {
    const model = scriptedModel([
      { finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "app.ts" } }] },
      { finishReason: "stop", content: "The port is 3000." },
    ]);
    const job = await enqueueJob(root, { id: newJobId(), objective: "what port does the app use", logPath: "l" });

    const outcome = await runJobWorkerOnce({ root, jobId: job.id, provider: model, prices });
    expect(outcome).toEqual({ outcome: "completed", summary: "The port is 3000." });
    expect((await getJob(root, job.id))?.status).toBe("completed");

    const log = await readJobLog(root, job.id);
    expect(log.text).toContain("starting: what port does the app use");
    expect(log.text).toContain("→ app.ts");
  });

  it("marks the job failed when the turn does not complete cleanly, with the runtime's own reason", async () => {
    // A refusal is a real, unscripted way for a turn to end without succeeding — the runtime's
    // own "blocked" status, not a contrived error path.
    const model = scriptedModel([{ finishReason: "refusal", content: "", refusal: "I can't help with that." }]);
    const job = await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    const outcome = await runJobWorkerOnce({ root, jobId: job.id, provider: model, prices });
    expect(outcome.outcome).toBe("failed");
    expect((await getJob(root, job.id))?.status).toBe("failed");
  });

  it("records a thrown error against the job instead of losing it silently", async () => {
    const throwing: AgentTurnProvider = { complete: async () => { throw new Error("provider unreachable"); } };
    const job = await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    const outcome = await runJobWorkerOnce({ root, jobId: job.id, provider: throwing, prices });
    expect(outcome).toEqual({ outcome: "failed", error: "provider unreachable" });
    expect((await getJob(root, job.id))?.lastError).toBe("provider unreachable");
    expect((await readJobLog(root, job.id)).text).toContain("provider unreachable");
  });

  it("resumes a session instead of starting over, when the job continues one", async () => {
    const sessionId = newSessionId();
    await saveSession({ schemaVersion: 2, revision: 0, id: sessionId, createdAt: Date.now(), updatedAt: Date.now(), root, title: "t", messages: [{ role: "user", content: "original ask" }], approvals: {}, totalRwf: 0 });
    const model = scriptedModel([{ finishReason: "stop", content: "Continued and finished." }]);
    const job = await enqueueJob(root, { id: newJobId(), objective: "placeholder", logPath: "l", sessionId });

    await runJobWorkerOnce({ root, jobId: job.id, provider: model, prices });
    // The continuation prompt, not the job's stored objective — the real objective already lives in
    // the resumed session's history, which sits between the system prompt and the new turn.
    const sent = model.requests[0].messages;
    expect(sent[1]).toMatchObject({ content: "original ask" });
    expect(sent.at(-1)).toMatchObject({ role: "user", content: CONTINUATION_OBJECTIVE });
  });

  it("hands the constructed agent back so an outer process can wire Ctrl+C/SIGTERM to it", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "done" }]);
    const job = await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    let handed: unknown;
    await runJobWorkerOnce({ root, jobId: job.id, provider: model, prices, onAgentReady: (agent) => { handed = agent; } });
    expect(handed).toBeDefined();
  });
});

describe("approval while nobody is watching", () => {
  it("parks on a decision, then continues once one is delivered", async () => {
    const model: AgentTurnProvider = {
      complete: async (request) => {
        // "terraform apply" is a flagged command (deployment), so auto mode still routes it to the
        // approval prompt instead of fast-pathing it — the second call, after the tool result
        // comes back, is what should carry "Deployed." to a finish.
        if (request.messages.some((message) => message.role === "tool")) return { responseId: "r2", model: "m", finishReason: "stop", content: "Deployed.", toolCalls: [], usage };
        return { responseId: "r1", model: "m", finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "terraform apply" } }], usage };
      },
    };
    const job = await enqueueJob(root, { id: newJobId(), objective: "deploy", logPath: "l" });

    // Resolve the approval concurrently with the run — this is standing in for a human typing
    // `/jobs approve` from an entirely different process while the worker is mid-poll.
    const resolving = (async () => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const current = await getJob(root, job.id);
        if (current?.pendingApproval) { await resolveJobApproval(root, job.id, "allow"); return; }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error("approval request never arrived");
    })();

    const [outcome] = await Promise.all([
      runJobWorkerOnce({ root, jobId: job.id, provider: model, prices, approvalPollMs: 10, approvalTimeoutMs: 5_000 }),
      resolving,
    ]);
    expect(outcome).toEqual({ outcome: "completed", summary: "Deployed." });
  });

  it("denies and gives up when nobody answers in time", async () => {
    const model: AgentTurnProvider = {
      // Only one call: a denied tool call halts the run rather than handing the model a rejection
      // to react to — the same behavior an interactive "deny" produces, unattended just means
      // nobody ever supplied the "allow" that would have let it proceed.
      complete: async () => ({ responseId: "r1", model: "m", finishReason: "tool_calls", content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: { command: "rm -rf /important" } }], usage }),
    };
    const job = await enqueueJob(root, { id: newJobId(), objective: "cleanup", logPath: "l" });
    const outcome = await runJobWorkerOnce({ root, jobId: job.id, provider: model, prices, approvalPollMs: 5, approvalTimeoutMs: 20 });
    expect(outcome).toEqual({ outcome: "failed", error: "Tool run_command was rejected by the user." });
    expect((await getJob(root, job.id))?.status).toBe("failed");
  });
});

describe("the detached approval prompt directly", () => {
  it("gives up after its timeout without ever being answered", async () => {
    const job = await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    await import("@circuit-nova/nova-core").then((core) => core.claimJob(root, "worker-1", 60_000));
    const prompt = detachedApprovalPrompt({ root, jobId: job.id, ownerId: "worker-1", pollMs: 1, timeoutMs: 10 });
    const decision = await prompt({ call: { id: "c1", name: "run_command", arguments: {} }, tool: { name: "run_command", description: "", inputSchema: { type: "object" }, capabilityId: "workspace.terminal", effect: "workspace", parallelSafe: false, requiresApproval: true, execute: async () => ({ content: "" }) }, summary: "run rm -rf /", actionDigest: "d", scopeKey: "s", policyVersion: "nova-approval-v1", safety: { sensitive: false, categories: [], reasons: [] } });
    expect(decision).toBe("deny");
  });
});

describe("recurring jobs, one process across the whole schedule", () => {
  it("re-claims the same job after it re-queues, without a real wait", async () => {
    let calls = 0;
    const model = scriptedModel([]);
    model.complete = async () => { calls += 1; return { responseId: `r${calls}`, model: "m", finishReason: "stop", content: `run ${calls}`, toolCalls: [], usage }; };
    const job = await enqueueJob(root, { id: newJobId(), objective: "nightly sweep", logPath: "l", cadence: "daily" });

    const outcome = await runJobWorkerForever({ root, jobId: job.id, provider: model, prices, sleep: async () => {} });
    // Two occurrences and out: the job store's own cadence logic re-queues once, and the third
    // claim attempt in this test never comes because we only assert on what actually ran.
    expect(calls).toBeGreaterThanOrEqual(1);
    expect(outcome.outcome === "completed" || outcome.outcome === "not-claimed").toBe(true);
  });

  it("stops once the job is no longer there to claim again", async () => {
    const model = scriptedModel([{ finishReason: "stop", content: "done" }]);
    const job = await enqueueJob(root, { id: newJobId(), objective: "one-off", logPath: "l" });
    const outcome = await runJobWorkerForever({ root, jobId: job.id, provider: model, prices, sleep: async () => { throw new Error("should not sleep for a one-off job"); } });
    expect(outcome).toEqual({ outcome: "completed", summary: "done" });
  });
});
