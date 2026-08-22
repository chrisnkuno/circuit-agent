use std::{fs, path::Path};

use nova_state::{handle_request, read_journal, Request, SearchOptions, StateIndex};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;

const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn sha256(value: &Value) -> String {
    format!("{:x}", Sha256::digest(serde_json::to_vec(value).unwrap()))
}

fn event(session_id: &str, sequence: u64, previous_hash: &str, payload: Value) -> Value {
    let mut envelope = json!({
        "protocolVersion": 1,
        "sequence": sequence,
        "sessionId": session_id,
        "timestamp": format!("2026-08-14T12:00:{sequence:02}.000Z"),
        "previousHash": previous_hash,
        "payload": payload
    });
    let hash = sha256(&envelope);
    envelope
        .as_object_mut()
        .unwrap()
        .insert("hash".into(), Value::String(hash));
    envelope
}

fn write_journal(root: &Path, session_id: &str, marker: &str) -> Vec<Value> {
    let directory = root.join(".nova/events");
    fs::create_dir_all(&directory).unwrap();
    let mut previous = GENESIS.to_owned();
    let payloads = vec![
        json!({"type":"turn_status","turnId":"turn_1","from":"queued","to":"running"}),
        json!({"type":"runtime","turnId":"turn_1","event":{"type":"tool_call","toolCallId":"c1","toolName":"read_file","effect":"none","arguments":{"path":"src/payment.ts"}}}),
        json!({"type":"runtime","turnId":"turn_1","event":{"type":"tool_result","toolCallId":"c1","toolName":"read_file","isError":false,"effect":"none","content":marker}}),
        json!({"type":"runtime","turnId":"turn_1","event":{"type":"runtime_stop","status":"completed","summary":"Payment migration verified"}}),
    ];
    let mut events = Vec::new();
    for (index, payload) in payloads.into_iter().enumerate() {
        let envelope = event(session_id, index as u64 + 1, &previous, payload);
        previous = envelope["hash"].as_str().unwrap().to_owned();
        events.push(envelope);
    }
    let contents = events
        .iter()
        .map(|value| serde_json::to_string(value).unwrap())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n";
    fs::write(directory.join(format!("{session_id}.jsonl")), contents).unwrap();
    events
}

fn write_snapshot(root: &Path, session_id: &str, title: &str, marker: &str) {
    write_snapshot_messages(
        root,
        session_id,
        title,
        vec![
            json!({"role":"user","content":"Please migrate the checkout payment flow"}),
            json!({"role":"assistant","content":"I will inspect the existing PaymentIntent integration."}),
            json!({"role":"tool","content":"legacy gateway details"}),
            json!({"role":"assistant","content":marker}),
            json!({"role":"user","content":"Run every relevant test"}),
            json!({"role":"assistant","content":"All payment tests passed; no deployment was performed."}),
        ],
    );
}

fn write_snapshot_messages(root: &Path, session_id: &str, title: &str, messages: Vec<Value>) {
    let directory = root.join(".nova/sessions");
    fs::create_dir_all(&directory).unwrap();
    let session = stamped(json!({
        "schemaVersion": 2,
        "revision": 1,
        "id": session_id,
        "createdAt": 100,
        "updatedAt": 200,
        "root": root,
        "title": title,
        "messages": messages,
        "approvals": {},
        "totalRwf": 0
    }));
    fs::write(
        directory.join(format!("{session_id}.json")),
        serde_json::to_vec_pretty(&session).unwrap(),
    )
    .unwrap();
}

/// Sorts keys the way the TypeScript writer's canonicalizer does. Deliberately a second, independent
/// implementation of the rule: a fixture built from the reader's own helper could only ever agree
/// with itself, and what these tests need to pin down is agreement with the writer on disk.
fn canonical(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), canonical(&object[key])))
                    .collect(),
            )
        }
        other => other.clone(),
    }
}

/// Every snapshot the real writer emits carries `integrity`, so every fixture snapshot carries one
/// too — otherwise the tests exercise a verification path production never takes.
fn stamped(mut session: Value) -> Value {
    let digest = sha256(&canonical(&session));
    session
        .as_object_mut()
        .unwrap()
        .insert("integrity".into(), Value::String(digest));
    session
}

fn fixture() -> TempDir {
    let directory = tempfile::tempdir().unwrap();
    write_journal(
        directory.path(),
        "session-a",
        "export const PaymentIntent = 1;",
    );
    write_snapshot(
        directory.path(),
        "session-a",
        "Checkout migration",
        "Implemented idempotent PaymentIntent handling",
    );
    directory
}

#[test]
fn invariant_canonical_sources_are_byte_identical_after_replay() {
    let directory = fixture();
    let journal = directory.path().join(".nova/events/session-a.jsonl");
    let snapshot = directory.path().join(".nova/sessions/session-a.json");
    let before = (fs::read(&journal).unwrap(), fs::read(&snapshot).unwrap());

    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();
    index.rebuild_all().unwrap();

    assert_eq!(fs::read(journal).unwrap(), before.0);
    assert_eq!(fs::read(snapshot).unwrap(), before.1);
}

#[test]
fn invariant_replay_is_idempotent_and_combines_distinct_evidence_sources() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    let once = index.rebuild_all().unwrap();
    let sessions_once = index.sessions(20).unwrap();
    let twice = index.rebuild_all().unwrap();

    assert_eq!(
        (once.sessions, once.events, once.documents),
        (twice.sessions, twice.events, twice.documents)
    );
    assert_eq!(sessions_once.len(), 1);
    assert!(sessions_once[0].has_snapshot);
    assert!(sessions_once[0].has_journal);
    assert_eq!(sessions_once[0].event_count, 4);
}

#[test]
fn invariant_only_verified_journals_become_visible_and_last_good_projection_survives() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();
    assert_eq!(
        index
            .search("PaymentIntent", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );

    let journal = directory.path().join(".nova/events/session-a.jsonl");
    let mut lines: Vec<String> = fs::read_to_string(&journal)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();
    let mut tampered: Value = serde_json::from_str(&lines[2]).unwrap();
    tampered["payload"]["event"]["content"] = json!("corrupt replacement");
    lines[2] = serde_json::to_string(&tampered).unwrap();
    fs::write(&journal, lines.join("\n") + "\n").unwrap();

    let report = index.rebuild_all().unwrap();
    assert_eq!(report.failures.len(), 1);
    assert!(report.failures[0].message.contains("integrity"));
    assert_eq!(
        index
            .search("PaymentIntent", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
    assert!(index
        .search("corrupt replacement", SearchOptions::default())
        .unwrap()
        .is_empty());
}

#[test]
fn invariant_crash_truncated_tail_is_ignored_without_weakening_the_chain() {
    let directory = fixture();
    let journal = directory.path().join(".nova/events/session-a.jsonl");
    fs::OpenOptions::new().append(true).open(&journal).unwrap();
    let original = fs::read_to_string(&journal).unwrap();
    fs::write(&journal, format!("{original}{{\"protocolVersion\":1")).unwrap();
    assert_eq!(read_journal(&journal, "session-a").unwrap().events.len(), 4);
}

#[test]
fn behavior_search_returns_one_session_with_context_bookends_and_provenance() {
    let directory = fixture();
    write_journal(
        directory.path(),
        "session-b",
        "PaymentIntent retry behavior",
    );
    write_snapshot(
        directory.path(),
        "session-b",
        "Retry analysis",
        "Investigated PaymentIntent retries",
    );
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();

    let hits = index
        .search(
            "PaymentIntent",
            SearchOptions {
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(hits.len(), 2);
    assert!(hits.iter().all(|hit| !hit.context.is_empty()));
    assert!(hits
        .iter()
        .all(|hit| hit.context.iter().any(|document| document.anchor)));
    assert!(hits
        .iter()
        .all(|hit| !hit.bookend_start.is_empty() && !hit.bookend_end.is_empty()));
    assert!(hits.iter().all(|hit| hit
        .why
        .iter()
        .any(|reason| reason.contains("evidence source"))));
}

#[test]
fn behavior_query_syntax_is_data_not_fts_control_language() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();
    for query in [
        "PaymentIntent OR *",
        "\"unterminated",
        "NOT",
        "payment.ts",
        "   ",
    ] {
        assert!(
            index.search(query, SearchOptions::default()).is_ok(),
            "query failed: {query}"
        );
    }
}

#[test]
fn behavior_dense_sessions_cannot_starve_shorter_matching_sessions() {
    let directory = fixture();
    let dense = (0..1_000).map(|position| json!({"role":"assistant","content":format!("PaymentIntent dense match {position}")})).collect();
    write_snapshot_messages(directory.path(), "dense", "Dense session", dense);
    write_snapshot_messages(
        directory.path(),
        "sparse",
        "Sparse session",
        vec![json!({"role":"assistant","content":"One useful PaymentIntent match"})],
    );
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();

    let hits = index
        .search(
            "PaymentIntent",
            SearchOptions {
                limit: Some(10),
                ..Default::default()
            },
        )
        .unwrap();
    let sessions = hits
        .iter()
        .map(|hit| hit.session_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    assert!(sessions.contains("dense"));
    assert!(sessions.contains("sparse"));
    assert_eq!(sessions.len(), hits.len());
}

#[test]
fn invariant_search_storage_redacts_credentials_and_bounds_large_messages() {
    let directory = fixture();
    let large = format!(
        "bounded-prefix\nAPI_KEY=super-secret-value\n{}",
        "z".repeat(10_000)
    );
    write_snapshot_messages(
        directory.path(),
        "sensitive",
        "Sensitive session",
        vec![json!({"role":"user","content":large})],
    );
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();

    assert!(index
        .search("super-secret-value", SearchOptions::default())
        .unwrap()
        .is_empty());
    let hit = index
        .search("bounded-prefix", SearchOptions::default())
        .unwrap()
        .remove(0);
    assert!(hit.context[0].text.contains("[REDACTED]"));
    assert!(hit.context[0].text.contains("chars omitted"));
    assert!(hit.context[0].text.chars().count() < 8_100);
}

#[test]
fn behavior_role_filters_are_applied_before_session_ranking() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();
    let assistant = index
        .search(
            "PaymentIntent",
            SearchOptions {
                role_filter: Some(vec!["assistant".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    let user = index
        .search(
            "PaymentIntent",
            SearchOptions {
                role_filter: Some(vec!["user".into()]),
                ..Default::default()
            },
        )
        .unwrap();
    assert_eq!(assistant.len(), 1);
    assert!(assistant
        .iter()
        .all(|hit| hit.role.as_deref() == Some("assistant")));
    assert!(user.is_empty());
}

#[test]
fn invariant_concurrent_rebuilds_serialize_without_duplicates() {
    let directory = fixture();
    let root = directory.path().to_owned();
    let workers = (0..4)
        .map(|_| {
            let root = root.clone();
            std::thread::spawn(move || {
                let mut index = StateIndex::open(root).unwrap();
                index.rebuild_all().unwrap();
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap();
    }
    let index = StateIndex::open(directory.path()).unwrap();
    assert_eq!(index.sessions(20).unwrap().len(), 1);
    assert_eq!(
        index
            .search("PaymentIntent", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
}

#[test]
fn behavior_protocol_is_versioned_bounded_and_structured() {
    let directory = fixture();
    let ping = handle_request(
        serde_json::from_value::<Request>(
            json!({"id":"p","protocolVersion":1,"method":"ping","params":{}}),
        )
        .unwrap(),
    );
    assert!(ping.ok);
    let wrong = handle_request(
        serde_json::from_value::<Request>(
            json!({"id":"v","protocolVersion":99,"method":"ping","params":{}}),
        )
        .unwrap(),
    );
    assert!(!wrong.ok);
    assert_eq!(wrong.error.unwrap().code, "unsupported_protocol");
    let list = handle_request(serde_json::from_value::<Request>(json!({"id":"l","protocolVersion":1,"method":"index.rebuild","params":{"root":directory.path()}})).unwrap());
    assert!(list.ok);
    let context = handle_request(serde_json::from_value::<Request>(json!({
        "id":"c", "protocolVersion":1, "method":"session.context",
        "params":{"root":directory.path(),"sessionId":"session-a","source":"snapshot","position":1,"window":2}
    })).unwrap());
    assert_eq!(context.result.unwrap().as_array().unwrap().len(), 3);
    let oversized = handle_request(serde_json::from_value::<Request>(json!({"id":"q","protocolVersion":1,"method":"search","params":{"root":directory.path(),"query":"x".repeat(1_025)}})).unwrap());
    assert!(!oversized.ok);
    assert!(oversized.error.unwrap().message.contains("1024"));
}

#[test]
fn invariant_schema_mismatch_discards_only_the_projection() {
    let directory = fixture();
    let index_file = {
        let mut index = StateIndex::open(directory.path()).unwrap();
        index.rebuild_all().unwrap();
        index.file().to_owned()
    };
    let database = rusqlite::Connection::open(&index_file).unwrap();
    database
        .execute(
            "UPDATE meta SET value = '999' WHERE key = 'schemaVersion'",
            [],
        )
        .unwrap();
    drop(database);

    let index = StateIndex::open(directory.path()).unwrap();
    assert!(index.sessions(20).unwrap().is_empty());
    assert!(directory
        .path()
        .join(".nova/events/session-a.jsonl")
        .exists());
    assert!(directory
        .path()
        .join(".nova/sessions/session-a.json")
        .exists());
}

/// Snapshots with an explicit `updatedAt`, so ordering tests do not depend on the shared fixture.
fn write_snapshot_at(root: &Path, session_id: &str, updated_at: i64, marker: &str) {
    let directory = root.join(".nova/sessions");
    fs::create_dir_all(&directory).unwrap();
    let session = stamped(json!({
        "schemaVersion": 2, "revision": 1, "id": session_id,
        "createdAt": 1, "updatedAt": updated_at, "root": root,
        "title": format!("Session {session_id}"),
        "messages": [json!({"role":"user","content":marker})],
        "approvals": {}, "totalRwf": 0
    }));
    fs::write(
        directory.join(format!("{session_id}.json")),
        serde_json::to_vec(&session).unwrap(),
    )
    .unwrap();
}

#[test]
fn invariant_verified_events_keep_their_digest_and_field_order() {
    let directory = tempfile::tempdir().unwrap();
    write_journal(directory.path(), "session-a", "PaymentIntent evidence");
    let path = directory.path().join(".nova/events/session-a.jsonl");
    let lines: Vec<String> = fs::read_to_string(&path)
        .unwrap()
        .lines()
        .map(str::to_owned)
        .collect();

    let record = read_journal(&path, "session-a").unwrap();
    assert_eq!(record.events.len(), lines.len());
    for (event, line) in record.events.iter().zip(&lines) {
        // Verification lifts the digest out of the event to hash it; what the index stores has to
        // stay byte-identical to the canonical line on disk.
        assert_eq!(&serde_json::to_string(event).unwrap(), line);
    }
}

#[test]
fn invariant_batched_rebuild_isolates_a_failure_and_stays_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    // Deliberately larger than one write batch, so sessions land either side of a commit boundary.
    for session in 0..80 {
        let messages = (0..100)
            .map(|message| json!({"role":"user","content":format!("session {session} message {message} PaymentIntent evidence")}))
            .collect();
        write_snapshot_messages(
            directory.path(),
            &format!("batch-{session:02}"),
            "Batched session",
            messages,
        );
    }
    fs::write(
        directory.path().join(".nova/sessions/batch-40.json"),
        b"{ not json",
    )
    .unwrap();

    let mut index = StateIndex::open(directory.path()).unwrap();
    let report = index.rebuild_all().unwrap();
    assert_eq!(report.sessions, 79);
    assert_eq!(report.documents, 7_900);
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].session_id.as_deref(), Some("batch-40"));

    let repeated = index.rebuild_all().unwrap();
    assert_eq!(
        (repeated.sessions, repeated.documents),
        (report.sessions, report.documents)
    );
    assert_eq!(index.sessions(500).unwrap().len(), 79);
    // A session from every batch remains individually retrievable after the corrupt neighbour.
    for session in ["batch-00", "batch-39", "batch-41", "batch-79"] {
        assert_eq!(
            index
                .search(
                    "PaymentIntent",
                    SearchOptions {
                        session_id: Some(session.into()),
                        ..Default::default()
                    },
                )
                .unwrap()
                .len(),
            1
        );
    }
}

#[test]
fn invariant_reindexing_replaces_rather_than_accumulates_documents() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    let first = index.rebuild_all().unwrap();

    write_snapshot(
        directory.path(),
        "session-a",
        "Checkout migration",
        "Replaced PaymentIntent evidence",
    );
    let second = index.rebuild_all().unwrap();
    assert_eq!(second.documents, first.documents);
    let hit = index
        .search("PaymentIntent", SearchOptions::default())
        .unwrap()
        .remove(0);
    assert_eq!(hit.context.len(), 6);
    assert!(index
        .search("Implemented idempotent", SearchOptions::default())
        .unwrap()
        .is_empty());

    // Removing the sources retires the projection instead of leaving orphaned FTS rows behind.
    fs::remove_file(directory.path().join(".nova/sessions/session-a.json")).unwrap();
    fs::remove_file(directory.path().join(".nova/events/session-a.jsonl")).unwrap();
    index.rebuild_all().unwrap();
    assert!(index.sessions(20).unwrap().is_empty());
    assert!(index
        .search("PaymentIntent", SearchOptions::default())
        .unwrap()
        .is_empty());
}

#[test]
fn behavior_sort_order_selects_which_sessions_a_limit_keeps() {
    let directory = tempfile::tempdir().unwrap();
    for (session_id, updated_at) in [("oldest", 10), ("middle", 20), ("newest", 30)] {
        write_snapshot_at(
            directory.path(),
            session_id,
            updated_at,
            "PaymentIntent evidence",
        );
    }
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();

    // Options arrive from the client as JSON, which is also the only way to name a sort order.
    let sessions = |sort: &str| {
        let options: SearchOptions =
            serde_json::from_value(json!({"limit": 2, "sort": sort})).unwrap();
        index
            .search("PaymentIntent", options)
            .unwrap()
            .into_iter()
            .map(|hit| hit.session_id)
            .collect::<Vec<_>>()
    };
    assert_eq!(sessions("newest"), ["newest", "middle"]);
    assert_eq!(sessions("oldest"), ["oldest", "middle"]);
    assert_eq!(sessions("relevance").len(), 2);
}

#[test]
fn behavior_empty_sources_index_without_documents_or_panics() {
    let directory = tempfile::tempdir().unwrap();
    write_snapshot_messages(directory.path(), "empty", "Empty session", Vec::new());
    fs::create_dir_all(directory.path().join(".nova/events")).unwrap();
    fs::write(directory.path().join(".nova/events/empty.jsonl"), "").unwrap();

    let mut index = StateIndex::open(directory.path()).unwrap();
    let report = index.rebuild_all().unwrap();
    assert_eq!(
        (report.sessions, report.events, report.documents),
        (1, 0, 0)
    );
    let summary = index.sessions(20).unwrap().remove(0);
    assert!(summary.has_snapshot && summary.has_journal);
    assert_eq!(summary.event_count, 0);
    assert!(index
        .search("anything", SearchOptions::default())
        .unwrap()
        .is_empty());
    assert!(index
        .context("empty", "snapshot", 1, 5, None)
        .unwrap()
        .is_empty());
}

#[test]
fn invariant_tampered_snapshot_is_rejected_and_the_projection_survives() {
    let directory = fixture();
    let mut index = StateIndex::open(directory.path()).unwrap();
    index.rebuild_all().unwrap();

    // The digest covers the canonical record, so editing any field without restamping breaks it.
    let snapshot = directory.path().join(".nova/sessions/session-a.json");
    let mut session: Value = serde_json::from_str(&fs::read_to_string(&snapshot).unwrap()).unwrap();
    session["messages"][3]["content"] = json!("forged PaymentIntent conclusion");
    fs::write(&snapshot, serde_json::to_vec_pretty(&session).unwrap()).unwrap();

    let report = index.rebuild_all().unwrap();
    assert_eq!(report.failures.len(), 1);
    assert_eq!(report.failures[0].source, "snapshot");
    assert!(report.failures[0].message.contains("integrity"));
    assert!(index
        .search("forged", SearchOptions::default())
        .unwrap()
        .is_empty());
    assert_eq!(
        index
            .search("Implemented idempotent", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
}

/// Mirrors the document queries in `index.rs`. They are the only reason the `documents` table has a
/// multi-column index at all, and the plan is the only place a silently unusable index shows up:
/// each one has to be answered by an index search, never by walking the table.
const DOCUMENT_QUERIES: [&str; 4] = [
    "SELECT id, source, source_position, role, kind, text FROM documents WHERE session_id = ? AND source = ? AND source_position BETWEEN ? AND ? ORDER BY source_position",
    "SELECT id, source, source_position, role, kind, text FROM documents WHERE session_id = ? AND source = 'snapshot' AND role IN ('user', 'assistant') ORDER BY source_position DESC LIMIT 3",
    "SELECT id FROM documents WHERE session_id = ?",
    "DELETE FROM documents WHERE session_id = ?",
];

#[test]
fn invariant_document_lookups_never_degrade_to_a_table_scan() {
    let directory = fixture();
    let index_file = {
        let mut index = StateIndex::open(directory.path()).unwrap();
        index.rebuild_all().unwrap();
        index.file().to_owned()
    };
    let database = rusqlite::Connection::open(&index_file).unwrap();
    for query in DOCUMENT_QUERIES {
        let mut statement = database
            .prepare(&format!("EXPLAIN QUERY PLAN {query}"))
            .unwrap();
        // The planner needs the parameters bound, but never their values: it plans on the shape.
        let placeholders = (0..statement.parameter_count()).map(|_| rusqlite::types::Null);
        let plan = statement
            .query_map(rusqlite::params_from_iter(placeholders), |row| {
                row.get::<_, String>(3)
            })
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join(" | ");
        assert!(
            plan.contains("SEARCH documents USING") && plan.contains("INDEX"),
            "query is not index-driven: {query}\nplan: {plan}"
        );
        assert!(!plan.contains("SCAN documents"), "table scan: {query}");
        // An index that cannot supply the order would show up here instead of in the timings.
        assert!(!plan.contains("TEMP B-TREE FOR ORDER BY"), "sort: {query}");
    }
}

#[test]
fn invariant_an_earlier_projection_schema_is_dropped_rather_than_reused() {
    let directory = fixture();
    let index_file = {
        let mut index = StateIndex::open(directory.path()).unwrap();
        index.rebuild_all().unwrap();
        index.file().to_owned()
    };
    // Reconstruct exactly what version 1 left on disk: the same tables plus the redundant index
    // whose removal is what version 2 means.
    let database = rusqlite::Connection::open(&index_file).unwrap();
    database
        .execute_batch(
            "CREATE INDEX documents_context ON documents (session_id, source, source_position);
             UPDATE meta SET value = '1' WHERE key = 'schemaVersion';",
        )
        .unwrap();
    drop(database);

    let mut index = StateIndex::open(directory.path()).unwrap();
    assert!(index.sessions(20).unwrap().is_empty());
    let database = rusqlite::Connection::open(&index_file).unwrap();
    let stale: i64 = database
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'documents_context'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(stale, 0, "the dropped index outlived the schema bump");
    let version: String = database
        .query_row(
            "SELECT value FROM meta WHERE key = 'schemaVersion'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(version, "2");
    drop(database);

    // The canonical sources are untouched, so the discarded projection rebuilds in full.
    index.rebuild_all().unwrap();
    assert_eq!(index.sessions(20).unwrap().len(), 1);
    assert_eq!(
        index
            .search("PaymentIntent", SearchOptions::default())
            .unwrap()
            .len(),
        1
    );
}
