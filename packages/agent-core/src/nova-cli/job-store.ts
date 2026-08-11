import { promises as fs } from "node:fs";
import path from "node:path";
import {
  cancel,
  claim,
  consumeApproval,
  detach,
  emptyStore,
  enqueue,
  finish,
  heartbeat,
  recoverStale,
  requestApproval,
  resolveApproval,
  summarize,
  type ApprovalDecision,
  type ApprovalRequest,
  type CompletionOptions,
  type EnqueueOptions,
  type Job,
  type JobStore,
  type JobSummary,
} from "./jobs";

/**
 * Where jobs live between processes.
 *
 * `jobs.ts` is a pure reducer over `JobStore` — it has no idea a filesystem exists, which is what
 * makes its concurrency guarantees provable. This module is the one place that reads and writes the
 * file, and it exists to give every mutation the same shape: lock, read the current truth, apply one
 * pure transition, write atomically, unlock. A worker process and the interactive CLI calling this
 * at the same moment must never see a torn read or clobber each other's write — that is the whole
 * job of the lock, and it is the same lock-then-rename shape `session.ts` already uses for exactly
 * the same reason.
 */

export function jobStoreFile(root: string): string {
  return path.join(root, ".nova", "jobs.json");
}

export function jobLogPath(root: string, id: string): string {
  return path.join(root, ".nova", "jobs", `${id}.log`);
}

async function readStore(file: string): Promise<JobStore> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<JobStore>;
    return Array.isArray(parsed?.jobs) ? { jobs: parsed.jobs as Job[] } : emptyStore();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    // A corrupt store is not silently treated as empty — that would let a job vanish along with
    // whatever wrote garbage. Surfacing the read failure is what keeps "no jobs" and "broken file"
    // distinguishable.
    throw new Error(`.nova/jobs.json is corrupt: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function acquireLock(lockFile: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const handle = await fs.open(lockFile, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n`, "utf8");
      await handle.close();
      return async () => { await fs.unlink(lockFile).catch(() => undefined); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // A lock older than this is not a live contender — its holder crashed mid-write, and a lock
      // that never expires would mean one dead process permanently wedges every job in the project.
      const stat = await fs.stat(lockFile).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > 10_000) {
        await fs.unlink(lockFile).catch(() => undefined);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("Jobs file is busy — another Nova process is updating it");
}

/**
 * The one place a mutation happens: lock, read, apply, write, unlock.
 *
 * `mutate` is pure and synchronous on purpose — the lock is held for the shortest possible window,
 * and a reducer that cannot await anything cannot accidentally race the very file it is protecting.
 */
export async function withJobs<R>(root: string, mutate: (store: JobStore, now: number) => { store: JobStore; result: R }): Promise<R> {
  const file = jobStoreFile(root);
  const lockFile = `${file}.lock`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const release = await acquireLock(lockFile);
  try {
    const current = await readStore(file);
    const { store, result } = mutate(current, Date.now());
    const temporary = `${file}.${process.pid}.tmp`;
    const handle = await fs.open(temporary, "w", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(store, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, file);
    return result;
  } finally {
    await release();
  }
}

export async function enqueueJob(root: string, options: Omit<EnqueueOptions, "cwd" | "now">): Promise<Job> {
  return withJobs(root, (store, now) => {
    const outcome = enqueue(store, { ...options, cwd: root, now });
    return { store: outcome.store, result: outcome.job };
  });
}

export async function claimJob(root: string, workerId: string, leaseMs: number): Promise<Job | undefined> {
  return withJobs(root, (store, now) => {
    const outcome = claim(store, workerId, now, leaseMs);
    return { store: outcome.store, result: outcome.job };
  });
}

export async function heartbeatJob(root: string, id: string, workerId: string, leaseMs: number): Promise<boolean> {
  return withJobs(root, (store, now) => {
    const outcome = heartbeat(store, id, workerId, now, leaseMs);
    return { store: outcome.store, result: outcome.ok };
  });
}

export async function finishJob(root: string, id: string, workerId: string, outcome: "completed" | "failed", options: Omit<CompletionOptions, "now"> = {}): Promise<boolean> {
  return withJobs(root, (store, now) => {
    const result = finish(store, id, workerId, outcome, { ...options, now });
    return { store: result.store, result: result.ok };
  });
}

export async function detachJob(root: string, id: string, workerId: string): Promise<boolean> {
  return withJobs(root, (store, now) => {
    const outcome = detach(store, id, workerId, now);
    return { store: outcome.store, result: outcome.ok };
  });
}

export async function cancelJob(root: string, id: string): Promise<{ ok: boolean; job?: Job }> {
  return withJobs(root, (store, now) => {
    const outcome = cancel(store, id, now);
    return { store: outcome.store, result: { ok: outcome.ok, job: outcome.store.jobs.find((job) => job.id === id) } };
  });
}

export async function requestJobApproval(root: string, id: string, workerId: string, request: ApprovalRequest): Promise<boolean> {
  return withJobs(root, (store, now) => {
    const outcome = requestApproval(store, id, workerId, request, now);
    return { store: outcome.store, result: outcome.ok };
  });
}

/** The digest names the action being answered; a decision for anything else is refused. */
export async function resolveJobApproval(root: string, id: string, decision: ApprovalDecision, actionDigest: string): Promise<boolean> {
  return withJobs(root, (store, now) => {
    const outcome = resolveApproval(store, id, decision, actionDigest, now);
    return { store: outcome.store, result: outcome.ok };
  });
}

export async function consumeJobApproval(root: string, id: string, workerId: string): Promise<{ decision: ApprovalDecision; actionDigest: string } | undefined> {
  return withJobs(root, (store, now) => {
    const outcome = consumeApproval(store, id, workerId, now);
    return {
      store: outcome.store,
      result: outcome.decision && outcome.actionDigest ? { decision: outcome.decision, actionDigest: outcome.actionDigest } : undefined,
    };
  });
}

/**
 * The read path every listing goes through: recovers silently-dead workers first, so `/jobs` never
 * shows a job "running" under a process that has actually been gone for an hour.
 */
export async function listJobs(root: string): Promise<JobSummary[]> {
  return withJobs(root, (store, now) => {
    const recovered = recoverStale(store, now);
    return { store: recovered.store, result: summarize(recovered.store, now, root) };
  });
}

export async function getJob(root: string, id: string): Promise<Job | undefined> {
  return withJobs(root, (store, now) => {
    const recovered = recoverStale(store, now);
    return { store: recovered.store, result: recovered.store.jobs.find((job) => job.id === id) };
  });
}

/** Monotonic, readable job ids: sortable by creation and safe as a filename. */
export function newJobId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `job-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Appends one line to a job's log, creating the file and its directory on first use. */
export async function appendJobLog(root: string, id: string, line: string): Promise<void> {
  const file = jobLogPath(root, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${line}\n`, "utf8");
}

/** Reads a job's log from a byte offset, for `/attach` to resume where it left off. */
export async function readJobLog(root: string, id: string, fromByte = 0): Promise<{ text: string; nextByte: number }> {
  try {
    const handle = await fs.open(jobLogPath(root, id), "r");
    try {
      const stat = await handle.stat();
      if (fromByte >= stat.size) return { text: "", nextByte: stat.size };
      const buffer = Buffer.alloc(stat.size - fromByte);
      await handle.read(buffer, 0, buffer.length, fromByte);
      return { text: buffer.toString("utf8"), nextByte: stat.size };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: "", nextByte: fromByte };
    throw error;
  }
}
