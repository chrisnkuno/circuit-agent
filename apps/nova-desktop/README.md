# Nova Desktop

Tauri 2 app for the Nova coding agent (Windows-first).

## Settings

- Provider default: CircuitNotion
- API base URL default: `https://api.circuitnotion.com/v1`

## Develop (Linux/macOS)

```bash
cd apps/nova-desktop
npm install
npm run sidecar:build
npm run tauri:dev
```

## Windows executable / installer

### Already built on this machine

Portable build output:

- [`release/windows/Nova.exe`](release/windows/Nova.exe) — main desktop app
- [`release/windows/nova-sidecar.exe`](release/windows/nova-sidecar.exe) — agent runtime

Copy that folder to a Windows PC and run `Nova.exe` (WebView2 required).

### Rebuild

```bash
cd apps/nova-desktop
npm install
npm run sidecar:windows
# Linux cross-compile (needs llvm-rc on PATH, e.g. /usr/lib/llvm-21/bin):
export PATH="/usr/lib/llvm-21/bin:$PATH"
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --no-bundle
# Or on Windows:
npm run package:windows
```

### CI

Workflow: [`.github/workflows/nova-desktop-windows.yml`](../../.github/workflows/nova-desktop-windows.yml) builds NSIS/MSI on `windows-latest`.

## Architecture

React UI → Tauri shell → Node/`pkg` sidecar → `@circuit-nova/nova-core` (`NovaAgent`)
