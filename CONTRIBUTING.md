# Contributing to Nova Desktop

Thank you for helping. This file is the whole path from a fresh clone to a merged pull request. If
something here is wrong or missing, that is itself a bug worth a pull request — a contributor
guide that has drifted from the build is worse than none, because it is trusted.

## Table of contents

- [What belongs in this repository](#what-belongs-in-this-repository)
- [Setting up](#setting-up)
- [The loop](#the-loop)
- [How this codebase is organised](#how-this-codebase-is-organised)
- [Testing standard](#testing-standard)
- [Style](#style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Releasing](#releasing)
- [Getting help](#getting-help)

## What belongs in this repository

Nova Desktop is the **window and its sidecar**. The agent runtime it drives —
`@circuit-nova/nova-core` — is developed in
[chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent) and arrives here as a
published npm dependency.

| Change | Where it goes |
| --- | --- |
| A panel, a shortcut, a dialog, anything the user sees | here |
| Tab routing, event plumbing, the sidecar protocol | here |
| The Rust shell, packaging, the updater | here |
| Tool behaviour, prompts, provider adapters, cost accounting | `circuit-agent` |
| Anything the CLI and the window must agree on | `circuit-agent`, then bump the dependency here |

If a desktop feature needs a change in the core, land the core change first, get it published, then
raise the desktop pull request against the new version. Do not fork the logic into `src/` to avoid
the round trip: the CLI and the window disagreeing about what a mode permits is precisely the class
of bug the shared core exists to prevent.

## Setting up

Requirements:

- [Bun](https://bun.sh) 1.3.14 or newer — the package manager, the test runner, and the compiler
  that turns the sidecar into a self-contained executable
- Node 22 or newer
- Rust, via [rustup](https://rustup.rs)
- On Ubuntu/Debian, the Tauri system libraries:

  ```bash
  sudo apt install -y \
    libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
    patchelf libgtk-3-dev libssl-dev libdbus-1-dev pkg-config
  ```

Then:

```bash
git clone https://github.com/chrisnkuno/nova-desktop.git
cd nova-desktop
bun install
bun run check     # tests, typecheck, frontend build — should be green before you change anything
```

Use `bun`, not `npm`. There is one lockfile in this repo and it is Bun's.

## The loop

```bash
bun run tauri:dev     # the real app: compiles the sidecar, starts Vite, opens the window
bun run dev           # the window alone in a browser, for pure UI work
bun run sidecar:dev   # the sidecar alone on stdio; type JSON lines like {"id":"1","type":"ping"}
bun run test          # vitest: everything, window and sidecar
bun run test:bun      # bun test: the window only, quicker for a tight component loop
bun run typecheck
```

`tauri:dev` runs the *same* sidecar artifact a release does, on purpose. They diverged once — dev
used a shell script and release expected something nobody had built — and a broken Windows package
went unnoticed for months as a result.

On first launch, paste an API key. Nothing else is required.

## How this codebase is organised

```
src/            the React window
  components/   presentation; each one has a sibling .test.tsx where it is worth driving
  lib/          the window's logic as pure functions — this is where most tests live
sidecar/src/    the JSONL stdio host around NovaAgent
src-tauri/      the Rust shell
scripts/        sidecar compilation, Windows packaging
```

Two conventions carry most of the weight:

**Logic comes out of components.** Transcript parsing, scroll following, approval key handling,
per-tab state and event routing all live in `src/lib/` as pure functions, so they can be tested
without rendering anything. A component should be thin enough that its own test is about wiring —
that the listener is attached, that focus lands somewhere safe — rather than about behaviour.

**Tabs are addressed, not assumed.** Every session-scoped request carries an optional `tabId`, and
every event the sidecar emits is stamped with the tab it came from, taken from the daemon's own
`sessionId` rather than from whichever tab happens to be in front. With two turns streaming at
once, "the active tab" is the wrong answer about half the time, and being wrong is silent: one
piece of work's answer lands in another's transcript with nothing to show it happened.
`sidecar/src/tabs.ts` does the routing and `src/lib/tabs.ts` is its counterpart in the window; a
change to one almost always needs the other.

Two more rules the app is built on, worth knowing before you change things:

- **Nothing is fetched at runtime.** No webfonts, no CDN. The app uses each platform's own UI face
  and ships a real CSP in `tauri.conf.json`. A desktop window that waits on a third-party host to
  paint its own text is a window that breaks offline.
- **The approval dialog has no default button.** Focus lands on the dialog itself, so Enter — the
  key people press to dismiss things — cannot approve a command.

## Testing standard

**Every behavioural change comes with a test that would fail without it.** A build passing is not a
test; a typecheck passing is not a test. Assert the property that matters, not the implementation
that currently provides it — a test that breaks when you rename a variable is a maintenance cost,
not a safety net.

Where to put one:

| Kind of change | Where the test goes |
| --- | --- |
| Logic — parsing, state, routing, key handling | `src/lib/*.test.ts`, no DOM |
| A component's wiring — listeners, focus, what a click calls | `src/components/*.test.tsx` |
| The sidecar protocol, or a turn actually running | `sidecar/src/*.test.ts` |

Component tests need a DOM. Under `bun test` it comes from the `happydom.ts` preload named in
`bunfig.toml`; under vitest each file asks for one itself with a `@vitest-environment happy-dom`
docblock. **New component tests need that docblock**, or they pass locally under `bun test` and
fail in CI under vitest with `document is not defined` — a failure that reads exactly like a real
regression.

`bunfig.toml` scopes `bun test` to `src/` deliberately: the globally registered DOM makes the
Anthropic SDK inside nova-core refuse to construct a client, which would make every sidecar test
unrunnable. That is why vitest is the runner CI gates on.

The guide panel is self-enforcing and worth knowing about: the suite asserts that every shortcut
the window offers is documented by some topic, and that no topic claims a chord that does not
exist. **A feature added without a line in the guide fails the build.** That is intentional.

## Style

- TypeScript strict; no `any` that a real type would do.
- Comments explain *why*, not *what*. The existing comments in this repo are the standard — they
  record the decision and the failure that motivated it, so the next person does not undo it. Match
  that density; do not narrate code that speaks for itself.
- `bun run typecheck` must be clean. `noUnusedLocals` and `noUnusedParameters` are on.
- Rust: `cargo fmt` and `cargo clippy -- -D warnings`, both enforced in CI.
- No new runtime network dependency in the window. See the CSP rule above.

## Commits and pull requests

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(tabs): keep a separate cost ledger per tab
fix(sidecar): stamp events with the originating tab, not the active one
docs(contributing): describe the two test runners
chore(deps): bump nova-core to 0.12.0
```

Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.

Before opening a pull request:

1. `bun run check` is green.
2. Your change has a test that would fail without it.
3. If you added or moved a keyboard shortcut, the guide knows about it.
4. If you changed the sidecar protocol, both sides of it are updated together.
5. The pull request says *why*, not only *what*. A reviewer can read the diff.

Keep pull requests focused. A rename and a behaviour change in one branch is a diff nobody can
review honestly.

## Releasing

Maintainers only.

1. Bump the version in **all three** places: `src-tauri/tauri.conf.json`, `package.json`, and
   `src-tauri/Cargo.toml`. `release.yml` refuses to build if the tag and
   `tauri.conf.json` disagree.
2. `git tag v0.2.3 && git push origin v0.2.3`.
3. The workflow builds Windows x64 and both macOS architectures, signs the updater artifacts, and
   publishes them with `latest.json`. Installed apps pick the update up from there.

macOS ships as two per-architecture bundles rather than one universal binary, because the sidecar
is an `externalBin` Tauri resolves by target triple. Two honest single-arch downloads beat one that
is subtly wrong on half the machines it lands on.

## Getting help

- Bugs and features: [open an issue](https://github.com/chrisnkuno/nova-desktop/issues).
- Security problems: **do not** open an issue. See [SECURITY.md](SECURITY.md).
- Behaviour of everyone taking part: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
