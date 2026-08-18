# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a sidecar that runs `@circuit-nova/nova-core` (`NovaAgent`) with the same `.nova/` session format as `nova-cli`. In release builds the sidecar is compiled into a **single self-contained executable** (via `bun build --compile` on Windows, or `@yao-pkg/pkg` for the Linux cross-build), so end users do **not** need Node installed.

## Features

- Settings that ask for one thing: paste an API key. Base URL, budget, sandbox and relay are all
  still there, behind a disclosure, because only one of them is required
- **Test this key** checks credentials before you commit to them, using the provider's model list —
  an authenticated call that generates no tokens, so it costs nothing
- Chat with streaming assistant output, rendered with code blocks and per-block copy
- Modes: Plan / Build / Auto, as one segmented control that states the posture it puts you in
- Per-tool approval dialog showing the exact command, answerable with `Y` / `N` / `A` / `D` or Escape
- **Tabs, running in parallel** — several pieces of work in one window, each with its own
  transcript, project, model, mode and cost, and all of them running at once. Ctrl+T opens one,
  Ctrl+W closes it, Ctrl+Tab and Ctrl+1…9 move between them. The strip says which tabs are working,
  which one is blocked on an approval, and what finished while you were looking elsewhere
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- The agent's plan as a live panel
- E2B sandbox toggle, upload, pull
- Follows the system light/dark setting
- **Auto-update** — checks GitHub Releases and installs new versions in place
- **Portable Windows build** — `release/windows/` folder with `Nova.exe` + sidecar, no installer required
- Keyboard throughout: Ctrl+Enter send, Esc stop, Ctrl+M model, Ctrl+D changes, Ctrl+Z undo,
  Ctrl+, settings, Alt+1/2/3 mode — listed in the Keyboard panel so they can be found

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

Run from the repository root, with the rest of the suite:

```bash
bun run test
```

UI logic that is worth testing is kept as pure functions in `src/lib/` (transcript parsing, scroll
following, approval key handling, per-tab state and event routing) so it can be exercised without a
DOM — the same split the CLI uses for its menus.

Components are rendered and driven too, which needs a DOM. `bun test` supplies one via the
`happydom.ts` preload in `bunfig.toml`, and each component test also carries a
`@vitest-environment happy-dom` docblock so the repo-wide vitest run — which has no such preload —
can run it rather than failing on `document is not defined`. `bunfig.toml` scopes `bun test` to
`src/` on purpose: the registered DOM makes the Anthropic SDK refuse to construct a client, so
`sidecar/`'s tests (which drive a real host against a stubbed provider, including two tabs running
turns at once) run under vitest only.

## Prerequisites

- Node 20+
- Rust via rustup (`curl https://sh.rustup.rs -sSf | sh`)
- Linux build deps (Ubuntu/Debian):

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libgtk-3-dev libssl-dev libdbus-1-dev pkg-config
```

- For Windows installers: build on Windows with the MSVC toolchain / WebView2, or run `npm run package:windows` on a Linux host with `cargo-xwin` + `llvm-rc` (`/usr/lib/llvm-21/bin`).

## Setup

```bash
cd apps/nova-desktop
npm install
```

## Development

```bash
# Terminal A — optional standalone sidecar smoke test
npm run sidecar:dev
# type JSON lines, e.g. {"id":"1","type":"ping"}

# Full desktop app
source "$HOME/.cargo/env"   # if needed
npm run tauri:dev
```

`beforeDevCommand` compiles the sidecar binary and starts Vite, so dev and release run the *same*
artifact. They deliberately did not before: dev used a shell script and release was supposed to use
something else that nobody built, which is how a broken Windows package went unnoticed.

On first launch, enter a CircuitNotion (or other) API key. The base URL defaults to CircuitNotion's API.

## The sidecar binary

`npm run sidecar:binary` compiles `sidecar/src/index.ts` into a single self-contained executable
named for the Tauri target triple. It embeds its own runtime — **the machine running the installed
app needs no Node** — and `bun build --compile` cross-compiles, so a Windows `.exe` can be produced
from Linux or macOS:

```bash
npm run sidecar:binary                              # this machine
npm run sidecar:binary -- x86_64-pc-windows-msvc    # a real Windows PE, from any host
```

The output is ~95 MB and is never committed; it is reproducible from source in about a second.

## Production / Windows packaging

`beforeBuildCommand` runs the frontend build and `sidecar:binary`, which compiles the sidecar +
`nova-core` into a single self-contained executable
(`src-tauri/binaries/nova-sidecar-x86_64-pc-windows-msvc.exe`) with `bun build --compile`,
so no Node is required on user machines. Tauri then emits the NSIS installer.

```bash
npm run package:windows
npm run tauri:build
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

- `.github/workflows/release-desktop.yml` — official NSIS release + auto-update artifacts on GitHub Releases.
- `.github/workflows/nova-desktop-windows.yml` — Windows portable/MSI build via cargo-xwin cross-compile.

## Releasing + auto-updates

Releases are built by GitHub Actions (`.github/workflows/release-desktop.yml` in the repo
root) and published to GitHub Releases:

1. Bump the version in `src-tauri/tauri.conf.json`, `package.json` and `src-tauri/Cargo.toml`.
2. Push a matching tag: `git tag v0.2.0 && git push origin v0.2.0`.

The workflow builds the installer on a `windows-latest` runner, signs the updater artifacts,
and uploads them to the GitHub Release along with `latest.json`. The app checks
`https://github.com/chrisnkuno/circuit-agent/releases/latest/download/latest.json` on launch
and updates itself.

Updater signing keys (public key is in `tauri.conf.json`):

```bash
npm run tauri signer generate -- -w ~/.tauri/nova-desktop.key
```

Then add the private key to GitHub repo secrets as `TAURI_SIGNING_PRIVATE_KEY`
(and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` if you set a password). Never commit the private key.

## Architecture

- `src/` — React UI (`lib/tabs.ts` holds the window's per-tab state and event routing)
- `sidecar/` — JSONL stdio host around `NovaAgent`
- `src-tauri/` — windowing, folder picker, settings store, sidecar process bridge, updater
