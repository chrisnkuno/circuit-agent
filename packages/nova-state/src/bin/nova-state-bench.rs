use std::{
    env, fs,
    path::Path,
    time::{Duration, Instant},
};

use nova_state::{integrity_for_session, read_journal, read_session, SearchOptions, StateIndex};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::tempdir;

const GENESIS_HASH: &str = "0000000000000000000000000000000000000000000000000000000000000000";

fn argument(name: &str, default: usize) -> usize {
    env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == name)
        .and_then(|pair| pair[1].parse().ok())
        .unwrap_or(default)
}

struct Corpus {
    documents_hint: usize,
    events: usize,
    snapshot_bytes: u64,
    journal_bytes: u64,
}

/// Snapshots carry the `integrity` digest the real writer always stamps, and every session also has
/// the event journal a real workspace accumulates beside it. Both cost real per-record work on the
/// index path — canonicalization plus SHA-256 for a snapshot, a full hash chain for a journal — and
/// a corpus without them measures a workspace shape Nova never actually writes.
fn write_corpus(
    root: &Path,
    sessions: usize,
    messages: usize,
    events_per_session: usize,
    integrity: bool,
) -> Corpus {
    let snapshots = root.join(".nova/sessions");
    let journals = root.join(".nova/events");
    fs::create_dir_all(&snapshots).unwrap();
    fs::create_dir_all(&journals).unwrap();
    let mut corpus = Corpus {
        documents_hint: 0,
        events: 0,
        snapshot_bytes: 0,
        journal_bytes: 0,
    };
    for session in 0..sessions {
        let messages = (0..messages).map(|message| json!({
            "role": if message % 2 == 0 { "user" } else { "assistant" },
            "content": format!("session {session} message {message}: implement checkout PaymentIntent_{session} with idempotency and verify regression suite")
        })).collect::<Vec<_>>();
        corpus.documents_hint += messages.len();
        // Keys are written in the same arbitrary order the TypeScript writer emits them in, because
        // canonicalization — the part the digest pays for — only does work when they are unsorted.
        let mut record = json!({
            "schemaVersion": 2, "revision": 1, "id": format!("bench-{session}"),
            "createdAt": session as i64, "updatedAt": session as i64,
            "root": root, "title": format!("Payment benchmark {session}"),
            "messages": messages, "approvals": {}, "totalRwf": 0
        });
        if integrity {
            let digest = integrity_for_session(record.clone());
            record
                .as_object_mut()
                .unwrap()
                .insert("integrity".into(), Value::String(digest));
        }
        let encoded = serde_json::to_vec(&record).unwrap();
        corpus.snapshot_bytes += encoded.len() as u64;
        fs::write(snapshots.join(format!("bench-{session}.json")), encoded).unwrap();

        if events_per_session == 0 {
            continue;
        }
        let journal = write_journal(&format!("bench-{session}"), session, events_per_session);
        corpus.events += events_per_session;
        // Three of every four journal events project a document; the fourth is a turn status.
        corpus.documents_hint += events_per_session - events_per_session / 4;
        corpus.journal_bytes += journal.len() as u64;
        fs::write(journals.join(format!("bench-{session}.jsonl")), journal).unwrap();
    }
    corpus
}

/// Builds one JSONL journal whose chain verifies: sequence, session identity, previous hash, and a
/// SHA-256 over the event with its own digest removed. The digest is appended last so that lifting
/// it back out reproduces the bytes that were hashed, which is exactly what `read_journal` relies on.
fn write_journal(session_id: &str, session: usize, events: usize) -> String {
    let mut previous_hash = GENESIS_HASH.to_owned();
    let mut lines = String::new();
    for sequence in 1..=events {
        let turn = format!("turn_{}", sequence.div_ceil(4));
        let payload = match sequence % 4 {
            1 => json!({"type":"turn_status","turnId":turn,"from":"queued","to":"running"}),
            2 => {
                json!({"type":"runtime","turnId":turn,"event":{"type":"tool_call","toolCallId":format!("call_{sequence}"),"toolName":"read_file","effect":"none","arguments":{"path":format!("src/checkout/payment-{session}.ts"),"range":[1,240]}}})
            }
            3 => {
                json!({"type":"runtime","turnId":turn,"event":{"type":"tool_result","toolCallId":format!("call_{sequence}"),"toolName":"read_file","isError":false,"effect":"none","content":format!("export const PaymentIntent_{session} = createIntent({{ idempotencyKey: \"key-{sequence}\" }}); // audited in turn {turn}")}})
            }
            _ => {
                json!({"type":"runtime","turnId":turn,"event":{"type":"runtime_stop","status":"completed","summary":format!("Verified PaymentIntent_{session} idempotency for {turn}")}})
            }
        };
        let mut event = json!({
            "protocolVersion": 1,
            "sequence": sequence,
            "sessionId": session_id,
            "timestamp": format!("2026-08-14T12:{:02}:{:02}.000Z", sequence / 60, sequence % 60),
            "previousHash": previous_hash,
            "payload": payload
        });
        let hash = format!("{:x}", Sha256::digest(serde_json::to_vec(&event).unwrap()));
        event
            .as_object_mut()
            .unwrap()
            .insert("hash".into(), Value::String(hash.clone()));
        previous_hash = hash;
        lines.push_str(&serde_json::to_string(&event).unwrap());
        lines.push('\n');
    }
    lines
}

/// Times reading and verifying every source once more, with the index untouched. A rebuild reads,
/// verifies, and writes in one pass, so this is the only way to say how much of that pass is the
/// digest and chain work rather than SQLite. It runs after the rebuild, so both passes see the same
/// warm page cache and the difference is CPU, not disk.
fn time_sources(root: &Path) -> (Duration, Duration) {
    let mut snapshots = Duration::ZERO;
    let mut journals = Duration::ZERO;
    for entry in fs::read_dir(root.join(".nova/sessions")).unwrap().flatten() {
        let path = entry.path();
        let session_id = path.file_stem().unwrap().to_string_lossy().into_owned();
        let started = Instant::now();
        read_session(&path, &session_id).expect("verified snapshot");
        snapshots += started.elapsed();
    }
    for entry in fs::read_dir(root.join(".nova/events")).unwrap().flatten() {
        let path = entry.path();
        let session_id = path.file_stem().unwrap().to_string_lossy().into_owned();
        let started = Instant::now();
        read_journal(&path, &session_id).expect("verified journal");
        journals += started.elapsed();
    }
    (snapshots, journals)
}

fn percentile(samples: &mut [Duration], percentile: f64) -> f64 {
    samples.sort();
    let index = ((samples.len() - 1) as f64 * percentile).round() as usize;
    samples[index].as_secs_f64() * 1_000.0
}

fn main() {
    let sessions = argument("--sessions", 500);
    let messages = argument("--messages", 40);
    let queries = argument("--queries", 200);
    // Journals and snapshot digests default to on because that is what a real workspace holds; the
    // switches exist so a run can price exactly the work an unrepresentative corpus used to hide.
    let events_per_session = argument("--events", 24);
    let integrity = argument("--integrity", 1) != 0;
    let directory = tempdir().expect("temporary benchmark workspace");
    let corpus = write_corpus(
        directory.path(),
        sessions,
        messages,
        events_per_session,
        integrity,
    );

    let mut index = StateIndex::open(directory.path()).expect("open index");
    let started = Instant::now();
    let report = index.rebuild_all().expect("rebuild index");
    let index_elapsed = started.elapsed();
    assert!(
        report.failures.is_empty(),
        "corpus must verify: {:?}",
        report.failures
    );
    assert_eq!(report.documents, corpus.documents_hint);
    assert_eq!(report.events, corpus.events);

    let mut samples = Vec::with_capacity(queries);
    for query in 0..queries {
        let started = Instant::now();
        let term = format!("PaymentIntent_{}", query % sessions);
        let hits = index
            .search(&term, SearchOptions::default())
            .expect("search");
        assert_eq!(hits.len(), 1);
        samples.push(started.elapsed());
    }
    let (snapshot_time, journal_time) = time_sources(directory.path());
    let database_bytes = ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            fs::metadata(format!("{}{}", index.file().display(), suffix))
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum::<u64>();
    let output = json!({
        "corpus": {
            "sessions": sessions,
            "messagesPerSession": messages,
            "documents": report.documents,
            "eventsPerSession": events_per_session,
            "events": report.events,
            "integrity": integrity,
            "snapshotBytes": corpus.snapshot_bytes,
            "journalBytes": corpus.journal_bytes
        },
        "index": {
            "milliseconds": index_elapsed.as_secs_f64() * 1_000.0,
            "documentsPerSecond": report.documents as f64 / index_elapsed.as_secs_f64(),
            "databaseBytes": database_bytes
        },
        "sources": {
            "snapshotMilliseconds": snapshot_time.as_secs_f64() * 1_000.0,
            "journalMilliseconds": journal_time.as_secs_f64() * 1_000.0,
            "shareOfIndex": (snapshot_time + journal_time).as_secs_f64() / index_elapsed.as_secs_f64()
        },
        "search": {
            "queries": queries,
            "p50Milliseconds": percentile(&mut samples.clone(), 0.50),
            "p95Milliseconds": percentile(&mut samples.clone(), 0.95),
            "p99Milliseconds": percentile(&mut samples, 0.99)
        }
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}
