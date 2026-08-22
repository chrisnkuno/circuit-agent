use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result};
use rusqlite::{
    params, Connection, ErrorCode, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::source::{
    read_journal, read_session, session_id_from_file, JournalRecord, SessionRecord,
};

/// Bumped whenever the projection's on-disk shape changes. `open_initialized` treats any other
/// recorded version as unreadable and drops the projection rather than migrating it: the canonical
/// sources are the truth, so rebuilding is always cheaper and safer than an in-place migration.
/// Version 2 dropped a redundant `documents_context` index.
const INDEX_SCHEMA_VERSION: i64 = 2;
/// Upper bound on the events plus documents a rebuild buffers before committing. It trades a
/// bounded amount of memory and index-lock hold time for far fewer fsyncs than one commit per
/// session, which is what dominated a cold rebuild.
const REBUILD_BATCH_ROWS: usize = 5_000;
const DEFAULT_LIMIT: usize = 5;
const MAX_LIMIT: usize = 50;
const RESET_SCHEMA: &str = r#"
DROP TABLE IF EXISTS documents_fts;
DROP TABLE IF EXISTS documents;
DROP TABLE IF EXISTS events;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS meta;
"#;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  created_at INTEGER,
  updated_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 0,
  event_count INTEGER NOT NULL DEFAULT 0,
  first_event_at TEXT,
  last_event_at TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  has_snapshot INTEGER NOT NULL DEFAULT 0,
  has_journal INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE TABLE IF NOT EXISTS events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
) STRICT;
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_position INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  role TEXT,
  kind TEXT NOT NULL,
  turn_id TEXT,
  text TEXT NOT NULL,
  -- Serves both roles: it rejects duplicate projections of the same source record, and its leading
  -- (session_id, source, source_position) columns are what every context, bookend, and per-session
  -- delete searches on. A separate index over that prefix would only add a B-tree insert per
  -- document and pages on disk; SQLite picks this one for those queries either way.
  UNIQUE (session_id, source, source_position, kind)
) STRICT;
CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
  title,
  text,
  session_id UNINDEXED,
  document_id UNINDEXED,
  tokenize='unicode61 remove_diacritics 2'
);
"#;

/// One verified session waiting to be written: its identifier, snapshot, and journal.
type PendingSession = (String, Option<SessionRecord>, Option<JournalRecord>);

#[derive(Default)]
struct BatchCounts {
    sessions: usize,
    events: usize,
    documents: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFailure {
    pub source: String,
    pub session_id: Option<String>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexReport {
    pub sessions: usize,
    pub events: usize,
    pub documents: usize,
    pub failures: Vec<SourceFailure>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOptions {
    pub session_id: Option<String>,
    pub limit: Option<usize>,
    pub role_filter: Option<Vec<String>>,
    pub sort: Option<SearchSort>,
    pub window: Option<usize>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchSort {
    Relevance,
    Newest,
    Oldest,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextDocument {
    pub id: i64,
    pub source: String,
    pub source_position: i64,
    pub role: Option<String>,
    pub kind: String,
    pub text: String,
    pub anchor: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub session_id: String,
    pub title: String,
    pub score: f64,
    pub source: String,
    pub source_position: i64,
    pub role: Option<String>,
    pub kind: String,
    pub snippet: String,
    pub context: Vec<ContextDocument>,
    pub bookend_start: Vec<ContextDocument>,
    pub bookend_end: Vec<ContextDocument>,
    pub why: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub session_id: String,
    pub title: String,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub revision: i64,
    pub event_count: i64,
    pub last_sequence: i64,
    pub has_snapshot: bool,
    pub has_journal: bool,
}

pub struct StateIndex {
    connection: Connection,
    root: PathBuf,
    file: PathBuf,
}

impl StateIndex {
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root
            .as_ref()
            .canonicalize()
            .with_context(|| format!("workspace does not exist: {}", root.as_ref().display()))?;
        let directory = root.join(".nova/state");
        fs::create_dir_all(&directory)
            .with_context(|| format!("cannot create {}", directory.display()))?;
        let file = directory.join("index-v1.sqlite3");
        let mut attempts = 0;
        let connection = loop {
            match open_initialized(&file) {
                Ok(connection) => break connection,
                Err(error) if is_busy(&error) && attempts < 100 => {
                    attempts += 1;
                    std::thread::sleep(std::time::Duration::from_millis(25));
                }
                Err(error) if is_corrupt(&error) => {
                    for suffix in ["", "-wal", "-shm"] {
                        fs::remove_file(PathBuf::from(format!("{}{}", file.display(), suffix)))
                            .ok();
                    }
                    break open_initialized(&file)?;
                }
                Err(error) => return Err(error.into()),
            }
        };
        Ok(Self {
            connection,
            root,
            file,
        })
    }

    pub fn file(&self) -> &Path {
        &self.file
    }

    pub fn rebuild_all(&mut self) -> Result<IndexReport> {
        let mut source_paths: BTreeMap<String, (Option<PathBuf>, Option<PathBuf>)> =
            BTreeMap::new();
        for (directory, suffix, journal) in [
            (self.root.join(".nova/events"), ".jsonl", true),
            (self.root.join(".nova/sessions"), ".json", false),
        ] {
            for entry in fs::read_dir(directory).into_iter().flatten().flatten() {
                let path = entry.path();
                let Some(session_id) = session_id_from_file(&path, suffix) else {
                    continue;
                };
                let pair = source_paths.entry(session_id).or_default();
                if journal {
                    pair.0 = Some(path);
                } else {
                    pair.1 = Some(path);
                }
            }
        }

        let known: HashSet<String> = source_paths.keys().cloned().collect();
        let stale: Vec<String> = {
            let mut statement = self.connection.prepare("SELECT session_id FROM sessions")?;
            let rows = statement
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows.into_iter().filter(|id| !known.contains(id)).collect()
        };
        if !stale.is_empty() {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for session_id in &stale {
                delete_session_rows(&transaction, session_id)?;
            }
            transaction.commit()?;
        }

        let mut failures = Vec::new();
        let mut counts = BatchCounts::default();
        let mut batch: Vec<PendingSession> = Vec::new();
        let mut batch_rows = 0;
        for (session_id, (journal_path, session_path)) in source_paths {
            let journal = match journal_path {
                Some(path) => match read_journal(&path, &session_id) {
                    Ok(record) => Some(record),
                    Err(error) => {
                        failures.push(SourceFailure {
                            source: "journal".into(),
                            session_id: Some(session_id.clone()),
                            message: error.to_string(),
                        });
                        continue;
                    }
                },
                None => None,
            };
            let session = match session_path {
                Some(path) => match read_session(&path, &session_id) {
                    Ok(record) => Some(record),
                    Err(error) => {
                        failures.push(SourceFailure {
                            source: "snapshot".into(),
                            session_id: Some(session_id.clone()),
                            message: error.to_string(),
                        });
                        continue;
                    }
                },
                None => None,
            };
            batch_rows += journal
                .as_ref()
                .map_or(0, |record| record.events.len() + record.documents.len())
                + session.as_ref().map_or(0, |record| record.documents.len());
            batch.push((session_id, session, journal));
            if batch_rows >= REBUILD_BATCH_ROWS {
                self.write_batch(&mut batch, &mut counts)?;
                batch_rows = 0;
            }
        }
        self.write_batch(&mut batch, &mut counts)?;
        Ok(IndexReport {
            sessions: counts.sessions,
            events: counts.events,
            documents: counts.documents,
            failures,
        })
    }

    /// Writes one batch of already verified sources in a single transaction. Each commit costs a
    /// durable fsync, so committing once per session put the disk on the critical path of a
    /// rebuild; batching keeps the same all-or-nothing replacement per session with far fewer
    /// flushes. Sources are read before the transaction opens so the write lock is never held
    /// across file I/O, and the batch is bounded by row count so peak memory stays predictable.
    fn write_batch(
        &mut self,
        batch: &mut Vec<PendingSession>,
        counts: &mut BatchCounts,
    ) -> Result<()> {
        if batch.is_empty() {
            return Ok(());
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        for (session_id, session, journal) in batch.iter() {
            let (events, documents) =
                replace_session(&transaction, session_id, session.as_ref(), journal.as_ref())?;
            counts.sessions += 1;
            counts.events += events;
            counts.documents += documents;
        }
        transaction.commit()?;
        batch.clear();
        Ok(())
    }

    pub fn sessions(&self, limit: usize) -> Result<Vec<SessionSummary>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT session_id, title, created_at, updated_at, revision, event_count, last_sequence, has_snapshot, has_journal FROM sessions ORDER BY COALESCE(updated_at, 0) DESC, COALESCE(last_event_at, '') DESC LIMIT ?",
        )?;
        let rows = statement.query_map([limit.clamp(1, 500) as i64], |row| {
            Ok(SessionSummary {
                session_id: row.get(0)?,
                title: row.get(1)?,
                created_at: row.get(2)?,
                updated_at: row.get(3)?,
                revision: row.get(4)?,
                event_count: row.get(5)?,
                last_sequence: row.get(6)?,
                has_snapshot: row.get::<_, i64>(7)? != 0,
                has_journal: row.get::<_, i64>(8)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn search(&self, query: &str, options: SearchOptions) -> Result<Vec<SearchHit>> {
        let fts_query = safe_fts_query(query);
        if fts_query.is_empty() {
            return Ok(Vec::new());
        }
        let limit = options.limit.unwrap_or(DEFAULT_LIMIT).clamp(1, MAX_LIMIT);
        let candidate_limit = (limit * 12).min(500) as i64;
        let session_filter = options.session_id.as_deref();
        let roles = options.role_filter.unwrap_or_default();
        let role_filter = roles.join(",");
        let mut session_statement = self.connection.prepare_cached(
            "SELECT d.session_id, MIN(documents_fts.rank) AS best_rank, s.updated_at FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid JOIN sessions s ON s.session_id = d.session_id WHERE documents_fts MATCH ? AND (? IS NULL OR d.session_id = ?) AND (? = '' OR instr(',' || ? || ',', ',' || COALESCE(d.role, '') || ',') > 0) GROUP BY d.session_id ORDER BY best_rank, d.session_id LIMIT ?",
        )?;
        let mut ranked_sessions = session_statement
            .query_map(
                params![
                    fts_query,
                    session_filter,
                    session_filter,
                    role_filter,
                    role_filter,
                    candidate_limit
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, Option<i64>>(2)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // Ordering and truncation happen on the candidate rows, before any evidence is assembled.
        // Every hit costs a best-document lookup, a context window, and two bookend queries, and a
        // relevance search asks for twelve times more candidates than it can ever return.
        match options.sort.unwrap_or(SearchSort::Relevance) {
            // The candidate query already returns best rank ascending, which is score descending.
            SearchSort::Relevance => {}
            SearchSort::Newest => ranked_sessions
                .sort_by_key(|(_, _, updated_at)| std::cmp::Reverse(updated_at.unwrap_or(0))),
            SearchSort::Oldest => {
                ranked_sessions.sort_by_key(|(_, _, updated_at)| updated_at.unwrap_or(i64::MAX))
            }
        }
        ranked_sessions.truncate(limit);

        let mut hits = Vec::with_capacity(ranked_sessions.len());
        let mut hit_statement = self.connection.prepare_cached(
            "SELECT d.id, s.title, d.source, d.source_position, d.role, d.kind, snippet(documents_fts, 1, '[', ']', ' … ', 24), bm25(documents_fts, 5.0, 1.0) FROM documents_fts JOIN documents d ON d.id = documents_fts.rowid JOIN sessions s ON s.session_id = d.session_id WHERE documents_fts MATCH ? AND d.session_id = ? AND (? = '' OR instr(',' || ? || ',', ',' || COALESCE(d.role, '') || ',') > 0) ORDER BY bm25(documents_fts, 5.0, 1.0), d.id LIMIT 1",
        )?;
        for (session_id, session_rank, _updated_at) in ranked_sessions {
            let (id, title, source, source_position, role, kind, snippet, _document_rank) =
                hit_statement.query_row(
                    params![fts_query, session_id, role_filter, role_filter],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                            row.get::<_, i64>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, String>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, f64>(7)?,
                        ))
                    },
                )?;
            let score = -session_rank;
            let window = options.window.unwrap_or(5).clamp(1, 20);
            hits.push(SearchHit {
                context: self.context(&session_id, &source, source_position, window, Some(id))?,
                bookend_start: self.bookend(&session_id, false)?,
                bookend_end: self.bookend(&session_id, true)?,
                why: vec![
                    format!("FTS5 lexical match in {kind}"),
                    format!("evidence source: {source}"),
                ],
                session_id,
                title,
                score,
                source,
                source_position,
                role,
                kind,
                snippet,
            });
        }
        Ok(hits)
    }

    pub fn context(
        &self,
        session_id: &str,
        source: &str,
        position: i64,
        window: usize,
        anchor: Option<i64>,
    ) -> Result<Vec<ContextDocument>> {
        let mut statement = self.connection.prepare_cached(
            "SELECT id, source, source_position, role, kind, text FROM documents WHERE session_id = ? AND source = ? AND source_position BETWEEN ? AND ? ORDER BY source_position",
        )?;
        let rows = statement.query_map(
            params![
                session_id,
                source,
                position - window as i64,
                position + window as i64
            ],
            |row| {
                Ok(ContextDocument {
                    id: row.get(0)?,
                    source: row.get(1)?,
                    source_position: row.get(2)?,
                    role: row.get(3)?,
                    kind: row.get(4)?,
                    text: row.get(5)?,
                    anchor: anchor == row.get::<_, i64>(0).ok(),
                })
            },
        )?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    fn bookend(&self, session_id: &str, end: bool) -> Result<Vec<ContextDocument>> {
        let ordering = if end { "DESC" } else { "ASC" };
        let sql = format!("SELECT id, source, source_position, role, kind, text FROM documents WHERE session_id = ? AND source = 'snapshot' AND role IN ('user', 'assistant') ORDER BY source_position {ordering} LIMIT 3");
        let mut statement = self.connection.prepare_cached(&sql)?;
        let rows = statement.query_map([session_id], |row| {
            Ok(ContextDocument {
                id: row.get(0)?,
                source: row.get(1)?,
                source_position: row.get(2)?,
                role: row.get(3)?,
                kind: row.get(4)?,
                text: row.get(5)?,
                anchor: false,
            })
        })?;
        let mut documents = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        if end {
            documents.reverse();
        }
        Ok(documents)
    }
}

/// Replaces one session's derived rows inside a caller-owned transaction, so a whole batch of
/// sessions shares a single commit while each session still lands all-or-nothing.
fn replace_session(
    transaction: &Transaction<'_>,
    session_id: &str,
    session: Option<&SessionRecord>,
    journal: Option<&JournalRecord>,
) -> Result<(usize, usize)> {
    delete_session_rows(transaction, session_id)?;
    let title = session
        .map(|record| record.title.as_str())
        .unwrap_or("Untitled session");
    let event_count = journal.map(|record| record.events.len()).unwrap_or(0);
    let last_sequence = journal
        .and_then(|record| record.events.last())
        .and_then(|event| event.get("sequence"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    transaction
        .prepare_cached(
            "INSERT INTO sessions (session_id, title, created_at, updated_at, revision, event_count, first_event_at, last_event_at, last_sequence, has_snapshot, has_journal) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )?
        .execute(params![
            session_id,
            title,
            session.map(|record| record.created_at),
            session.map(|record| record.updated_at),
            session.map(|record| record.revision).unwrap_or(0),
            event_count as i64,
            journal.and_then(|record| record.first_at.as_deref()),
            journal.and_then(|record| record.last_at.as_deref()),
            last_sequence,
            i64::from(session.is_some()),
            i64::from(journal.is_some()),
        ])?;

    if let Some(journal) = journal {
        let mut statement = transaction.prepare_cached("INSERT INTO events (session_id, sequence, timestamp, type, turn_id, hash, payload) VALUES (?, ?, ?, ?, ?, ?, ?)")?;
        for event in &journal.events {
            let payload = event.get("payload").unwrap_or(&Value::Null);
            statement.execute(params![
                session_id,
                event.get("sequence").and_then(Value::as_i64).unwrap_or(0),
                event
                    .get("timestamp")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                payload
                    .get("type")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown"),
                payload.get("turnId").and_then(Value::as_str),
                event
                    .get("hash")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                serde_json::to_string(payload)?,
            ])?;
        }
    }

    // Streamed rather than collected: the row count is all the caller needs, and both inserts run
    // from cached statements because they fire once per document in the corpus.
    let documents = session
        .into_iter()
        .flat_map(|record| record.documents.iter())
        .chain(
            journal
                .into_iter()
                .flat_map(|record| record.documents.iter()),
        );
    let mut document_statement = transaction.prepare_cached(
        "INSERT INTO documents (session_id, source, source_position, timestamp, role, kind, turn_id, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )?;
    let mut fts_statement = transaction.prepare_cached(
        "INSERT INTO documents_fts (rowid, title, text, session_id, document_id) VALUES (?, ?, ?, ?, ?)",
    )?;
    let mut document_count = 0;
    for document in documents {
        let id = document_statement.insert(params![
            session_id,
            document.source,
            document.position,
            document.timestamp,
            document.role,
            document.kind,
            document.turn_id,
            document.text
        ])?;
        fts_statement.execute(params![id, title, document.text, session_id, id])?;
        document_count += 1;
    }
    Ok((event_count, document_count))
}

fn is_corrupt(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase)
    )
}

fn is_busy(error: &rusqlite::Error) -> bool {
    matches!(
        error,
        rusqlite::Error::SqliteFailure(failure, _)
            if matches!(failure.code, ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked)
    )
}

fn open_initialized(file: &Path) -> rusqlite::Result<Connection> {
    let connection = Connection::open(file)?;
    connection.busy_timeout(std::time::Duration::from_secs(5))?;
    // Every hot statement in this module is prepared through the cache; the default capacity is
    // smaller than the number of distinct statements a rebuild plus a search touches.
    connection.set_prepared_statement_cache_capacity(32);
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(rusqlite::Error::InvalidQuery);
    }
    connection.pragma_update(None, "synchronous", "FULL")?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    connection.execute_batch("BEGIN EXCLUSIVE")?;
    let initialized = (|| -> rusqlite::Result<()> {
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        )?;
        let version = connection
            .query_row(
                "SELECT value FROM meta WHERE key = 'schemaVersion'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if version.as_deref() != Some(&INDEX_SCHEMA_VERSION.to_string()) {
            connection.execute_batch(RESET_SCHEMA)?;
        }
        connection.execute_batch(SCHEMA)?;
        connection.execute(
            "INSERT INTO meta (key, value) VALUES ('schemaVersion', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [INDEX_SCHEMA_VERSION.to_string()],
        )?;
        Ok(())
    })();
    match initialized {
        Ok(()) => connection.execute_batch("COMMIT")?,
        Err(error) => {
            connection.execute_batch("ROLLBACK").ok();
            return Err(error);
        }
    }
    Ok(connection)
}

/// Uses the connection's statement cache: a rebuild runs these deletes once per session, and
/// re-preparing them each time cost more than the deletes themselves.
///
/// The FTS rows are removed by explicit rowid rather than with `rowid IN (SELECT ...)`, because
/// fts5 cannot turn that subquery into a rowid lookup and scans its whole index instead — once per
/// session, whether or not the session had any indexed rows at all.
fn delete_session_rows(transaction: &Transaction<'_>, session_id: &str) -> Result<()> {
    let indexed: Vec<i64> = transaction
        .prepare_cached("SELECT id FROM documents WHERE session_id = ?")?
        .query_map([session_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if !indexed.is_empty() {
        let mut statement =
            transaction.prepare_cached("DELETE FROM documents_fts WHERE rowid = ?")?;
        for id in indexed {
            statement.execute([id])?;
        }
    }
    for sql in [
        "DELETE FROM documents WHERE session_id = ?",
        "DELETE FROM events WHERE session_id = ?",
        "DELETE FROM sessions WHERE session_id = ?",
    ] {
        transaction.prepare_cached(sql)?.execute([session_id])?;
    }
    Ok(())
}

fn safe_fts_query(query: &str) -> String {
    query
        .split_whitespace()
        .filter_map(|part| {
            let clean: String = part
                .chars()
                .filter(|character| {
                    character.is_alphanumeric() || matches!(character, '_' | '-' | '.' | '/' | ':')
                })
                .collect();
            (!clean.is_empty()).then(|| format!("\"{}\"", clean.replace('"', "\"\"")))
        })
        .collect::<Vec<_>>()
        .join(" AND ")
}
