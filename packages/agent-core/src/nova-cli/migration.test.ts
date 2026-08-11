import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventJournal, NOVA_PROTOCOL_VERSION, eventJournalPath, readEventJournal } from "./protocol";
import { loadSession, newSessionId, sessionDirectory, SESSION_SCHEMA_VERSION, type SessionRecord } from "./session";

/**
 * What happens when a stored file is older, newer, or differently shaped than the code reading it.
 *
 * Every version constant in this package (`SESSION_SCHEMA_VERSION`, `NOVA_PROTOCOL_VERSION`,
 * `CASSETTE_VERSION`, `PROJECTION_SCHEMA_VERSION`) makes the same underlying promise: a version
 * mismatch is either handled explicitly or fails loud, and never silently misinterprets data
 * written under a different shape as if it matched the current one. `cassette.ts` and
 * `projection.ts` already have their own tests for this (a cassette version mismatch throws
 * naming both versions; a projection schema mismatch drops and rebuilds rather than reading stale
 * rows). This file covers the two version fields that did not yet have that check written down:
 * a session record's `schemaVersion` and a journal's `protocolVersion`.
 */

async function writeRawSession(root: string, data: Record<string, unknown>): Promise<string> {
  const directory = sessionDirectory(root);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${data.id}.json`);
  await fs.writeFile(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return file;
}

describe("session schema migration", () => {
  it("refuses a record from a schema version newer than this code understands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
    try {
      const id = newSessionId();
      await writeRawSession(root, {
        schemaVersion: SESSION_SCHEMA_VERSION + 1,
        revision: 0, id, root, title: "from the future", messages: [], approvals: {}, totalRwf: 0,
      });
      // Silently reading this as if it matched the current shape is the failure mode that matters:
      // a field this version doesn't know about yet could be load-bearing, and guessing at its
      // meaning is worse than admitting the session cannot be resumed.
      expect(await loadSession(root, id)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts a record with no schemaVersion field at all — the oldest possible shape", async () => {
    // Versioning was added to this format at some point; every session that predates it has no
    // `schemaVersion` key whatsoever, not a `schemaVersion: 1`. A migration path that only handles
    // explicit old version numbers and not "the field is simply missing" would strand every
    // session that existed before the field did.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
    try {
      const id = newSessionId();
      await writeRawSession(root, {
        // no schemaVersion at all
        revision: 0, id, root, title: "pre-versioning session",
        messages: [{ role: "user", content: "hello" }], approvals: {}, totalRwf: 0,
      });
      const loaded = await loadSession(root, id);
      expect(loaded).not.toBeNull();
      expect(loaded?.schemaVersion).toBe(SESSION_SCHEMA_VERSION);
      expect(loaded?.title).toBe("pre-versioning session");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not perform field-level migration — only structurally validated fields are guaranteed", async () => {
    // The honest boundary of what "accepts an old record" means here: `loadSession` validates that
    // `messages` is an array, `approvals` is an object, and `totalRwf` is a safe non-negative
    // integer — and stamps whatever else came through unchanged. If a future schema version
    // renames or restructures a field beyond those three, a record from before that change will
    // load successfully but carry the old shape for that field, not the new one. Documented here
    // so a future schema bump is a deliberate decision about this fact, not a surprise.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
    try {
      const id = newSessionId();
      await writeRawSession(root, {
        revision: 0, id, root, title: "t", messages: [], approvals: {}, totalRwf: 0,
        // A field a hypothetical future version might rename or restructure — passed through as-is.
        legacyOnlyField: { shape: "old" },
      });
      const loaded = await loadSession(root, id) as SessionRecord & { legacyOnlyField?: unknown };
      expect(loaded?.legacyOnlyField).toEqual({ shape: "old" });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a record missing a structurally required field, old or new", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
    try {
      const id = newSessionId();
      await writeRawSession(root, { revision: 0, id, root, title: "t", approvals: {}, totalRwf: 0 }); // no messages
      expect(await loadSession(root, id)).toBeNull();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("event journal protocol migration", () => {
  it("fails loud on an unsupported protocol version rather than misreading the events", async () => {
    // Unlike the session format, the journal is an audit trail — silently reinterpreting an event
    // shape it was not written to describe is a worse failure than refusing to read it at all, so
    // there is deliberately no migration path here, only a hard, named refusal.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-migration-"));
    try {
      const sessionId = "s1";
      const journal = new EventJournal(root, sessionId);
      await journal.append({ type: "turn_status", turnId: "t1", from: "queued", to: "running" });
      await journal.close();

      const file = eventJournalPath(root, sessionId);
      const lines = (await fs.readFile(file, "utf8")).trim().split("\n");
      const event = JSON.parse(lines[0]);
      event.protocolVersion = NOVA_PROTOCOL_VERSION + 1;
      // The hash is recomputed over the mutated envelope so this exercises the version check
      // specifically, not a coincidental integrity-hash mismatch.
      await fs.writeFile(file, `${JSON.stringify(event)}\n`);

      await expect(readEventJournal(root, sessionId)).rejects.toThrow(/protocol version/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
