import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendJobLog,
  cancelJob,
  claimJob,
  consumeJobApproval,
  detachJob,
  enqueueJob,
  finishJob,
  getJob,
  heartbeatJob,
  jobStoreFile,
  listJobs,
  newJobId,
  readJobLog,
  requestJobApproval,
  resolveJobApproval,
  withJobs,
} from "./job-store";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-jobs-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("persisting across separate calls", () => {
  it("round-trips a job the way two different processes would see it", async () => {
    // Each call opens and closes the file itself, exactly like the CLI process and a spawned
    // worker process actually do — nothing here shares in-memory state.
    const job = await enqueueJob(root, { id: newJobId(), objective: "fix the build", logPath: "irrelevant" });
    const claimed = await claimJob(root, "worker-1", 60_000);
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe("running");

    const listed = await listJobs(root);
    expect(listed).toEqual([{ id: job.id, status: "running", objective: "fix the build", attempts: 1, detail: expect.stringContaining("held by worker-1") }]);
  });

  it("writes a real file at .nova/jobs.json", async () => {
    await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    const raw = JSON.parse(await fs.readFile(jobStoreFile(root), "utf8"));
    expect(raw.jobs).toHaveLength(1);
  });

  it("surfaces a corrupt store instead of quietly treating it as empty", async () => {
    await fs.mkdir(path.dirname(jobStoreFile(root)), { recursive: true });
    await fs.writeFile(jobStoreFile(root), "{ not json", "utf8");
    await expect(listJobs(root)).rejects.toThrow("corrupt");
  });

  it("persists a recovery sweep, not just reports it", async () => {
    // listJobs must write back the recovered state — a caller reading again a moment later, or a
    // different process entirely, has to see the same "queued" outcome, not re-derive it.
    const job = await enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" });
    await claimJob(root, "dead-worker", -1); // a lease that already expired the instant it was granted
    const listed = await listJobs(root);
    expect(listed[0].status).toBe("queued");
    expect((await getJob(root, job.id))?.status).toBe("queued");
  });
});

describe("lock contention", () => {
  it("serializes concurrent writers instead of losing one", async () => {
    // Ten jobs enqueued "at once" — the lock must turn this into a queue of atomic writes, or some
    // of them silently overwrite each other in the read-modify-write race.
    await Promise.all(Array.from({ length: 10 }, (_unused, index) => enqueueJob(root, { id: `job-${index}`, objective: `task ${index}`, logPath: "l" })));
    const listed = await listJobs(root);
    expect(listed).toHaveLength(10);
    expect(new Set(listed.map((job) => job.id)).size).toBe(10);
  });

  it("recovers from a lock file left behind by a crashed process", async () => {
    const lockFile = `${jobStoreFile(root)}.lock`;
    await fs.mkdir(path.dirname(lockFile), { recursive: true });
    await fs.writeFile(lockFile, "99999\n", "utf8");
    // Backdate it past the staleness window rather than waiting ten real seconds for the test to
    // observe the same thing.
    const old = new Date(Date.now() - 20_000);
    await fs.utimes(lockFile, old, old);

    await expect(enqueueJob(root, { id: newJobId(), objective: "x", logPath: "l" })).resolves.toBeDefined();
  });
});

describe("the whole lease lifecycle through the file", () => {
  it("claims, heartbeats, and finishes a job across three separate calls", async () => {
    const job = await enqueueJob(root, { id: newJobId(), objective: "write the docs", logPath: "l" });
    const claimed = await claimJob(root, "worker-1", 60_000);
    expect(claimed?.id).toBe(job.id);
    expect(await heartbeatJob(root, job.id, "worker-1", 60_000)).toBe(true);
    expect(await finishJob(root, job.id, "worker-1", "completed", {})).toBe(true);
    expect((await getJob(root, job.id))?.status).toBe("completed");
  });

  it("carries an approval through requestJobApproval / resolveJobApproval / consumeJobApproval", async () => {
    const job = await enqueueJob(root, { id: newJobId(), objective: "deploy", logPath: "l" });
    await claimJob(root, "worker-1", 60_000);
    const request = {
      summary: "run terraform apply", toolName: "run_command", toolCallId: "c1",
      actionDigest: "digest-apply", scopeKey: "nova-approval-v1:digest-apply", policyVersion: "nova-approval-v1",
      effect: "workspace" as const, capabilityId: "workspace.terminal",
    };
    expect(await requestJobApproval(root, job.id, "worker-1", request)).toBe(true);
    expect((await getJob(root, job.id))?.status).toBe("paused");

    // A decision aimed at a different action does not survive the round trip through the file.
    expect(await resolveJobApproval(root, job.id, "allow", "digest-something-else")).toBe(false);
    expect(await resolveJobApproval(root, job.id, "allow", "digest-apply")).toBe(true);
    expect(await consumeJobApproval(root, job.id, "worker-1")).toEqual({ decision: "allow", actionDigest: "digest-apply" });
    expect((await getJob(root, job.id))?.status).toBe("running");
    // Spent: the same action cannot be parked, approved and run a second time.
    expect(await requestJobApproval(root, job.id, "worker-1", request)).toBe(false);
  });

  it("detaches and cancels through the file", async () => {
    const detachable = await enqueueJob(root, { id: newJobId(), objective: "a", logPath: "l" });
    await claimJob(root, "worker-1", 60_000);
    expect(await detachJob(root, detachable.id, "worker-1")).toBe(true);
    expect((await getJob(root, detachable.id))?.status).toBe("queued");

    const cancellable = await enqueueJob(root, { id: newJobId(), objective: "b", logPath: "l" });
    const cancelled = await cancelJob(root, cancellable.id);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.job?.status).toBe("cancelled");
  });
});

describe("logs", () => {
  it("appends and reads back from an offset, for a client resuming a live tail", async () => {
    await appendJobLog(root, "job-1", "first line");
    const first = await readJobLog(root, "job-1");
    expect(first.text).toBe("first line\n");

    await appendJobLog(root, "job-1", "second line");
    const second = await readJobLog(root, "job-1", first.nextByte);
    // Only the new content — a reattaching client should not re-print everything it already saw.
    expect(second.text).toBe("second line\n");
  });

  it("reads an empty result for a log that does not exist yet", async () => {
    expect(await readJobLog(root, "no-such-job")).toEqual({ text: "", nextByte: 0 });
  });
});

describe("withJobs as the escape hatch", () => {
  it("lets a caller apply an arbitrary pure transition under the same lock", async () => {
    const label = await withJobs(root, (store) => ({ store, result: store.jobs.length }));
    expect(label).toBe(0);
  });
});
