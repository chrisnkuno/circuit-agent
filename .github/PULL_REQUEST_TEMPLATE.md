## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Why

<!-- The problem, or the behaviour that was wrong. If it fixes an issue: Fixes #123 -->

## How it was verified

<!-- The test you added and what it would catch. "Ran it locally" is a supplement, not a substitute. -->

## Checklist

- [ ] `bun run check` is green
- [ ] There is a test that fails without this change
- [ ] Touches `apps/web` UI or Convex mutations → `bun run test:e2e` passed locally
- [ ] Touches `packages/nova-state` → `cargo test` and `cargo clippy -- -D warnings` are clean
- [ ] Changed a documented behaviour → the document changed in the same commit
- [ ] Changed what `nova-core` exports → the desktop repo can still build against it
- [ ] No new import from an app, a service, or `tooling/` into `packages/`
