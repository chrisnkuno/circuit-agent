import { promises as fs } from "node:fs";
import path from "node:path";
import { eventJournalPath, readEventJournal, type NovaEventEnvelope, type NovaProtocolPayload } from "./protocol";

/**
 * A queryable view of the event journal, derived and disposable.
 *
 * The JSONL journal is the source of truth and stays that way: it is append-only, hash-chained and
 * verifiable, which is what an audit record has to be. What it is not is answerable. "Which
 * approvals are still waiting?", "what happened after sequence 400?", "which session mentioned
 * `PaymentIntent`?" are all full scans of every line ever written, and a front end that reconnects
 * should not have to replay a session to find its place in it.
 *
 * So this is a *projection*: SQLite built entirely from the journal, holding no fact the journal
 * does not already contain. That single property is what makes it safe. It can be deleted at any
 * time, it can be rebuilt from scratch, a schema change is a rebuild rather than a migration, and
 * a bug here corrupts a cache rather than a record. Everything that writes goes to the journal
 * first and reaches the projection only by being read back.
 *
 * The rule to preserve: **never write a fact here that is not in the journal.** The moment the
 * projection holds something authoritative, deleting it becomes data loss and the whole argument
 * above stops being true.
 */

/** Bumped whenever the tables change. A mismatch drops and rebuilds — never migrates. */
export const PROJECTION_SCHEMA_VERSION = 1 as const;

type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  close(): void;
};

/**
 * Loads `node:sqlite`, without its experimental warning reaching the terminal.
 *
 * The warning is emitted once, at import. Silencing it globally would hide every other warning the
 * process might raise, so `emitWarning` is replaced only for the duration of the import and only
 * for this one message — anything else raised in that window still goes through untouched.
 */
async function loadSqlite(): Promise<{ DatabaseSync: new (path: string) => SqliteDatabase }> {
  const original = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning?.message ?? "";
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    if (type === "ExperimentalWarning" && /sqlite/i.test(text)) return;
    return (original as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    return (await import("node:sqlite")) as unknown as { DatabaseSync: new (path: string) => SqliteDatabase };
  } finally {
    process.emitWarning = original;
  }
}

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE events (
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  timestamp  TEXT NOT NULL,
  type       TEXT NOT NULL,
  turn_id    TEXT,
  hash       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
) STRICT;
CREATE INDEX events_by_type ON events (session_id, type, sequence);
-- One row per approval request, updated in place when its decision arrives. Querying "still
-- waiting" is then an index lookup rather than a join of every request against every decision.
CREATE TABLE approvals (
  session_id    TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  requested_seq INTEGER NOT NULL,
  turn_id       TEXT,
  tool_name     TEXT NOT NULL,
  summary       TEXT NOT NULL,
  decided_seq   INTEGER,
  decision      TEXT,
  PRIMARY KEY (session_id, requested_seq)
) STRICT;
CREATE INDEX approvals_pending ON approvals (session_id, decided_seq);
-- Searchable text, lowercased once at write time so a query is a scan of prepared values rather
-- than a per-row LOWER(). FTS5 is deliberately not used: it is a compile-time option, and a
-- projection that only works on some builds of Node is worse than one that is merely linear.
CREATE TABLE searchable (
  session_id TEXT NOT NULL,
  sequence   INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence, kind)
) STRICT;
`;

export type EventRow = { sessionId: string; sequence: number; timestamp: string; type: string; turnId: string | null; hash: string; payload: NovaProtocolPayload };
export type PendingApproval = { sessionId: string; actionDigest: string; requestedSeq: number; turnId: string | null; toolName: string; summary: string };
export type SearchHit = { sessionId: string; sequence: number; kind: string; text: string };
export type SessionRow = { sessionId: string; events: number; firstAt: string; lastAt: string; lastSequence: number };

function textOf(payload: NovaProtocolPayload): Array<{ kind: string; text: string }> {
  if (payload.type === "runtime") {
    const event = payload.event;
    if (event.type === "tool_call") return [{ kind: "tool_call", text: `${event.toolName} ${JSON.stringify(event.arguments)}` }];
    if (event.type === "tool_result") return [{ kind: "tool_result", text: event.content }];
    if (event.type === "runtime_stop") return [{ kind: "summary", text: event.summary }];
    return [];
  }
  if (payload.type === "approval_requested") return [{ kind: "approval", text: payload.request.summary }];
  return [];
}

export class SessionProjection {
  private constructor(private readonly database: SqliteDatabase, readonly root: string, readonly file: string) {}

  /**
   * Opens the projection, creating or resetting it as needed.
   *
   * A schema mismatch, a missing file or an unreadable one all take the same path — start over —
   * because rebuilding is cheap and correct, and the alternative is migration code for a cache.
   */
  static async open(root: string, options: { file?: string } = {}): Promise<SessionProjection> {
    const file = options.file ?? path.join(root, ".nova", "projection.db");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const { DatabaseSync } = await loadSqlite();

    const build = (): SqliteDatabase => {
      const database = new DatabaseSync(file);
      database.exec(SCHEMA);
      database.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("schemaVersion", String(PROJECTION_SCHEMA_VERSION));
      return database;
    };

    let database: SqliteDatabase;
    try {
      database = new DatabaseSync(file);
      const row = database.prepare("SELECT value FROM meta WHERE key = 'schemaVersion'").get() as { value?: string } | undefined;
      if (row?.value !== String(PROJECTION_SCHEMA_VERSION)) {
        database.close();
        await fs.rm(file, { force: true });
        database = build();
      }
    } catch {
      // Corrupt, truncated, or written by a version that structured it differently. It holds
      // nothing the journal does not, so the cheapest correct response is to throw it away.
      await fs.rm(file, { force: true });
      database = build();
    }
    return new SessionProjection(database, root, file);
  }

  close(): void {
    this.database.close();
  }

  /**
   * Rebuilds one session from its journal.
   *
   * Idempotent by construction: the session's rows are cleared first, then written from the
   * journal in order, so rebuilding twice leaves exactly what rebuilding once did. `readEventJournal`
   * verifies the hash chain, so a journal that has been tampered with fails here rather than being
   * projected into something queryable and wrong.
   */
  async rebuild(sessionId: string): Promise<{ events: number }> {
    const events = await readEventJournal(this.root, sessionId);
    this.database.exec("BEGIN");
    try {
      for (const table of ["events", "approvals", "searchable"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
      const insertEvent = this.database.prepare("INSERT INTO events (session_id, sequence, timestamp, type, turn_id, hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)");
      const insertApproval = this.database.prepare("INSERT INTO approvals (session_id, action_digest, requested_seq, turn_id, tool_name, summary) VALUES (?, ?, ?, ?, ?, ?)");
      const decideApproval = this.database.prepare(
        "UPDATE approvals SET decided_seq = ?, decision = ? WHERE session_id = ? AND action_digest = ? AND decided_seq IS NULL",
      );
      const insertText = this.database.prepare("INSERT INTO searchable (session_id, sequence, kind, text) VALUES (?, ?, ?, ?)");

      for (const event of events) {
        const payload = event.payload;
        const turnId = "turnId" in payload ? payload.turnId : null;
        insertEvent.run(sessionId, event.sequence, event.timestamp, payload.type, turnId, event.hash, JSON.stringify(payload));
        if (payload.type === "approval_requested") {
          insertApproval.run(sessionId, payload.request.actionDigest, event.sequence, turnId, payload.request.toolName, payload.request.summary);
        }
        if (payload.type === "approval_decided") {
          decideApproval.run(event.sequence, payload.decision, sessionId, payload.actionDigest);
        }
        for (const entry of textOf(payload)) insertText.run(sessionId, event.sequence, entry.kind, entry.text.toLowerCase());
      }
      this.database.exec("COMMIT");
      return { events: events.length };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Rebuilds every session with a journal on disk. */
  async rebuildAll(): Promise<{ sessions: number; events: number }> {
    const directory = path.dirname(eventJournalPath(this.root, "placeholder"));
    const files = await fs.readdir(directory).catch(() => [] as string[]);
    let events = 0;
    let sessions = 0;
    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const result = await this.rebuild(file.slice(0, -6));
      events += result.events;
      sessions += 1;
    }
    return { sessions, events };
  }

  /**
   * Events after a cursor, for a client catching up.
   *
   * The cursor is the last sequence a client actually processed, so passing 0 replays everything
   * and passing the last value it saw returns exactly what it missed — no gap, no repeat.
   */
  eventsAfter(sessionId: string, cursor: number, limit = 500): EventRow[] {
    const rows = this.database.prepare(
      "SELECT session_id, sequence, timestamp, type, turn_id, hash, payload FROM events WHERE session_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
    ).all(sessionId, cursor, limit) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      sequence: row.sequence as number,
      timestamp: row.timestamp as string,
      type: row.type as string,
      turnId: (row.turn_id as string | null) ?? null,
      hash: row.hash as string,
      payload: JSON.parse(row.payload as string) as NovaProtocolPayload,
    }));
  }

  /** The highest sequence projected for a session — where a reconnecting client resumes from. */
  cursor(sessionId: string): number {
    const row = this.database.prepare("SELECT MAX(sequence) AS last FROM events WHERE session_id = ?").get(sessionId) as { last?: number | null } | undefined;
    return row?.last ?? 0;
  }

  /** Requests with no decision recorded. Across all sessions when none is named. */
  pendingApprovals(sessionId?: string): PendingApproval[] {
    const rows = (sessionId
      ? this.database.prepare("SELECT * FROM approvals WHERE decided_seq IS NULL AND session_id = ? ORDER BY requested_seq").all(sessionId)
      : this.database.prepare("SELECT * FROM approvals WHERE decided_seq IS NULL ORDER BY session_id, requested_seq").all()
    ) as Array<Record<string, string | number | null>>;
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      actionDigest: row.action_digest as string,
      requestedSeq: row.requested_seq as number,
      turnId: (row.turn_id as string | null) ?? null,
      toolName: row.tool_name as string,
      summary: row.summary as string,
    }));
  }

  /** Case-insensitive substring search over tool calls, results and summaries. */
  search(query: string, options: { sessionId?: string; limit?: number } = {}): SearchHit[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    // `\` escapes the LIKE wildcards, so searching for a literal `%` or `_` finds those characters
    // rather than matching everything.
    const pattern = `%${needle.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
    const limit = options.limit ?? 50;
    const rows = (options.sessionId
      ? this.database.prepare("SELECT * FROM searchable WHERE text LIKE ? ESCAPE '\\' AND session_id = ? ORDER BY sequence LIMIT ?").all(pattern, options.sessionId, limit)
      : this.database.prepare("SELECT * FROM searchable WHERE text LIKE ? ESCAPE '\\' ORDER BY session_id, sequence LIMIT ?").all(pattern, limit)
    ) as Array<Record<string, string | number>>;
    return rows.map((row) => ({ sessionId: row.session_id as string, sequence: row.sequence as number, kind: row.kind as string, text: row.text as string }));
  }

  /** Every projected session, most recently active first. */
  sessions(): SessionRow[] {
    const rows = this.database.prepare(
      "SELECT session_id, COUNT(*) AS events, MIN(timestamp) AS first_at, MAX(timestamp) AS last_at, MAX(sequence) AS last_sequence FROM events GROUP BY session_id ORDER BY last_at DESC",
    ).all() as Array<Record<string, string | number>>;
    return rows.map((row) => ({
      sessionId: row.session_id as string,
      events: row.events as number,
      firstAt: row.first_at as string,
      lastAt: row.last_at as string,
      lastSequence: row.last_sequence as number,
    }));
  }

  /**
   * Copies a session's projected events under a new id, up to and including `throughSequence`.
   *
   * This is the read-model half of forking — enough to browse and query the fork immediately. The
   * journal for the new id is the caller's to write, and until it does, the fork is a view of
   * history rather than a session that can be continued.
   */
  fork(sessionId: string, newSessionId: string, throughSequence: number): { events: number } {
    if (newSessionId === sessionId) throw new Error("A fork needs a different session id");
    this.database.exec("BEGIN");
    try {
      for (const table of ["events", "approvals", "searchable"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(newSessionId);
      }
      this.database.prepare(
        "INSERT INTO events (session_id, sequence, timestamp, type, turn_id, hash, payload) SELECT ?, sequence, timestamp, type, turn_id, hash, payload FROM events WHERE session_id = ? AND sequence <= ?",
      ).run(newSessionId, sessionId, throughSequence);
      this.database.prepare(
        "INSERT INTO approvals (session_id, action_digest, requested_seq, turn_id, tool_name, summary, decided_seq, decision) SELECT ?, action_digest, requested_seq, turn_id, tool_name, summary, decided_seq, decision FROM approvals WHERE session_id = ? AND requested_seq <= ?",
      ).run(newSessionId, sessionId, throughSequence);
      this.database.prepare(
        "INSERT INTO searchable (session_id, sequence, kind, text) SELECT ?, sequence, kind, text FROM searchable WHERE session_id = ? AND sequence <= ?",
      ).run(newSessionId, sessionId, throughSequence);
      this.database.exec("COMMIT");
      return { events: this.cursor(newSessionId) === 0 ? 0 : this.eventsAfter(newSessionId, 0, Number.MAX_SAFE_INTEGER).length };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Drops a session from the projection.
   *
   * Archiving removes it from the queryable view and nothing else — the journal is untouched, so
   * `rebuild` brings it straight back. Deleting the record is a separate, deliberate act on the
   * journal itself, which is as it should be for an audit trail.
   */
  archive(sessionId: string): void {
    this.database.exec("BEGIN");
    try {
      for (const table of ["events", "approvals", "searchable"]) {
        this.database.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
