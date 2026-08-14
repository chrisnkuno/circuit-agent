use std::{
    env, fs,
    path::Path,
    time::{Duration, Instant},
};

use nova_state::{SearchOptions, StateIndex};
use serde_json::json;
use tempfile::tempdir;

fn argument(name: &str, default: usize) -> usize {
    env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == name)
        .and_then(|pair| pair[1].parse().ok())
        .unwrap_or(default)
}

fn write_corpus(root: &Path, sessions: usize, messages: usize) {
    let directory = root.join(".nova/sessions");
    fs::create_dir_all(&directory).unwrap();
    for session in 0..sessions {
        let messages = (0..messages).map(|message| json!({
            "role": if message % 2 == 0 { "user" } else { "assistant" },
            "content": format!("session {session} message {message}: implement checkout PaymentIntent_{session} with idempotency and verify regression suite")
        })).collect::<Vec<_>>();
        let record = json!({
            "schemaVersion": 2, "revision": 1, "id": format!("bench-{session}"),
            "createdAt": session as i64, "updatedAt": session as i64,
            "root": root, "title": format!("Payment benchmark {session}"),
            "messages": messages, "approvals": {}, "totalRwf": 0
        });
        fs::write(
            directory.join(format!("bench-{session}.json")),
            serde_json::to_vec(&record).unwrap(),
        )
        .unwrap();
    }
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
    let directory = tempdir().expect("temporary benchmark workspace");
    write_corpus(directory.path(), sessions, messages);

    let mut index = StateIndex::open(directory.path()).expect("open index");
    let started = Instant::now();
    let report = index.rebuild_all().expect("rebuild index");
    let index_elapsed = started.elapsed();

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
    let database_bytes = ["", "-wal", "-shm"]
        .iter()
        .map(|suffix| {
            fs::metadata(format!("{}{}", index.file().display(), suffix))
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum::<u64>();
    let output = json!({
        "corpus": { "sessions": sessions, "messagesPerSession": messages, "documents": report.documents },
        "index": {
            "milliseconds": index_elapsed.as_secs_f64() * 1_000.0,
            "documentsPerSecond": report.documents as f64 / index_elapsed.as_secs_f64(),
            "databaseBytes": database_bytes
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
