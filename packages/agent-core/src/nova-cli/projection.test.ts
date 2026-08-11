import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventJournal, eventJournalPath, readEventJournal } from "./protocol";
import { PROJECTION_SCHEMA_VERSION, SessionProjection } from "./projection";

let root: string;
let projection: SessionProjection;

/** Writes a realistic session to the journal: a turn, an approval, tools, a stop. */
async function writeSession(sessionId: string, options: { decideApproval?: boolean } = {}): Promise<void> {
  const journal = new EventJournal(root, sessionId);
  const turnId = `turn_${sessionId}`;
  await journal.append({ type: "turn_status", turnId, from: "queued", to: "running" });
  await journal.append({
    type: "runtime", turnId,
    event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "app.ts" } },
  });
  await journal.append({
    type: "runtime", turnId,
    event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "export const PaymentIntent = 1;" },
  });
  await journal.append({
    type: "approval_requested", turnId,
    request: {
      toolCallId: "c2", toolName: "run_command", summary: "run npm test",
      actionDigest: "digest-1", scopeKey: "nova-approval-v2:digest-1", policyVersion: "nova-approval-v2",
      effect: "workspace", capabilityId: "workspace.terminal",
    },
  });
  if (options.decideApproval) {
    await journal.append({ type: "approval_decided", turnId, actionDigest: "digest-1", decision: "allow" });
  }
  await journal.append({ type: "runtime", turnId, event: { type: "runtime_stop", status: "completed", summary: "All done." } });
  await journal.close();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-projection-"));
  projection = await SessionProjection.open(root);
});

afterEach(async () => {
  projection.close();
  await fs.rm(root, { recursive: true, force: true });
});

describe("the projection is derived, never authoritative", () => {
  it("holds exactly what the journal holds, in order", async () => {
    await writeSession("s1");
    const { events } = await projection.rebuild("s1");
    const journal = await readEventJournal(root, "s1");

    expect(events).toBe(journal.length);
    const rows = projection.eventsAfter("s1", 0);
    expect(rows.map((row) => row.sequence)).toEqual(journal.map((event) => event.sequence));
    expect(rows.map((row) => row.hash)).toEqual(journal.map((event) => event.hash));
    expect(rows.map((row) => row.payload)).toEqual(journal.map((event) => event.payload));
  });

  it("survives being deleted entirely, because it can always be rebuilt", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    const before = projection.eventsAfter("s1", 0);
    projection.close();

    // The whole point of the design: losing this file loses nothing.
    await fs.rm(path.join(root, ".nova", "projection.db"), { force: true });
    projection = await SessionProjection.open(root);
    expect(projection.eventsAfter("s1", 0)).toEqual([]);
    await projection.rebuild("s1");
    expect(projection.eventsAfter("s1", 0)).toEqual(before);
  });

  it("starts over rather than migrating when the schema version moves", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    projection.close();

    const file = path.join(root, ".nova", "projection.db");
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(file);
    database.prepare("UPDATE meta SET value = ? WHERE key = 'schemaVersion'").run(String(PROJECTION_SCHEMA_VERSION + 1));
    database.close();

    projection = await SessionProjection.open(root);
    // Reset, not migrated — and no error, because a stale cache is not a failure.
    expect(projection.eventsAfter("s1", 0)).toEqual([]);
    expect((await projection.rebuild("s1")).events).toBeGreaterThan(0);
  });

  it("throws away a corrupt database instead of failing to open", async () => {
    projection.close();
    const file = path.join(root, ".nova", "projection.db");
    await fs.writeFile(file, "this is not a database");
    projection = await SessionProjection.open(root);
    await writeSession("s1");
    expect((await projection.rebuild("s1")).events).toBeGreaterThan(0);
  });

  it("refuses to project a journal whose hash chain has been broken", async () => {
    // The journal is the record; if it cannot be trusted, neither can anything built from it.
    await writeSession("s1");
    const file = eventJournalPath(root, "s1");
    const lines = (await fs.readFile(file, "utf8")).split("\n").filter(Boolean);
    const tampered = JSON.parse(lines[1]);
    tampered.payload.event.toolName = "rm_rf";
    lines[1] = JSON.stringify(tampered);
    await fs.writeFile(file, `${lines.join("\n")}\n`);

    await expect(projection.rebuild("s1")).rejects.toThrow(/integrity check failed|Invalid Nova event chain/);
  });

  it("is idempotent: rebuilding twice leaves what rebuilding once left", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    const once = projection.eventsAfter("s1", 0);
    const pendingOnce = projection.pendingApprovals("s1");
    await projection.rebuild("s1");
    expect(projection.eventsAfter("s1", 0)).toEqual(once);
    expect(projection.pendingApprovals("s1")).toEqual(pendingOnce);
  });
});

describe("reconnect cursors", () => {
  it("returns exactly the tail a client missed, with no gap and no repeat", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    const all = projection.eventsAfter("s1", 0);
    expect(all.length).toBeGreaterThan(3);

    // A client that processed the first three asks from there and receives only the rest.
    const tail = projection.eventsAfter("s1", all[2].sequence);
    expect(tail).toEqual(all.slice(3));
    // Concatenating what it had with what it got reproduces the whole stream exactly once.
    expect([...all.slice(0, 3), ...tail]).toEqual(all);
    // A client fully caught up receives nothing.
    expect(projection.eventsAfter("s1", projection.cursor("s1"))).toEqual([]);
  });

  it("reports the cursor a reconnecting client should resume from", async () => {
    expect(projection.cursor("unknown")).toBe(0);
    await writeSession("s1");
    await projection.rebuild("s1");
    const all = projection.eventsAfter("s1", 0);
    expect(projection.cursor("s1")).toBe(all.at(-1)!.sequence);
  });

  it("honours a limit while keeping the order, so paging cannot skip an event", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    const all = projection.eventsAfter("s1", 0);

    const paged: typeof all = [];
    for (let cursor = 0; ;) {
      const page = projection.eventsAfter("s1", cursor, 2);
      if (page.length === 0) break;
      paged.push(...page);
      cursor = page.at(-1)!.sequence;
    }
    expect(paged).toEqual(all);
  });
});

describe("pending approvals", () => {
  it("lists a request that has no decision, and drops it once decided", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    expect(projection.pendingApprovals("s1")).toEqual([
      { sessionId: "s1", actionDigest: "digest-1", requestedSeq: 4, turnId: "turn_s1", toolName: "run_command", summary: "run npm test" },
    ]);

    // Same session, now with the decision recorded in the journal.
    await fs.rm(eventJournalPath(root, "s1"), { force: true });
    await writeSession("s1", { decideApproval: true });
    await projection.rebuild("s1");
    expect(projection.pendingApprovals("s1")).toEqual([]);
  });

  it("answers across every session at once, which is what a supervisor needs", async () => {
    await writeSession("s1");
    await writeSession("s2", { decideApproval: true });
    await writeSession("s3");
    await projection.rebuildAll();
    expect(projection.pendingApprovals().map((row) => row.sessionId)).toEqual(["s1", "s3"]);
  });
});

describe("search", () => {
  it("finds text inside tool results, case-insensitively", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    expect(projection.search("paymentintent").map((hit) => hit.kind)).toEqual(["tool_result"]);
    expect(projection.search("PaymentIntent")).toHaveLength(1);
    expect(projection.search("nothing here")).toEqual([]);
    expect(projection.search("   ")).toEqual([]);
  });

  it("treats LIKE wildcards as literal characters", async () => {
    // Searching for "%" must not match every row, which is what an unescaped LIKE would do.
    const journal = new EventJournal(root, "s1");
    await journal.append({ type: "runtime", turnId: "t", event: { type: "runtime_stop", status: "completed", summary: "100% done" } });
    await journal.append({ type: "runtime", turnId: "t", event: { type: "tool_result", toolCallId: "c", toolName: "read_file", isError: false, effect: "none", content: "no percent sign" } });
    await journal.close();
    await projection.rebuild("s1");

    expect(projection.search("%")).toHaveLength(1);
    expect(projection.search("100%")).toHaveLength(1);
    expect(projection.search("_")).toHaveLength(0);
  });

  it("scopes to one session when asked", async () => {
    await writeSession("s1");
    await writeSession("s2");
    await projection.rebuildAll();
    expect(projection.search("paymentintent")).toHaveLength(2);
    expect(projection.search("paymentintent", { sessionId: "s2" })).toHaveLength(1);
  });
});

describe("fork and archive", () => {
  it("copies history up to a point under a new id, leaving the original alone", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    const all = projection.eventsAfter("s1", 0);
    const cut = all[2].sequence;

    projection.fork("s1", "s1-fork", cut);
    const forked = projection.eventsAfter("s1-fork", 0);
    expect(forked.map((row) => row.sequence)).toEqual(all.slice(0, 3).map((row) => row.sequence));
    expect(forked.map((row) => row.payload)).toEqual(all.slice(0, 3).map((row) => row.payload));
    expect(projection.eventsAfter("s1", 0)).toEqual(all);
    // The approval arrives after the cut, so the fork has not inherited it.
    expect(projection.pendingApprovals("s1-fork")).toEqual([]);
    expect(projection.pendingApprovals("s1")).toHaveLength(1);
  });

  it("refuses to fork a session onto itself", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    expect(() => projection.fork("s1", "s1", 99)).toThrow(/different session id/);
  });

  it("archives a session out of the view without touching the journal", async () => {
    await writeSession("s1");
    await projection.rebuild("s1");
    projection.archive("s1");

    expect(projection.eventsAfter("s1", 0)).toEqual([]);
    expect(projection.pendingApprovals("s1")).toEqual([]);
    expect(projection.search("paymentintent")).toEqual([]);
    // The record itself is untouched, so archiving is reversible by rebuilding.
    expect(await readEventJournal(root, "s1")).toHaveLength(5);
    await projection.rebuild("s1");
    expect(projection.eventsAfter("s1", 0)).toHaveLength(5);
  });

  it("lists sessions with their activity, most recent first", async () => {
    await writeSession("s1");
    await writeSession("s2");
    await projection.rebuildAll();
    const sessions = projection.sessions();
    expect(sessions.map((row) => row.sessionId).sort()).toEqual(["s1", "s2"]);
    for (const session of sessions) {
      expect(session.events).toBe(5);
      expect(session.lastSequence).toBe(5);
      expect(session.firstAt <= session.lastAt).toBe(true);
    }
  });
});
