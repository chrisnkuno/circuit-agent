# nova-state invariants

These are release properties, not implementation aspirations. A change to the state engine is not
complete until the relevant invariant remains covered by an automated behavioral test.

1. **Canonical immutability.** Index and search operations never modify session snapshots, event
   journals, memory files, skills, jobs, checkpoints, task definitions, or run journals.
2. **Verified before visible.** A journal event is queryable only after its protocol version,
   sequence, session identity, previous hash, and content hash have all been verified.
3. **Atomic session replacement.** Re-indexing one session either replaces all its derived rows or
   leaves the last verified projection intact.
4. **Idempotent replay.** Rebuilding the same canonical inputs produces the same logical sessions,
   events, documents, and search results without duplicates.
5. **Failure isolation.** One corrupt or future-version source does not destroy another session's
   valid index, and does not replace that source's last verified projection.
6. **Source fidelity.** Every result identifies whether it came from a resumable snapshot or an
   immutable journal. Derived summaries are never presented as original messages.
7. **Credential minimization.** Obvious assigned credentials, authorization headers, cookies, and
   private-key material are redacted before text enters SQLite or FTS5.
8. **Bounded behavior.** Result counts and context windows have hard limits. Queries are treated as
   data, not executable FTS control syntax.
9. **Disposable schema.** An unknown projection schema is reset transactionally and rebuilt;
   canonical sources are never migrated or deleted as part of projection recovery.
10. **Versioned protocol.** Every request and response carries a protocol version. Unsupported
    clients fail explicitly rather than receiving a plausibly valid but misinterpreted response.
11. **Deterministic evidence ranking.** Equal canonical inputs and options produce stable ranking,
    context windows, bookends, and provenance explanations.
12. **Local hot path.** Indexing and retrieval require no network service, model call, embedding
    download, telemetry endpoint, or permanently installed daemon.
13. **Concurrent-process safety.** Schema initialization and replay writers serialize before
    mutation; a second Nova process cannot delete, split, or partially replace the active index.

## Benchmark contract

`nova-state-bench` generates an isolated synthetic corpus and reports indexing throughput, SQLite
size, and p50/p95/p99 search latency as JSON. CI should retain results as artifacts and compare
trends, but should not use absolute developer-machine timings as a flaky pass/fail gate.

The corpus has to be shaped like a real workspace or the benchmark prices work Nova never does:
every snapshot carries the `integrity` digest the writer always stamps, and every session has the
event journal that accumulates beside it, so canonicalization, digest verification, and hash-chain
replay are all on the measured path. The `sources` block reports what that verification costs on its
own. `--events 0` and `--integrity 0` exist only to price those two paths by comparison; a run that
is meant to represent Nova leaves both at their defaults.

```sh
cargo run --release --features benchmark --manifest-path packages/nova-state/Cargo.toml \
  --bin nova-state-bench -- --sessions 500 --messages 40 --queries 200
```
