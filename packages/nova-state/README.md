# nova-state

`nova-state` is Nova's local, rebuildable history index. It verifies the existing session snapshots
and hash-chained event journals, projects them into SQLite WAL + FTS5, and exposes a small versioned
JSON-lines protocol over standard input/output.

The same native sidecar also hosts the **Defensive Brain**, a deliberately separate read model over
the reviewed JSONL corpus in `defender-knowledge/`. It writes only the disposable
`.nova/security-brain/brain-v1.sqlite3`; it never mixes security research with conversation history
and never writes canonical knowledge. Defender mode retrieves at most eight relevant records, so
the corpus size does not become prompt size.

This first milestone is deliberately read-only with respect to canonical Nova state. It writes only
`.nova/state/index-v1.sqlite3`, which can be deleted and rebuilt at any time. Session snapshots,
event journals, memory files, skills, jobs, and checkpoints remain authoritative in their current
human-readable formats.

## Protocol

Every input line is one request and every output line is one response:

```json
{"id":"1","protocolVersion":1,"method":"ping","params":{}}
{"id":"2","protocolVersion":1,"method":"index.rebuild","params":{"root":"/workspace/project"}}
{"id":"3","protocolVersion":1,"method":"search","params":{"root":"/workspace/project","query":"PaymentIntent","limit":5}}
{"id":"4","protocolVersion":1,"method":"session.list","params":{"root":"/workspace/project","limit":20}}
{"id":"5","protocolVersion":1,"method":"brain.rebuild","params":{"sourceRoot":"/installed/defender-knowledge","dataRoot":"/workspace/.nova/security-brain"}}
{"id":"6","protocolVersion":1,"method":"brain.search","params":{"sourceRoot":"/installed/defender-knowledge","dataRoot":"/workspace/.nova/security-brain","query":"post quantum migration","limit":4,"now":"2026-08-24"}}
```

Search returns one best hit per session, a contextual window around the match, opening and closing
session bookends, and a short explanation of why the evidence matched. Snapshot messages and journal
events remain explicitly labelled so derived history never blurs into authoritative audit evidence.
Runtime-generated verification prompts are marked internal and omitted here, so search results and
turn counts never attribute Nova's own nudges to the user.

The CLI uses the sidecar for `/history`, ranked search, status, and its resume chooser. Startup
incrementally indexes changed records; a missing or incompatible binary falls back to verified JSON
rather than making conversation history unavailable.

## Development

```sh
cargo test --manifest-path packages/nova-state/Cargo.toml
cargo fmt --manifest-path packages/nova-state/Cargo.toml -- --check
cargo clippy --manifest-path packages/nova-state/Cargo.toml --all-targets -- -D warnings
cargo run --manifest-path packages/nova-state/Cargo.toml
cargo run --release --features benchmark --manifest-path packages/nova-state/Cargo.toml --bin nova-state-bench -- --sessions 500 --messages 40 --queries 200
cargo run --release --features benchmark --manifest-path packages/nova-state/Cargo.toml --bin nova-defender-brain-bench -- --records 10000 --queries 2000
```

On the 2026-08-24 development machine, the shipped 14-record release benchmark measured a 17.7 ms
cold rebuild, 0.33 ms unchanged-corpus check, 0.062 ms mean warm query, 0.107 ms p95, and 0.242 ms
p99. A deliberately oversized 10,000-record stress corpus used 2.86 KB/record with a truncated WAL;
two runs measured 3.24–5.32 ms mean queries and 7.86–13.90 ms p95. Treat these as regression
baselines, not universal hardware guarantees.

`bun run defender:refresh` uses `EXA_API_KEY` to research each domain against a constrained set of
primary-source domains. It writes mode-0600, ignored `untrusted-candidate` JSONL under
`.nova/security-brain/candidates/`. It cannot modify the active corpus: a human must verify the
linked primary pages, write original defense-only guidance, and promote it through code review.
Use `bun run defender:refresh --force --domain malware-reverse-engineering` for a targeted research
check; targeted and partial runs deliberately do not advance the periodic full-refresh timestamp.

The release invariants and benchmark interpretation rules live in [INVARIANTS.md](./INVARIANTS.md).
