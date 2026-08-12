# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a Node sidecar that runs `@circuit-nova/nova-core` (`NovaAgent`) with the same `.nova/` session format as `nova-cli`.

## Features

- Settings: provider, API key, **API base URL** (default `https://api.circuitnotion.com/v1`), model, budget, E2B key
- Chat with streaming assistant output, rendered with code blocks and per-block copy
- Modes: Plan / Build / Auto, as one segmented control that states the posture it puts you in
- Per-tool approval dialog showing the exact command, answerable with `Y` / `N` / `A` / `D` or Escape
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- The agent's plan as a live panel
- E2B sandbox toggle, upload, pull
- Follows the system light/dark setting

## Design notes

Two decisions worth knowing before changing things:

- **Nothing is fetched at runtime.** No webfonts, no CDN. The app uses each platform's own UI face
  and ships a real CSP in `tauri.conf.json`; a desktop window that waits on a third-party host to
  paint its own text is a window that breaks offline.
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
following, approval key handling) so it can be exercised without a DOM — the same split the CLI
uses for its menus.

## Prerequisites

- Node 20+
- Rust via rustup (`curl https://sh.rustup.rs -sSf | sh`)
- Linux build deps (Ubuntu/Debian):

```bash
sudo apt install -y \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
  patchelf libgtk-3-dev libssl-dev libdbus-1-dev pkg-config
```

- For Windows installers: build on Windows with the MSVC toolchain / WebView2, or run `npm run package:windows` on a Windows host

## Setup

```bash
cd apps/nova-desktop
npm install
npm run sidecar:build
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

On first launch, enter a CircuitNotion (or other) API key. The base URL defaults to CircuitNotion’s API.

## Production / Windows packaging

```bash
npm run sidecar:bundle
npm run tauri:build
```

`beforeBuildCommand` runs the frontend build and sidecar bundle. Tauri emits `.msi` / NSIS targets from `src-tauri/tauri.conf.json`.

For a self-contained Windows binary that does **not** require Node on the user machine, replace `src-tauri/binaries/nova-sidecar-x86_64-pc-windows-msvc.exe` with a packaged Node binary (e.g. [`pkg`](https://github.com/vercel/pkg) / Node SEA) built from `sidecar/dist/index.js`, then re-run `tauri build`.

## Architecture

- `src/` — React UI
- `sidecar/` — JSONL stdio host around `NovaAgent`
- `src-tauri/` — windowing, folder picker, settings store, sidecar process bridge
