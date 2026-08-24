# Centralized Defensive Brain pipeline

Nova uses one publishing authority and many read-only local replicas. It does **not** query a
central knowledge service during model turns: that would add latency, leak query context, consume
tokens, and turn an outage into a failed security review.

```text
official sources -> scheduled Exa research -> quarantined candidate artifact -> human review
       -> canonical JSONL in git -> native validation -> signed Vercel feed
       -> six-hour CLI manifest poll -> signature/digest verification -> atomic local replica
       -> Rust index -> query_defensive_brain
```

## Authorities and failure boundaries

- `.github/workflows/defender-brain-pipeline.yml` runs weekly research and uploads candidates for
  review. Web text is untrusted evidence and is never promoted automatically.
- `packages/nova-state/defender-knowledge/knowledge-v1.jsonl` is the reviewed authority. Changes
  require ordinary code review and must pass the Rust corpus validator.
- `/api/defender-brain/manifest` signs a short-lived descriptor. The signing key exists only in the
  hosted environment; `/api/defender-brain/corpus` serves the reviewed bytes with immutable digest
  identity.
- Each CLI checks at most once every six hours, sends `If-None-Match`, downloads only after a
  changed manifest, requires HTTPS and same-origin corpus URLs, verifies Ed25519, refuses rollback
  and same-sequence equivocation, and caps the download at 8 MiB.
- Replicas are stored globally under Nova's config directory, not inside a project. Content is
  written to a digest-named directory before an atomic state pointer activates it.
- The native engine validates/indexes the replica. If it rejects the release, Nova immediately
  falls back to its bundled reviewed corpus. Feed errors never block startup or a task.

## Bootstrap and rotation

1. Generate an offline Ed25519 key without printing its private half:

   ```bash
   bun run defender:feed-key --private-out /secure/offline/defender-feed-key.pem
   ```

2. Store that file's contents as `DEFENDER_BRAIN_SIGNING_KEY` on the Vercel project. Set
   `DEFENDER_BRAIN_KEY_ID` to a durable identifier and `DEFENDER_BRAIN_SEQUENCE=1`.
3. Add the printed SPKI public key under that identifier in `OFFICIAL_DEFENDER_FEED_KEYS`, test a
   deployed manifest, then release the CLI. Never ask users to trust a key delivered by the feed.
4. Increment `DEFENDER_BRAIN_SEQUENCE` for every canonical corpus change before deployment.
5. For rotation, ship a CLI containing both old and new public keys, switch the server key in a
   later deployment, then remove the old public key only after the supported-client window closes.

The first release root is pinned as `release-2026-01`. Operators may exercise a staging feed with
`NOVA_DEFENDER_FEED_URL` and `NOVA_DEFENDER_BRAIN_PUBLIC_KEYS`; those overrides are intended for
controlled testing, not end-user trust bootstrap.

## Operations

- Exa refresh: `bun run defender:refresh -- --force`
- Feed contract tests: `bunx vitest run packages/agent-core/src/nova-cli/defender-feed.test.ts lib/defender-feed-server.test.ts`
- Native validation: `cargo test --manifest-path packages/nova-state/Cargo.toml brain`
- Distribution benchmark: `bun run bench:defender-feed -- --rounds 500`
- Native retrieval benchmark: `bun run bench:defender`

The hosted feed must return `503` rather than unsigned content when signing configuration is
missing. The CLI intentionally suppresses routine polling errors; operators diagnose the central
endpoint through its health/deployment observability, while users retain their last good replica.
