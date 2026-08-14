# nova-state

`nova-state` is Nova's local, rebuildable history index. It verifies the existing session snapshots
and hash-chained event journals, projects them into SQLite WAL + FTS5, and exposes a small versioned
JSON-lines protocol over standard input/output.

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
```

Search returns one best hit per session, a contextual window around the match, opening and closing
session bookends, and a short explanation of why the evidence matched. Snapshot messages and journal
events remain explicitly labelled so derived history never blurs into authoritative audit evidence.

## Development

```sh
cargo test --manifest-path packages/nova-state/Cargo.toml
cargo run --manifest-path packages/nova-state/Cargo.toml
cargo run --release --features benchmark --manifest-path packages/nova-state/Cargo.toml --bin nova-state-bench -- --sessions 500 --messages 40 --queries 200
```

The release invariants and benchmark interpretation rules live in [INVARIANTS.md](./INVARIANTS.md).
