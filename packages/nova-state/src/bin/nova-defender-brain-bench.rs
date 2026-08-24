use std::{fs, hint::black_box, io::Write, time::Instant};

use nova_state::BrainIndex;
use serde_json::Value;

fn argument(name: &str, fallback: usize) -> usize {
    std::env::args()
        .collect::<Vec<_>>()
        .windows(2)
        .find(|pair| pair[0] == name)
        .and_then(|pair| pair[1].parse().ok())
        .unwrap_or(fallback)
}

fn percentile(values: &mut [u128], percentile: f64) -> u128 {
    values.sort_unstable();
    values[((values.len() - 1) as f64 * percentile).round() as usize]
}

fn main() -> anyhow::Result<()> {
    let target_records = argument("--records", 10_000).max(14);
    let query_count = argument("--queries", 2_000).max(1);
    let canonical = fs::read_to_string(format!(
        "{}/defender-knowledge/knowledge-v1.jsonl",
        env!("CARGO_MANIFEST_DIR")
    ))?;
    let base: Vec<Value> = canonical
        .lines()
        .map(serde_json::from_str)
        .collect::<Result<_, _>>()?;
    let sources = tempfile::tempdir()?;
    let data = tempfile::tempdir()?;
    let mut corpus = fs::File::create(sources.path().join("benchmark.jsonl"))?;
    for index in 0..target_records {
        let mut record = base[index % base.len()].clone();
        record["id"] = Value::String(format!(
            "{}-{index}",
            record["id"].as_str().unwrap_or("record")
        ));
        writeln!(corpus, "{}", serde_json::to_string(&record)?)?;
    }
    corpus.sync_all()?;

    let mut brain = BrainIndex::open(sources.path(), data.path())?;
    let rebuild_started = Instant::now();
    let report = brain.rebuild()?;
    let rebuild = rebuild_started.elapsed();
    let unchanged_started = Instant::now();
    let unchanged_report = brain.rebuild()?;
    let unchanged_rebuild = unchanged_started.elapsed();

    let queries = [
        "cloud identity control plane",
        "post quantum migration crypto agility",
        "malware static analysis behavioral detection",
        "vulnerability exploit prioritization KEV EPSS",
        "detection telemetry defense impairment",
        "red team authorization purple team",
        "threat intelligence provenance confidence",
    ];
    let mut timings = Vec::with_capacity(query_count);
    let mut result_chars = Vec::with_capacity(query_count);
    for index in 0..query_count {
        let started = Instant::now();
        let hits = brain.search(black_box(queries[index % queries.len()]), 4, "2026-08-24")?;
        timings.push(started.elapsed().as_micros());
        result_chars.push(
            hits.iter()
                .map(|hit| hit.summary.len() + hit.guidance.len())
                .sum::<usize>(),
        );
        black_box(hits);
    }
    let database_bytes = fs::metadata(data.path().join("brain-v1.sqlite3"))?.len();
    let wal_bytes = fs::metadata(data.path().join("brain-v1.sqlite3-wal"))
        .map(|value| value.len())
        .unwrap_or(0);
    let mean_micros = timings.iter().sum::<u128>() as f64 / timings.len() as f64;
    let mean_chars = result_chars.iter().sum::<usize>() as f64 / result_chars.len() as f64;
    let p50 = percentile(&mut timings.clone(), 0.50);
    let p95 = percentile(&mut timings.clone(), 0.95);
    let p99 = percentile(&mut timings, 0.99);

    println!(
        "records={} rejected={} source_files={}",
        report.records, report.rejected, report.source_files
    );
    println!(
        "cold_rebuild_ms={:.3} records_per_second={:.0}",
        rebuild.as_secs_f64() * 1_000.0,
        report.records as f64 / rebuild.as_secs_f64()
    );
    println!(
        "unchanged_rebuild_ms={:.3} changed={}",
        unchanged_rebuild.as_secs_f64() * 1_000.0,
        unchanged_report.changed
    );
    println!(
        "warm_query_us_mean={mean_micros:.1} p50={p50} p95={p95} p99={p99} queries={query_count}"
    );
    println!("mean_retrieved_chars={mean_chars:.0} result_limit=4");
    println!(
        "database_bytes={} wal_bytes={} bytes_per_record={:.1}",
        database_bytes,
        wal_bytes,
        (database_bytes + wal_bytes) as f64 / report.records as f64
    );
    Ok(())
}
