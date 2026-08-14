# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a sidecar that runs `@circuit-nova/nova-core` (`NovaAgent`) with the same `.nova/` session format as `nova-cli`. In release builds the sidecar is compiled into a **single self-contained executable** (via `bun build --compile` on Windows, or `@yao-pkg/pkg` for the Linux cross-build), so end users do **not** need Node installed.

## Features

- Settings: provider, API key, **API base URL** (default `https://api.circuitnotion.com/v1`), model, budget, E2B key
- Chat with streaming assistant output
- Modes: Plan / Build / Auto
- Per-tool approval modal (Yes / No / Always / Deny always)
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- E2B sandbox toggle, upload, pull
- **Auto-update** — checks GitHub Releases and installs new versions in place
- **Portable Windows build** — `release/windows/` folder with `Nova.exe` + sidecar, no installer required

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

On first launch, enter a CircuitNotion (or other) API key. The base URL defaults to CircuitNotion's API.

## Production / Windows packaging

`beforeBuildCommand` runs the frontend build and the sidecar bundle. `sidecar:bundle`
compiles the sidecar + `nova-core` into a single Windows executable
(`src-tauri/binaries/nova-sidecar-x86_64-pc-windows-msvc.exe`) with `bun build --compile`,
so no Node is required on user machines. Tauri then emits the NSIS installer.

```bash
npm run sidecar:bundle   # needs bun on PATH (or npm-global bun) on Windows
npm run tauri:build
```

### Portable build (Linux cross-compile or Windows)

`package-windows.mjs` produces a portable `release/windows/` folder (Nova.exe + sidecar)
that can be copied to any Windows PC (WebView2 required):

```bash
npm run package:windows
```

On Linux it cross-compiles the Tauri app with `cargo-xwin` (needs `llvm-rc` on PATH,
e.g. `/usr/lib/llvm-21/bin`) and builds the sidecar exe with `@yao-pkg/pkg`
(`npm run sidecar:windows`); on Windows it runs a native `tauri build`. The app locates
the sidecar next to its own exe, so the portable folder can live anywhere.

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

- `src/` — React UI
- `sidecar/` — JSONL stdio host around `NovaAgent`
- `src-tauri/` — windowing, folder picker, settings store, sidecar process bridge, updater
