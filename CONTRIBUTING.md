# Contributing to Circuit-Nova

This file is the whole path from a fresh clone to a merged pull request. If something here is wrong
or out of date, that is itself a bug worth a pull request — a contributor guide that has drifted
from the build is worse than none, because people trust it.

## Table of contents

- [Where things live](#where-things-live)
- [Setting up](#setting-up)
- [The loop](#the-loop)
- [The testing standard](#the-testing-standard)
- [Conformance rules the build enforces](#conformance-rules-the-build-enforces)
- [Style](#style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Performance work](#performance-work)
- [Releasing](#releasing)
- [Getting help](#getting-help)

## Where things live

The repository is a Bun workspace monorepo with a deliberate, one-way dependency direction:

```
apps/         services/         packages/nova-cli
  |               |                   |
  +---------------+-------------------+
                  |
        packages/agent-core   ← @circuit-nova/nova-core, the shared runtime
                  |
        packages/nova-state   ← the Rust projections (history index, Defensive Brain)
```

**Nothing in `packages/` may import from an app, a service, or `tooling/`.** It holds today; keep it
holding. That rule is what lets the same runtime ship to a terminal, a desktop window and a hosted
worker without three subtly different ideas of what a permission mode permits — and it is why the
desktop app could be lifted into its own repository at all.

| Change | Where it goes |
| --- | --- |
| The agent loop, a tool, a prompt, a provider adapter, cost accounting | `packages/agent-core` |
| Terminal UI, slash commands, the TUI | `packages/nova-cli` |
| History search, the Defensive Brain, anything native | `packages/nova-state` (Rust) |
| The website, the Convex backend, the durable dispatcher | `apps/web` |
| A build, release, benchmark or reliability script | `tooling/<bucket>` |
| The desktop window | [chrisnkuno/nova-desktop](https://github.com/chrisnkuno/nova-desktop) — a separate repository |

`tooling/` is grouped by what a script is *for*, not by what it touches: `build/`, `release/`,
`bench/`, `reliability/`, `defender/`. Put a new script in the bucket that describes why someone
would run it, and expose it as a root `package.json` script so nobody has to remember the path.

## Setting up

Requirements:

- [Bun](https://bun.sh) 1.3.14 or newer — the package manager and test runner for the whole repo
- Node 22.5 or newer (the published CLI targets it, and CI smoke-tests against it)
- Rust via [rustup](https://rustup.rs), only if you are touching `packages/nova-state`

```bash
git clone https://github.com/chrisnkuno/circuit-agent.git
cd circuit-agent
bun install
bun run check     # should be green before you change anything
```

Convex's generated bindings (`apps/web/convex/_generated`) are committed, so `typecheck` and
`build` work on a fresh clone with no Convex deployment of your own. If you edit
`apps/web/convex/schema.ts` or any `apps/web/convex/*.ts` function, regenerate them against your
own deployment before typechecking:

```bash
bunx convex dev --once
```

**Environment.** `apps/web/.env.example` documents every variable. Copy it to
`apps/web/.env.local` — that is the single env file in the repo, and the one tooling script that
needs secrets (`bun run defender:refresh`) reads it from there too. Nothing in the default local
loop requires a credential.

## The loop

Run everything from the repository root:

```bash
bun run dev             # the hosted control plane
bun run nova            # the CLI, straight from source, no build
bun run test            # the whole suite (vitest)
bun run test -- packages/nova-cli    # one area, while iterating
bun run typecheck       # the workspace root and apps/web
bun run build           # the production web build
bun run check           # test + typecheck + build — the gate
bun run test:e2e        # Playwright; needs a real Convex deployment, see below
bun run build:packages  # build agent-core and nova-cli the way npm consumers get them
```

`bun run test:e2e` is deliberately not part of `check` and not run in CI: it exercises a real
Convex deployment (sign-up, task persistence) that CI has no credentials for. Run it locally
against a configured dev deployment before merging anything that touches the workspace UI or the
Convex mutations it calls.

The terminal suites under `packages/nova-cli/src/pty/` get the machine to themselves — they spawn a
real pseudo-terminal per case and assert by *waiting* for a prompt to be painted, so run in
parallel they lose the CPU race and time out. `vitest.config.ts` puts them in their own
single-worker project for that reason. If you add a test that drives a real terminal, put it there.

## The testing standard

**Every behavioural change comes with a test that would fail without it.** A build passing is not a
test. A typecheck passing is not a test. This is not a style preference here — the runtime enforces
parts of it, and CI enforces the rest.

Write the test against the *invariant*, not the implementation:

- Good: "an approval binds to the digest of the action, so answering one cannot authorize a
  different action the worker re-parked while the human was typing."
- Bad: "`approve()` calls `recordApproval()` once." That breaks on a rename and proves nothing.

Coverage thresholds are enforced on `packages/*/src` at 85% statements / 80% branches / 85%
functions / 85% lines. They are a floor, not a target — a test that exists only to move the number
is worse than the gap it fills.

Where a test goes:

| What changed | Where the test goes |
| --- | --- |
| Agent runtime, tools, policy, providers | `packages/agent-core/src/**/*.test.ts` |
| CLI commands, rendering, layout | `packages/nova-cli/src/**/*.test.ts` |
| Anything driving a real terminal | `packages/nova-cli/src/pty/` (single-worker project) |
| Rust history index or Defensive Brain | `packages/nova-state/tests/`, plus `INVARIANTS.md` |
| The web app's domain logic | `apps/web/lib/**/*.test.ts` |
| A whole user journey through the site | `apps/web/tests/e2e/` (Playwright, not in CI) |
| A tooling script with real logic | next to it, e.g. `tooling/defender/defender-refresh-policy.test.ts` |

## Conformance rules the build enforces

`packages/agent-core/src/conformance.test.ts` is a zero-tolerance suite: it fails the build on
whole classes of change rather than on individual bugs. As of writing it refuses to let the package
have

- an executable module with no test that exercises it,
- an error swallowed silently,
- a `console.*` call or a `process.exit` in library code,
- a suppressed type error or an abandoned `TODO`-class marker,
- a new module without a header comment saying what it is for,
- a test file whose subject has been deleted or renamed out from under it,

and it holds a **ratchet** on type escapes: the count may fall, never rise. Before you argue with a
failure, read the rule — each one records the incident that motivated it. Changing a rule is a
deliberate act that belongs in its own pull request with the reasoning in the commit message, never
a drive-by edit to make a red build green.

Two invariants worth knowing before you touch the relevant code:

- **Approvals bind to an action digest, never to a job id.** Execution is at-most-once. A worker
  that re-parks a different action while a human is deciding must not be able to consume that
  decision.
- **Money is integer RWF end to end.** Conversion to a display currency happens at the edge, for
  presentation only. The cap, the reservation, the settlement and the audit ledger are integers,
  and a floating-point amount anywhere in that path is a bug regardless of whether a test catches
  it.

## Style

- TypeScript strict everywhere. No `any` where a real type would do.
- Comments explain **why**, not **what**. The existing comments are the standard: they record the
  decision and the failure that motivated it, so the next person does not quietly undo it. Match
  that density — and do not narrate code that already speaks for itself.
- Rust: `cargo fmt` and `cargo clippy -- -D warnings`, both enforced in CI.
- Shared compiler options live in `tsconfig.base.json`. If you need a different setting, add it to
  the workspace that needs it rather than loosening the base for everyone.
- Import shared code by package name (`@circuit-nova/nova-core/...`), not by counting `../`. Bun
  and every tsconfig in the repo resolve it to source, so there is no build step in the way.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), scoped by area:

```
feat(nova): recover bounded execution failures
fix(cli): recover from provider 404s and track balance locally
chore(defender): pin initial feed trust root
docs(contributing): describe the tooling buckets
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.

The commit message is where the reasoning goes. A reviewer can read the diff; what they cannot
recover is why this shape and not the obvious alternative, and what broke that made it necessary.

Before opening a pull request:

1. `bun run check` is green.
2. Your change has a test that would fail without it.
3. If it touches the web UI or Convex mutations, `bun run test:e2e` passed locally.
4. If it touches `packages/nova-state`, `cargo test` and `cargo clippy -- -D warnings` are clean.
5. If it changes a documented behaviour, the document changed in the same commit.
6. If it changes what the CLI or the core exports, the desktop repository can still build against
   it — that app consumes `@circuit-nova/nova-core` from npm and cannot see this branch.

Keep pull requests focused. A rename and a behaviour change in one branch is a diff nobody can
review honestly.

## Performance work

Do not optimize from intuition. `docs/reference/optimization-map.md` holds the executable targets,
each with a probe and a budget:

```bash
bun run optimize:map    # what the targets are and where they currently stand
bun run build:packages  # the benchmark measures the built artifact, not the source
bun run bench           # medians against the committed baseline in bench/
```

The benchmark reports median and p95 rather than a mean, and refuses to call a difference an
improvement when it is smaller than that run's own spread — so "faster" in the output means the
machine agreed twice. Numbers are only comparable within one machine: commit a new baseline only
when you have deliberately moved it, and re-measure on the same box.

## Releasing

Maintainers only.

- **npm packages** (`nova-core`, `nova-cli`): bump the version in the package's own
  `package.json`, run `bun run build:packages`, then publish. `prepublishOnly` rebuilds, and CI
  runs `npm pack --dry-run` on every push so the published file list cannot drift unnoticed.
- **Native state** (`@circuit-nova/state-*`): the `native-state-release.yml` workflow, which
  packages and verifies every target before publishing any of them.
- **The web app**: deployed from `main`. See the monorepo note in `netlify.toml` — the package
  directory has to be `apps/web` while the install still happens at the workspace root.
- **The desktop app**: released from its own repository on a `v*` tag there. Nothing in this repo
  publishes it any more.

## Getting help

- Bugs and features: [open an issue](https://github.com/chrisnkuno/circuit-agent/issues).
- Security problems: **do not** open an issue. See [SECURITY.md](SECURITY.md).
- Behaviour of everyone taking part: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
