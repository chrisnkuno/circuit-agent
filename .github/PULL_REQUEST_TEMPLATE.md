## What this changes

<!-- One or two sentences. The diff says what; say why. -->

## Why

<!-- The problem, or the behaviour that was wrong. If it fixes an issue: Fixes #123 -->

## How it was verified

<!-- The test you added and what it would catch. "Ran the app" is a supplement, not a substitute. -->

## Checklist

- [ ] `bun run check` is green
- [ ] There is a test that fails without this change
- [ ] New component tests carry the `@vitest-environment happy-dom` docblock
- [ ] A new or moved keyboard shortcut is in the guide (the suite enforces this)
- [ ] A sidecar protocol change updates both sides
- [ ] No new runtime network dependency in the window
