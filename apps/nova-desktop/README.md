# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a Node sidecar that runs `@circuit-nova/nova-core` (`NovaAgent`) with the same `.nova/` session format as `nova-cli`.

## Features

- Settings: provider, API key, **API base URL** (default `https://api.circuitnotion.com/v1`), model, budget, E2B key
- Chat with streaming assistant output
- Modes: Plan / Build / Auto
- Per-tool approval modal (Yes / No / Always / Deny always)
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- E2B sandbox toggle, upload, pull

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
