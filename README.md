# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a sidecar that runs
[`@circuit-nova/nova-core`](https://www.npmjs.com/package/@circuit-nova/nova-core) (`NovaAgent`) with the same `.nova/` session format as `nova-cli`. In release builds the sidecar is compiled into a **single self-contained executable** (via `bun build --compile` on Windows, or `@yao-pkg/pkg` for the Linux cross-build), so end users do **not** need Node installed.

> **Where the agent itself lives.** This repository is the desktop window and its sidecar only.
> The agent runtime, provider adapters and cost accounting are
> [`@circuit-nova/nova-core`](https://www.npmjs.com/package/@circuit-nova/nova-core), published
> from [chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent) and consumed here as
> an ordinary npm dependency. A change to how the agent *thinks* belongs there; a change to how it
> is *seen and driven* belongs here. See [docs/architecture.md](docs/architecture.md) for the seam.

New here? [CONTRIBUTING.md](CONTRIBUTING.md) is the setup-to-pull-request path.

## Repository map

| Path | What lives there |
| --- | --- |
| `src/` | The React window. Testable logic is pulled out into `src/lib/` as pure functions. |
| `sidecar/` | A JSONL-over-stdio host wrapping `NovaAgent`. Where a turn is actually run. |
| `src-tauri/` | The Rust shell: windowing, folder picker, settings store, sidecar bridge, updater. |
| `scripts/` | Sidecar compilation and Windows packaging. |
| `docs/` | Architecture and the open backlog. |

## Features

- Settings that ask for one thing: paste an API key. Base URL, budget, sandbox and relay are all
  still there, behind a disclosure, because only one of them is required
- **Test this key** checks credentials before you commit to them, using the provider's model list —
  an authenticated call that generates no tokens, so it costs nothing
- Chat with streaming assistant output, rendered with code blocks and per-block copy
- Modes: Plan / Build / Auto / Defender, as one segmented control that states the posture it puts
  you in — Plan cannot write at all, because the write tools are never offered to the model
- Per-tool approval dialog showing the exact command, answerable with `Y` / `N` / `A` / `D` or Escape
- **Tabs, running in parallel** — several pieces of work in one window, each with its own
  transcript, project, model, mode and cost, and all of them running at once. Ctrl+T opens one,
  Ctrl+W closes it, Ctrl+Tab and Ctrl+1…9 move between them. The strip says which tabs are working,
  which one is blocked on an approval, and what finished while you were looking elsewhere
- **A file explorer that reads files**, not just names them: the project as a tree with flat search,
  and a preview pane beside it. Contents come from the session's own workspace, so a sandboxed tab
  shows the sandbox's copy rather than a same-named file on this machine — and the webview still
  needs no filesystem permission of its own. Ctrl P opens it; mentioning a file into the composer
  stays a separate, deliberate act
- **A guide in the window** (F1). It is data rather than prose, and the suite asserts that every
  shortcut the window offers is documented by some topic and that no topic claims a chord that does
  not exist — so a feature added without a line in the guide fails the build
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- The agent's plan as a live panel
- E2B sandbox toggle, upload, pull
- Follows the system light/dark setting
- **Auto-update** — checks GitHub Releases and installs new versions in place
- CircuitNotion sessions default to **`circuit-2-turbo`**, matching the CLI; the picker still
  exposes every configured provider and reports when a live model has no known price
- **Portable Windows build** — `release/windows/` folder with `Nova.exe` + sidecar, no installer required
- Keyboard throughout: Ctrl+Enter send, Esc stop, Ctrl+M model, Ctrl+D changes, Ctrl+P files,
  Ctrl+Z undo, Ctrl+, settings, F1 guide, Alt+1/2/3/4 mode — listed in the Keyboard panel and in the
  guide, both generated from the same table the matcher reads

## Design notes

Two decisions worth knowing before changing things:

- **Nothing is fetched at runtime.** No webfonts, no CDN. The app uses each platform's own UI face
  and ships a real CSP in `tauri.conf.json`; a desktop window that waits on a third-party host to
  paint its own text is a window that breaks offline.
- **Tabs are addressed, not assumed.** Every session-scoped request carries an optional `tabId` and
  every event the sidecar emits is stamped with the tab it came from — taken from the daemon's own
  `sessionId`, not from whichever tab is in front. With two turns streaming at once, "the active
  tab" is the wrong answer about half the time, and being wrong is silent: one piece of work's
  answer appears in another's transcript with nothing to show it happened. A request that names no
  tab still means "the one in front", which is what it meant when there was only one.
  (`sidecar/src/tabs.ts` does the routing; `src/lib/tabs.ts` is its counterpart in the window.)
- **The window's tabs really are parallel; the CLI's are not.** `NovaSessionDaemon` serialises turns
  per session rather than globally, so two tabs genuinely run side by side. The terminal deliberately
  does the opposite — a scrolling transcript has one bottom, and two agents printing into it would
  interleave — so `nova`'s tabs pause when you leave them and `/detach` is its answer for parallel
  work. Neither surface should be described in the other's terms.
- **The approval dialog has no default button.** Focus lands on the dialog itself, so Enter — the
  key people press to dismiss things — cannot approve a command. Escape denies rather than merely
  closing, because a dialog that vanishes while the agent still waits is a hang with no visible
  cause. The rules live in `src/lib/approval.ts` and are tested directly.

## Tests

```bash
bun run test        # vitest — the whole suite, window and sidecar. This is what CI gates on.
bun run test:bun    # bun test — the window only, faster, see below
bun run check       # test + typecheck + build, the pre-push gate
```

UI logic that is worth testing is kept as pure functions in `src/lib/` (transcript parsing, scroll
following, approval key handling, per-tab state and event routing) so it can be exercised without a
DOM — the same split the CLI uses for its menus.

Components are rendered and driven too, which needs a DOM. `bun test` supplies one via the
`happydom.ts` preload in `bunfig.toml`, and each component test also carries a
`@vitest-environment happy-dom` docblock so the vitest run — which has no such preload — can run
it rather than failing on `document is not defined`. `bunfig.toml` scopes `bun test` to `src/` on
purpose: the registered DOM makes the Anthropic SDK refuse to construct a client, so `sidecar/`'s
tests (which drive a real host against a stubbed provider, including two tabs running turns at
once) run under vitest only. Vitest is therefore the runner that covers everything, and the reason
both exist is that `bun test` is markedly quicker for the tight loop on a component.

## Prerequisites

- [Bun](https://bun.sh) 1.3.14+ (the package manager and the sidecar compiler)
- Node 22+
- Rust via rustup (`curl https://sh.rustup.rs -sSf | sh`)
- Linux build deps (Ubuntu/Debian):

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libgtk-3-dev libssl-dev libdbus-1-dev pkg-config
```

- For Windows installers: build on Windows with the MSVC toolchain / WebView2, or run `bun run package:windows` on a Linux host with `cargo-xwin` + `llvm-rc` (`/usr/lib/llvm-21/bin`).

## Setup

```bash
git clone https://github.com/chrisnkuno/nova-desktop.git
cd nova-desktop
bun install
```

`bun` rather than `npm`: the sidecar is compiled with `bun build --compile`, and the lockfile in
this repo is Bun's. There is no second lockfile on purpose — two of them disagreeing is how a CI
run and a laptop end up on different dependency trees.

## Development

```bash
# Terminal A — optional standalone sidecar smoke test
bun run sidecar:dev
# type JSON lines, e.g. {"id":"1","type":"ping"}

# Full desktop app
source "$HOME/.cargo/env"   # if needed
bun run tauri:dev
```

`beforeDevCommand` compiles the sidecar binary and starts Vite, so dev and release run the *same*
artifact. They deliberately did not before: dev used a shell script and release was supposed to use
something else that nobody built, which is how a broken Windows package went unnoticed.

On first launch, enter a CircuitNotion (or other) API key. The base URL defaults to CircuitNotion's API.
Terminal and desktop share the durable session schema, including its permission mode, so resuming a
read-only planning thread cannot silently reopen it with build authority.

## The sidecar binary

`bun run sidecar:binary` compiles `sidecar/src/index.ts` into a single self-contained executable
named for the Tauri target triple. It embeds its own runtime — **the machine running the installed
app needs no Node** — and `bun build --compile` cross-compiles, so a Windows `.exe` can be produced
from Linux or macOS:

```bash
bun run sidecar:binary                              # this machine
bun run sidecar:binary -- x86_64-pc-windows-msvc    # a real Windows PE, from any host
```

The output is ~95 MB and is never committed; it is reproducible from source in about a second.

## Production / Windows packaging

`beforeBuildCommand` runs the frontend build and `sidecar:binary`, which compiles the sidecar +
`nova-core` into a single self-contained executable
(`src-tauri/binaries/nova-sidecar-x86_64-pc-windows-msvc.exe`) with `bun build --compile`,
so no Node is required on user machines. Tauri then emits the NSIS installer.

```bash
bun run package:windows
bun run tauri:build
```

### Portable build (Linux cross-compile or Windows)

`package-windows.mjs` compiles the Windows sidecar, verifies it is a real executable rather than a
wrapper, and produces a portable `release/windows/` folder (Nova.exe + sidecar) that can be copied
to any Windows PC (WebView2 required).

On Linux it cross-compiles the Tauri app with `cargo-xwin` (needs `llvm-rc` on PATH, e.g.
`/usr/lib/llvm-21/bin`) and `--no-bundle`, since Tauri's MSI and NSIS targets need the MSVC
toolchain; on Windows it runs a native `tauri build` and emits the installers too. The app locates
the sidecar next to its own exe, so the portable folder can live anywhere. CI builds both halves on
every push.

### CI

- `.github/workflows/ci.yml` — tests, typecheck, frontend build, `cargo fmt`/`clippy` on the shell,
  and the two sidecar checks that matter: that the Windows artifact is a real PE executable of a
  plausible size, and that the Linux one answers a ping.
- `.github/workflows/release.yml` — the installers and the signed auto-update artifacts, on a `v*` tag.

## Releasing + auto-updates

Releases are built by GitHub Actions (`.github/workflows/release.yml`) and published to GitHub
Releases:

1. Bump the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Push a matching tag: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow builds Windows and both macOS architectures, signs the updater artifacts, and
uploads them to the GitHub Release along with `latest.json`. The app checks
`https://github.com/chrisnkuno/nova-desktop/releases/latest/download/latest.json` on launch and
updates itself.

Updater signing keys (public key is in `tauri.conf.json`):

```bash
bun run tauri signer generate -- -w ~/.tauri/nova-desktop.key
```

Then add the private key to GitHub repo secrets as `TAURI_SIGNING_PRIVATE_KEY`
(and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you set a password). Never commit the private key.

## Architecture

- `src/` — React UI (`lib/tabs.ts` holds the window's per-tab state and event routing)
- `sidecar/` — JSONL stdio host around `NovaAgent`
- `src-tauri/` — windowing, folder picker, settings store, sidecar process bridge, updater
