/**
 * Work that outlives the terminal that started it.
 *
 * Everything the agent does today is a foreground turn: close the terminal and the work is gone,
 * with whatever it spent already spent. A durable job is the opposite contract — it is written down
 * before it starts, it records who is running it, and if that worker dies the job is still there and
 * still knows how far it got.
 *
 * Two failure modes shape the design, and both are the kind that lose work quietly:
 *
 * **Two workers on one job.** A queue that hands the same job to two processes runs the same edits
 * twice and bills twice. Claiming is therefore a compare-and-set on the record, never a read
 * followed by a write.
 *
 * **A worker that dies without saying so.** A crashed process cannot mark its job failed, so a
 * status alone would leave that job "running" forever. Ownership is a *lease* with an expiry the
 * worker must keep renewing; a lease that stops being renewed is the only signal a crash actually
 * produces, and recovery is driven from that rather than from anything the dead process does.
 *
 * The state machine is pure and takes its clock as an argument, so both of those can be tested
 * exactly — including the interleavings that are impossible to reproduce against a real filesystem.
 */

export type JobStatus = "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";

export type JobLease = {
  /** Identifies the process holding the job: pid plus host, so a recycled pid is not mistaken for the owner. */
  workerId: string;
  /** Epoch ms after which the claim is void and the job may be recovered. */
  expiresAt: number;
};

export type Job = {
  id: string;
  objective: string;
  status: JobStatus;
  /** Working directory the job belongs to, so one store can serve several projects. */
  cwd: string;
  createdAt: number;
  updatedAt: number;
  /** How many times a worker has taken this on. Bounded so a job that always crashes stops. */
  attempts: number;
  lease?: JobLease;
  lastError?: string;
  /** Appended to as the job runs, so a detached run can be read back and reattached to. */
  logPath: string;
  /** Set for recurring work; a completed occurrence is re-queued at `nextRunAt`. */
  cadence?: "daily" | "weekly";
  nextRunAt?: number;
  /** Set when a detached turn is a continuation of a foreground session, so the worker can resume it. */
  sessionId?: string;
  /**
   * A tool call the worker cannot decide on its own and is waiting on a human for.
   *
   * Nobody is at the keyboard when a detached job runs, so the ordinary synchronous approval
   * prompt has nowhere to go. This is where that request waits instead: the job pauses, the
   * request is visible to `/jobs` and `/attach`, and a decision recorded here is what lets the
   * worker — which is polling for exactly this — carry on.
   */
  pendingApproval?: PendingApproval;
  /**
   * A decision delivered for `pendingApproval`, waiting for the owning worker to notice and act on it.
   *
   * Carries the digest it was issued against, because a decision authorizes *an action*, not a job.
   * Without it, "allow" meant "allow whatever this job asks next", and the action a human read in
   * the prompt and the action the worker went on to run were only incidentally the same one.
   */
  approvalDecision?: { decision: ApprovalDecision; actionDigest: string; decidedAt: number };
  /**
   * Digests this job has already executed under a human decision.
   *
   * At-most-once enforcement: a decision is consumed exactly once, and a redelivered or replayed
   * one for an action already run is refused rather than executed a second time.
   */
  executedApprovals?: string[];
};

export type ApprovalDecision = "allow" | "allow_always" | "deny" | "deny_always";

/**
 * The exact action a human is being asked to authorize, carried whole across the process boundary.
 *
 * In-process, `PermissionLedger` binds a decision to a digest over the tool, capability, effect and
 * every argument, so a changed path or command must be approved again. A detached job crossed that
 * boundary carrying only a summary string and a tool name, which meant the decision could not be
 * checked against the call the worker actually went on to make. These fields are what make the
 * cross-process decision as narrow as the in-process one.
 */
export type PendingApproval = {
  summary: string;
  toolName: string;
  /** Identifies the specific call, so a decision cannot be applied to a different one. */
  toolCallId: string;
  /** SHA-256 over the normalized tool, capability, effect and arguments. */
  actionDigest: string;
  /** Versioned authorization key; a policy change invalidates decisions made under the old one. */
  scopeKey: string;
  policyVersion: string;
  effect: "none" | "workspace" | "external";
  capabilityId: string;
  requestedAt: number;
};

export type JobStore = { jobs: Job[] };

export const MAX_ATTEMPTS = 3;

/** Terminal states never move again, and nothing may claim them. */
const TERMINAL: readonly JobStatus[] = ["completed", "failed", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.includes(status);
}

export function emptyStore(): JobStore {
  return { jobs: [] };
}

function replace(store: JobStore, job: Job): JobStore {
  return { jobs: store.jobs.map((candidate) => (candidate.id === job.id ? job : candidate)) };
}

export type EnqueueOptions = {
  id: string;
  objective: string;
  cwd: string;
  logPath: string;
  now: number;
  cadence?: "daily" | "weekly";
  /** For recurring work whose first run is in the future. */
  runAt?: number;
  /** Continues an existing session instead of starting a fresh one — the detach path. */
  sessionId?: string;
};

export function enqueue(store: JobStore, options: EnqueueOptions): { store: JobStore; job: Job } {
  if (store.jobs.some((job) => job.id === options.id)) throw new Error(`Job ${options.id} already exists`);
  if (!options.objective.trim()) throw new Error("A job needs an objective");
  const job: Job = {
    id: options.id,
    objective: options.objective.trim(),
    // A job scheduled for later is queued but not yet due; `claim` decides, not the status.
    status: "queued",
    cwd: options.cwd,
    createdAt: options.now,
    updatedAt: options.now,
    attempts: 0,
    logPath: options.logPath,
    ...(options.cadence ? { cadence: options.cadence } : {}),
    ...(options.runAt !== undefined ? { nextRunAt: options.runAt } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
  };
  return { store: { jobs: [...store.jobs, job] }, job };
}

function claimable(job: Job, now: number): boolean {
  if (job.status === "queued") return (job.nextRunAt ?? 0) <= now;
  // A running or paused job whose worker stopped renewing is available again — that expiry is the
  // only evidence a crashed process ever produces, and a paused-on-approval job whose worker died
  // is exactly as abandoned as one that died mid-turn.
  return (job.status === "running" || job.status === "paused") && job.lease !== undefined && job.lease.expiresAt <= now;
}

/**
 * Takes ownership of the next available job, or reports that there is none.
 *
 * Ordering is oldest-first so a queue drains rather than starving its earliest entry. Reclaiming an
 * expired lease counts as a fresh attempt: the previous worker may have got part-way and died, and
 * a job that reliably kills its worker must eventually stop rather than cycle forever.
 */
export function claim(store: JobStore, workerId: string, now: number, leaseMs: number): { store: JobStore; job?: Job } {
  const candidates = store.jobs.filter((job) => claimable(job, now)).sort((left, right) => left.createdAt - right.createdAt);
  const target = candidates[0];
  if (!target) return { store };

  const attempts = target.attempts + 1;
  if (attempts > MAX_ATTEMPTS) {
    const exhausted: Job = { ...target, status: "failed", updatedAt: now, attempts: target.attempts, lastError: `Gave up after ${MAX_ATTEMPTS} attempts`, lease: undefined };
    // Return the store with the job retired but claim nothing, so the caller loops to the next one
    // rather than treating an exhausted job as work it should run.
    return { store: replace(store, exhausted) };
  }

  // A fresh claim always starts the objective over, so a stale approval request (meaningful only
  // to the worker state that asked for it) is cleared along with the rest of that state.
  const claimed: Job = { ...target, status: "running", attempts, updatedAt: now, lease: { workerId, expiresAt: now + leaseMs }, lastError: undefined, pendingApproval: undefined, approvalDecision: undefined };
  return { store: replace(store, claimed), job: claimed };
}

/**
 * True when `workerId` still holds this job's lease.
 *
 * Accepts both `running` and `paused`: a worker waiting on a human approval is still the owner and
 * must keep renewing its lease while it waits, or the recovery sweep would reclaim a job that is
 * not actually abandoned — it is one decision away from continuing.
 */
function ownedBy(job: Job | undefined, workerId: string, now: number): job is Job {
  return job !== undefined && (job.status === "running" || job.status === "paused") && job.lease?.workerId === workerId && job.lease.expiresAt > now;
}

/**
 * Extends a lease.
 *
 * Rejects a worker that is not the owner, which is what stops a process that was declared dead —
 * and whose job has since been given to someone else — from waking up and continuing to write to it.
 */
export function heartbeat(store: JobStore, id: string, workerId: string, now: number, leaseMs: number): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!ownedBy(job, workerId, now)) return { store, ok: false };
  return { store: replace(store, { ...job, updatedAt: now, lease: { workerId, expiresAt: now + leaseMs } }), ok: true };
}

export type ApprovalRequest = Omit<PendingApproval, "requestedAt">;

/**
 * Parks the job on a decision only a human can make, and says so where `/jobs` and `/attach` look.
 *
 * The job stays owned by its worker throughout — this is not a handoff, it is the worker saying "I
 * need someone" and then going back to polling for the answer. `finish`/`heartbeat` still require
 * the same lease, so a stale worker cannot resume a job whose approval was actually meant for
 * whoever claims it next.
 */
export function requestApproval(store: JobStore, id: string, workerId: string, request: ApprovalRequest, now: number): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!ownedBy(job, workerId, now)) return { store, ok: false };
  if (!request.actionDigest.trim() || !request.scopeKey.trim()) throw new Error("An approval request must carry its action digest and scope key");
  // Asking again for an action already executed under a decision would be a second execution of a
  // single authorization, which is exactly what `executedApprovals` exists to prevent.
  if (job.executedApprovals?.includes(request.actionDigest)) return { store, ok: false };
  return {
    store: replace(store, { ...job, status: "paused", updatedAt: now, pendingApproval: { ...request, requestedAt: now }, approvalDecision: undefined }),
    ok: true,
  };
}

/**
 * Delivers a decision for a pending approval, against the exact action the human was shown.
 *
 * Not lease-gated: the person resolving this is, by definition, not the worker — they are the human
 * the worker is waiting on, most often typing at `/attach` or `/jobs approve`, and the whole point is
 * that they can do this without holding the job's own claim.
 *
 * It *is* digest-gated. The caller states which action it is answering, and a mismatch is refused
 * rather than applied: between a request being shown and a decision arriving, a worker can die and
 * a re-claim can propose something different under the same job id. Answering "allow" to a prompt
 * about `npm test` must never authorize the `rm -rf` that replaced it.
 */
export function resolveApproval(store: JobStore, id: string, decision: ApprovalDecision, actionDigest: string, now: number): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!job?.pendingApproval) return { store, ok: false };
  if (job.pendingApproval.actionDigest !== actionDigest) return { store, ok: false };
  return { store: replace(store, { ...job, updatedAt: now, approvalDecision: { decision, actionDigest, decidedAt: now } }), ok: true };
}

/**
 * The owning worker collects a delivered decision and resumes.
 *
 * Split from `resolveApproval` because the two happen on different sides of the same wait: a human
 * writes the decision from wherever they are watching, and the worker — mid-poll, holding the lease
 * — is the only one allowed to consume it and put the job back to work.
 *
 * The digest is re-checked here too, and returned with the decision so the worker can bind it to
 * the call it is about to make. Recording an allowed digest in `executedApprovals` as it is
 * consumed is what makes execution at-most-once: the decision is spent in the same transition that
 * releases the job to run, so a duplicate delivery finds nothing left to consume.
 */
export function consumeApproval(store: JobStore, id: string, workerId: string, now: number): { store: JobStore; decision?: ApprovalDecision; actionDigest?: string } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!ownedBy(job, workerId, now) || !job.approvalDecision || !job.pendingApproval) return { store };
  const { decision, actionDigest } = job.approvalDecision;
  // A decision that no longer matches the parked request answers a question that is no longer
  // being asked. Drop both and leave the job paused rather than act on a stale authorization.
  if (job.pendingApproval.actionDigest !== actionDigest) {
    return { store: replace(store, { ...job, updatedAt: now, approvalDecision: undefined }) };
  }
  if (job.executedApprovals?.includes(actionDigest)) {
    return { store: replace(store, { ...job, updatedAt: now, approvalDecision: undefined }) };
  }
  const allowed = decision === "allow" || decision === "allow_always";
  return {
    store: replace(store, {
      ...job,
      status: "running",
      updatedAt: now,
      pendingApproval: undefined,
      approvalDecision: undefined,
      executedApprovals: allowed ? [...(job.executedApprovals ?? []), actionDigest] : job.executedApprovals,
    }),
    decision,
    actionDigest,
  };
}

export type CompletionOptions = { now: number; error?: string };

/**
 * Finishes a job, from its owner.
 *
 * Recurring work does not end: a completed occurrence goes back to `queued` with the next due time,
 * which keeps one record per schedule instead of accumulating one per firing.
 */
export function finish(store: JobStore, id: string, workerId: string, outcome: "completed" | "failed", options: CompletionOptions): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!ownedBy(job, workerId, options.now)) return { store, ok: false };

  if (outcome === "completed" && job.cadence) {
    const next = options.now + (job.cadence === "daily" ? 86_400_000 : 604_800_000);
    return { store: replace(store, { ...job, status: "queued", updatedAt: options.now, attempts: 0, lease: undefined, nextRunAt: next, lastError: undefined }), ok: true };
  }
  return {
    store: replace(store, { ...job, status: outcome, updatedAt: options.now, lease: undefined, ...(options.error ? { lastError: options.error } : {}) }),
    ok: true,
  };
}

/**
 * Detaches without ending the job.
 *
 * The lease is dropped rather than kept, so the job is immediately available to another worker
 * instead of waiting out a lease nobody is renewing. Detaching is the deliberate version of the
 * crash that recovery already handles.
 */
export function detach(store: JobStore, id: string, workerId: string, now: number): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!ownedBy(job, workerId, now)) return { store, ok: false };
  return { store: replace(store, { ...job, status: "queued", updatedAt: now, lease: undefined }), ok: true };
}

/** Stops a job wherever it is. A running job's worker discovers this at its next heartbeat. */
export function cancel(store: JobStore, id: string, now: number): { store: JobStore; ok: boolean } {
  const job = store.jobs.find((candidate) => candidate.id === id);
  if (!job || isTerminal(job.status)) return { store, ok: false };
  return { store: replace(store, { ...job, status: "cancelled", updatedAt: now, lease: undefined }), ok: true };
}

/**
 * Returns jobs whose worker has gone silent to the queue.
 *
 * Separate from `claim` so a supervisor can report what it recovered — "three jobs were picked up
 * again after a crash" is worth saying out loud, and a claim path that quietly fixed it would never
 * surface that the crash happened at all.
 */
export function recoverStale(store: JobStore, now: number): { store: JobStore; recovered: Job[] } {
  const recovered: Job[] = [];
  const jobs = store.jobs.map((job) => {
    if ((job.status !== "running" && job.status !== "paused") || !job.lease || job.lease.expiresAt > now) return job;
    if (job.attempts >= MAX_ATTEMPTS) {
      const failed = { ...job, status: "failed" as const, updatedAt: now, lease: undefined, pendingApproval: undefined, approvalDecision: undefined, lastError: `Worker ${job.lease.workerId} stopped responding after ${job.attempts} attempts` };
      recovered.push(failed);
      return failed;
    }
    // A stale approval belonged to the state the dead worker was in; a fresh claim starts the
    // objective over, so the request itself has nothing left to answer.
    const requeued = { ...job, status: "queued" as const, updatedAt: now, lease: undefined, pendingApproval: undefined, approvalDecision: undefined, lastError: `Worker ${job.lease.workerId} stopped responding` };
    recovered.push(requeued);
    return requeued;
  });
  return { store: { jobs }, recovered };
}

export type JobSummary = { id: string; status: JobStatus; objective: string; attempts: number; detail: string };

/** What `/jobs` shows: state, and the one fact that explains it. */
export function summarize(store: JobStore, now: number, cwd?: string): JobSummary[] {
  return store.jobs
    .filter((job) => cwd === undefined || job.cwd === cwd)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .map((job) => ({
      id: job.id,
      status: job.status,
      objective: job.objective,
      attempts: job.attempts,
      detail: describe(job, now),
    }));
}

function describe(job: Job, now: number): string {
  if (job.status === "paused" && job.pendingApproval) return `waiting on you: ${job.pendingApproval.summary}`;
  if ((job.status === "running" || job.status === "paused") && job.lease) {
    const remaining = Math.round((job.lease.expiresAt - now) / 1_000);
    return remaining > 0 ? `held by ${job.lease.workerId}, lease ${remaining}s` : `lease expired — ${job.lease.workerId} stopped responding`;
  }
  if (job.status === "queued" && job.nextRunAt && job.nextRunAt > now) return `next run ${new Date(job.nextRunAt).toISOString()}`;
  if (job.lastError) return job.lastError;
  return job.cadence ? `${job.cadence} schedule` : "";
}
