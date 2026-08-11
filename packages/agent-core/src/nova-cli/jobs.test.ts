import { describe, expect, it } from "vitest";
import { cancel, claim, consumeApproval, detach, emptyStore, enqueue, finish, heartbeat, MAX_ATTEMPTS, recoverStale, requestApproval, resolveApproval, summarize, type ApprovalRequest, type JobStore } from "./jobs";

const LEASE = 30_000;
const T0 = 1_760_000_000_000;

function seed(objectives: string[], now = T0): JobStore {
  let store = emptyStore();
  for (const [index, objective] of objectives.entries()) {
    ({ store } = enqueue(store, { id: `job-${index + 1}`, objective, cwd: "/repo", logPath: `/logs/${index + 1}.log`, now: now + index }));
  }
  return store;
}

describe("enqueueing", () => {
  it("writes the job down before anything runs it", () => {
    const { store, job } = enqueue(emptyStore(), { id: "a", objective: "fix the build", cwd: "/repo", logPath: "/logs/a.log", now: T0 });
    expect(job).toMatchObject({ status: "queued", attempts: 0, objective: "fix the build" });
    expect(store.jobs).toHaveLength(1);
  });

  it("refuses a duplicate id and an empty objective", () => {
    const store = seed(["one"]);
    expect(() => enqueue(store, { id: "job-1", objective: "again", cwd: "/repo", logPath: "/l", now: T0 })).toThrow("already exists");
    expect(() => enqueue(store, { id: "new", objective: "  ", cwd: "/repo", logPath: "/l", now: T0 })).toThrow("needs an objective");
  });
});

describe("claiming", () => {
  it("hands out the oldest job first", () => {
    const claimed = claim(seed(["first", "second"]), "worker-1", T0 + 100, LEASE);
    expect(claimed.job?.objective).toBe("first");
    expect(claimed.job?.lease).toEqual({ workerId: "worker-1", expiresAt: T0 + 100 + LEASE });
  });

  it("never hands the same job to two workers", () => {
    // The failure this prevents runs the same edits twice and bills for both.
    const first = claim(seed(["only"]), "worker-1", T0 + 100, LEASE);
    const second = claim(first.store, "worker-2", T0 + 200, LEASE);
    expect(second.job).toBeUndefined();
    expect(second.store.jobs[0].lease?.workerId).toBe("worker-1");
  });

  it("leaves a job scheduled for later alone until it is due", () => {
    let store = emptyStore();
    ({ store } = enqueue(store, { id: "later", objective: "nightly", cwd: "/repo", logPath: "/l", now: T0, cadence: "daily", runAt: T0 + 60_000 }));
    expect(claim(store, "worker-1", T0, LEASE).job).toBeUndefined();
    expect(claim(store, "worker-1", T0 + 60_000, LEASE).job?.id).toBe("later");
  });

  it("does not claim finished work", () => {
    const running = claim(seed(["done"]), "worker-1", T0, LEASE);
    const completed = finish(running.store, "job-1", "worker-1", "completed", { now: T0 + 1_000 });
    expect(claim(completed.store, "worker-2", T0 + 2_000, LEASE).job).toBeUndefined();
  });
});

describe("leases", () => {
  it("keeps a job while its worker keeps saying it is alive", () => {
    const running = claim(seed(["long"]), "worker-1", T0, LEASE);
    const beat = heartbeat(running.store, "job-1", "worker-1", T0 + 20_000, LEASE);
    expect(beat.ok).toBe(true);
    // Renewed past the original expiry, so the recovery sweep leaves it alone.
    expect(recoverStale(beat.store, T0 + 40_000).recovered).toEqual([]);
  });

  it("refuses a heartbeat from anyone but the owner", () => {
    const running = claim(seed(["long"]), "worker-1", T0, LEASE);
    expect(heartbeat(running.store, "job-1", "worker-2", T0 + 1_000, LEASE).ok).toBe(false);
  });

  it("refuses a heartbeat from an owner whose lease already lapsed", () => {
    // The zombie case: a process that stalled past its lease, had the job taken away, and woke up.
    // Letting it renew would give one job two live writers.
    const running = claim(seed(["long"]), "worker-1", T0, LEASE);
    expect(heartbeat(running.store, "job-1", "worker-1", T0 + LEASE + 1, LEASE).ok).toBe(false);
  });

  it("lets another worker take over once the lease lapses", () => {
    const running = claim(seed(["long"]), "worker-1", T0, LEASE);
    const taken = claim(running.store, "worker-2", T0 + LEASE + 1, LEASE);
    expect(taken.job?.lease?.workerId).toBe("worker-2");
    // A reclaim is a fresh attempt: the dead worker may have got part-way before it died.
    expect(taken.job?.attempts).toBe(2);
  });
});

describe("recovery", () => {
  it("returns a silent worker's job to the queue and says what happened", () => {
    const running = claim(seed(["long"]), "worker-1", T0, LEASE);
    const swept = recoverStale(running.store, T0 + LEASE + 1);
    expect(swept.recovered).toHaveLength(1);
    expect(swept.store.jobs[0]).toMatchObject({ status: "queued", lastError: "Worker worker-1 stopped responding" });
  });

  it("stops retrying a job that keeps killing its worker", () => {
    let store = seed(["poison"]);
    let now = T0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      ({ store } = claim(store, `worker-${attempt}`, now, LEASE));
      now += LEASE + 1;
      ({ store } = recoverStale(store, now));
    }
    expect(store.jobs[0].status).toBe("failed");
    expect(store.jobs[0].lastError).toContain("stopped responding");
    expect(claim(store, "worker-x", now + 1, LEASE).job).toBeUndefined();
  });

  it("retires an exhausted job rather than handing it out again", () => {
    let store = seed(["poison"]);
    let now = T0;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      ({ store } = claim(store, `worker-${attempt}`, now, LEASE));
      now += 1;
      ({ store } = detach(store, "job-1", `worker-${attempt}`, now));
    }
    const exhausted = claim(store, "worker-final", now + 1, LEASE);
    expect(exhausted.job).toBeUndefined();
    expect(exhausted.store.jobs[0].status).toBe("failed");
  });

  it("leaves healthy jobs untouched", () => {
    const running = claim(seed(["fine"]), "worker-1", T0, LEASE);
    expect(recoverStale(running.store, T0 + 1_000).recovered).toEqual([]);
  });
});

describe("finishing", () => {
  it("only the owner may finish a job", () => {
    const running = claim(seed(["x"]), "worker-1", T0, LEASE);
    expect(finish(running.store, "job-1", "worker-2", "completed", { now: T0 + 1 }).ok).toBe(false);
    expect(finish(running.store, "job-1", "worker-1", "completed", { now: T0 + 1 }).ok).toBe(true);
  });

  it("records why a job failed", () => {
    const running = claim(seed(["x"]), "worker-1", T0, LEASE);
    const failed = finish(running.store, "job-1", "worker-1", "failed", { now: T0 + 1, error: "provider returned 500" });
    expect(failed.store.jobs[0]).toMatchObject({ status: "failed", lastError: "provider returned 500" });
  });

  it("re-queues recurring work instead of ending it", () => {
    let store = emptyStore();
    ({ store } = enqueue(store, { id: "nightly", objective: "wander", cwd: "/repo", logPath: "/l", now: T0, cadence: "daily" }));
    ({ store } = claim(store, "worker-1", T0, LEASE));
    ({ store } = finish(store, "nightly", "worker-1", "completed", { now: T0 + 5_000 }));

    // One record per schedule, not one per firing — and the attempt count resets for the next one.
    expect(store.jobs).toHaveLength(1);
    expect(store.jobs[0]).toMatchObject({ status: "queued", attempts: 0, nextRunAt: T0 + 5_000 + 86_400_000 });
  });

  it("does not resurrect a recurring job that failed", () => {
    let store = emptyStore();
    ({ store } = enqueue(store, { id: "nightly", objective: "wander", cwd: "/repo", logPath: "/l", now: T0, cadence: "weekly" }));
    ({ store } = claim(store, "worker-1", T0, LEASE));
    ({ store } = finish(store, "nightly", "worker-1", "failed", { now: T0 + 1, error: "boom" }));
    expect(store.jobs[0].status).toBe("failed");
  });
});

describe("detaching and cancelling", () => {
  it("makes a detached job available immediately", () => {
    // Detaching is the deliberate version of the crash recovery already handles, so it should not
    // make the next worker wait out a lease nobody is renewing.
    const running = claim(seed(["x"]), "worker-1", T0, LEASE);
    const detached = detach(running.store, "job-1", "worker-1", T0 + 1_000);
    expect(detached.ok).toBe(true);
    expect(claim(detached.store, "worker-2", T0 + 1_001, LEASE).job?.lease?.workerId).toBe("worker-2");
  });

  it("cancels queued and running work, but not finished work", () => {
    const queued = cancel(seed(["x"]), "job-1", T0 + 1);
    expect(queued.store.jobs[0].status).toBe("cancelled");

    const running = claim(seed(["y"]), "worker-1", T0, LEASE);
    expect(cancel(running.store, "job-1", T0 + 1).store.jobs[0]).toMatchObject({ status: "cancelled", lease: undefined });
    expect(cancel(queued.store, "job-1", T0 + 2).ok).toBe(false);
  });

  it("a cancelled job is never handed out again", () => {
    const cancelled = cancel(seed(["x"]), "job-1", T0 + 1);
    expect(claim(cancelled.store, "worker-1", T0 + 2, LEASE).job).toBeUndefined();
  });
});

/** A complete cross-process approval request; `digest` is the identity everything binds to. */
function approvalFor(digest: string, overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    summary: "run npm test",
    toolName: "run_command",
    toolCallId: `call-${digest}`,
    actionDigest: digest,
    scopeKey: `nova-approval-v1:${digest}`,
    policyVersion: "nova-approval-v1",
    effect: "workspace",
    capabilityId: "workspace.terminal",
    ...overrides,
  };
}

describe("approval while nobody is watching", () => {
  it("parks the job on a decision and says whose call it is", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1", { summary: "run rm -rf build/" }), T0 + 1_000);
    expect(paused.ok).toBe(true);
    expect(paused.store.jobs[0]).toMatchObject({ status: "paused", pendingApproval: { summary: "run rm -rf build/", toolName: "run_command" } });
  });

  it("carries the whole authorization identity across the process boundary", () => {
    // A summary and a tool name cannot be checked against anything. The digest, scope key, policy
    // version, effect and capability are what let a decision be verified against the call it was
    // issued for, which is the guarantee PermissionLedger already makes in-process.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const request = approvalFor("d1");
    const paused = requestApproval(running.store, "job-1", "worker-1", request, T0 + 1_000);
    expect(paused.store.jobs[0].pendingApproval).toMatchObject({
      actionDigest: "d1",
      scopeKey: "nova-approval-v1:d1",
      policyVersion: "nova-approval-v1",
      effect: "workspace",
      capabilityId: "workspace.terminal",
      toolCallId: "call-d1",
      requestedAt: T0 + 1_000,
    });
  });

  it("refuses a request that cannot be identified", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    expect(() => requestApproval(running.store, "job-1", "worker-1", approvalFor("", { actionDigest: "" }), T0 + 1_000)).toThrow(/action digest/);
  });

  it("keeps the lease alive while paused, so recovery does not mistake waiting for dead", () => {
    // The worker isn't gone, it's idle on purpose — a paused job must still be heartbeat-able,
    // or every approval wait would eventually be reclaimed out from under it.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    expect(heartbeat(paused.store, "job-1", "worker-1", T0 + 2_000, LEASE).ok).toBe(true);
    expect(recoverStale(paused.store, T0 + 2_000).recovered).toEqual([]);
  });

  it("lets a human resolve it without holding the job's lease", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    // Whoever is deciding is, by construction, not the worker — /jobs approve has no lease to offer.
    const resolved = resolveApproval(paused.store, "job-1", "allow", "d1", T0 + 5_000);
    expect(resolved.ok).toBe(true);
    expect(resolved.store.jobs[0].approvalDecision).toMatchObject({ decision: "allow", actionDigest: "d1" });
    expect(resolved.store.jobs[0].status).toBe("paused");
  });

  it("refuses a decision aimed at an action the job is not asking about", () => {
    // The attack this closes: a worker dies between the prompt and the answer, a re-claim parks a
    // different call under the same job id, and a human's "allow" lands on a command they never
    // saw. The decision names an action; a job id alone is not an authorization.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d-safe", { summary: "run npm test" }), T0 + 1_000);
    const wrong = resolveApproval(paused.store, "job-1", "allow", "d-destructive", T0 + 5_000);
    expect(wrong.ok).toBe(false);
    expect(wrong.store.jobs[0].approvalDecision).toBeUndefined();
  });

  it("drops a decision whose action was replaced while it was in flight", () => {
    // Resolved against the request that was showing, then the worker re-parks a different call
    // before the decision is collected. The stale authorization must not carry over to the new one.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const first = requestApproval(running.store, "job-1", "worker-1", approvalFor("d-safe"), T0 + 1_000);
    const resolved = resolveApproval(first.store, "job-1", "allow", "d-safe", T0 + 2_000);
    const replaced = requestApproval(resolved.store, "job-1", "worker-1", approvalFor("d-other"), T0 + 3_000);

    const collected = consumeApproval(replaced.store, "job-1", "worker-1", T0 + 4_000);
    expect(collected.decision).toBeUndefined();
    expect(collected.store.jobs[0]).toMatchObject({ status: "paused", approvalDecision: undefined });
    expect(collected.store.jobs[0].pendingApproval?.actionDigest).toBe("d-other");
  });

  it("only the owning worker collects the decision, and doing so resumes the job", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    const resolved = resolveApproval(paused.store, "job-1", "deny_always", "d1", T0 + 5_000);

    expect(consumeApproval(resolved.store, "job-1", "worker-2", T0 + 6_000).decision).toBeUndefined();
    const collected = consumeApproval(resolved.store, "job-1", "worker-1", T0 + 6_000);
    expect(collected.decision).toBe("deny_always");
    expect(collected.actionDigest).toBe("d1");
    expect(collected.store.jobs[0]).toMatchObject({ status: "running", pendingApproval: undefined, approvalDecision: undefined });
  });

  it("executes an approved action at most once, however often the decision is redelivered", () => {
    // One human decision authorizes one execution. A replayed or duplicated delivery — a retry, a
    // resumed worker, a re-parked identical call — must find the authorization already spent.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    const resolved = resolveApproval(paused.store, "job-1", "allow", "d1", T0 + 2_000);
    const first = consumeApproval(resolved.store, "job-1", "worker-1", T0 + 3_000);
    expect(first.decision).toBe("allow");
    expect(first.store.jobs[0].executedApprovals).toEqual(["d1"]);

    // The same action cannot be parked again, so it cannot be approved or run a second time.
    const again = requestApproval(first.store, "job-1", "worker-1", approvalFor("d1"), T0 + 4_000);
    expect(again.ok).toBe(false);
    expect(again.store.jobs[0].status).toBe("running");

    // A decision redelivered for the spent digest is not collectable either.
    const replayed = resolveApproval(first.store, "job-1", "allow", "d1", T0 + 5_000);
    expect(replayed.ok).toBe(false);
  });

  it("does not spend the authorization when the answer was no", () => {
    // A denial is not an execution, so the same action may legitimately be proposed and asked
    // about again — recording it as executed would make every denial permanent by accident.
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    const resolved = resolveApproval(paused.store, "job-1", "deny", "d1", T0 + 2_000);
    const collected = consumeApproval(resolved.store, "job-1", "worker-1", T0 + 3_000);
    expect(collected.decision).toBe("deny");
    expect(collected.store.jobs[0].executedApprovals ?? []).toEqual([]);
    expect(requestApproval(collected.store, "job-1", "worker-1", approvalFor("d1"), T0 + 4_000).ok).toBe(true);
  });

  it("has nothing to collect before a decision is delivered", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    expect(consumeApproval(paused.store, "job-1", "worker-1", T0 + 2_000).decision).toBeUndefined();
  });

  it("clears a stale approval on recovery rather than leaving an unanswerable request behind", () => {
    const running = claim(seed(["ship it"]), "worker-1", T0, LEASE);
    const paused = requestApproval(running.store, "job-1", "worker-1", approvalFor("d1"), T0 + 1_000);
    const recovered = recoverStale(paused.store, T0 + LEASE + 1);
    expect(recovered.store.jobs[0]).toMatchObject({ status: "queued", pendingApproval: undefined });
  });
});

describe("reporting", () => {
  it("explains each job's state in one line", () => {
    const running = claim(seed(["fix the build", "write docs"]), "worker-1", T0, LEASE);
    const rows = summarize(running.store, T0 + 5_000, "/repo");
    expect(rows.find((row) => row.id === "job-1")).toMatchObject({ status: "running", detail: "held by worker-1, lease 25s" });
    expect(rows.find((row) => row.id === "job-2")?.status).toBe("queued");
  });

  it("calls out a lease that has run out", () => {
    const running = claim(seed(["x"]), "worker-1", T0, LEASE);
    expect(summarize(running.store, T0 + LEASE + 1)[0].detail).toContain("stopped responding");
  });

  it("scopes to one project", () => {
    let store = seed(["mine"]);
    ({ store } = enqueue(store, { id: "other", objective: "elsewhere", cwd: "/other", logPath: "/l", now: T0 }));
    expect(summarize(store, T0, "/repo").map((row) => row.id)).toEqual(["job-1"]);
    expect(summarize(store, T0)).toHaveLength(2);
  });
});
