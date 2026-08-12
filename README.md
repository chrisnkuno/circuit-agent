# Nova Desktop

Windows-first Tauri 2 app for the Nova coding agent. The UI talks to a Node sidecar that runs `@circuit-nova/nova-core` (`NovaAgent`) with the same `.nova/` session format as `nova-cli`.

## Features

- Settings that ask for one thing: paste an API key. Base URL, budget, sandbox and relay are all
  still there, behind a disclosure, because only one of them is required
- **Test this key** checks credentials before you commit to them, using the provider's model list —
  an authenticated call that generates no tokens, so it costs nothing
- Chat with streaming assistant output, rendered with code blocks and per-block copy
- Modes: Plan / Build / Auto, as one segmented control that states the posture it puts you in
- Per-tool approval dialog showing the exact command, answerable with `Y` / `N` / `A` / `D` or Escape
- Sessions list + resume
- Undo (git checkpoints), cost panel, cancel
- The agent's plan as a live panel
- E2B sandbox toggle, upload, pull
- Follows the system light/dark setting
- Keyboard throughout: Ctrl+Enter send, Esc stop, Ctrl+M model, Ctrl+D changes, Ctrl+Z undo,
  Ctrl+, settings, Alt+1/2/3 mode — listed in the Keyboard panel so they can be found

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

```bash
npm run package:windows
```

This compiles the Windows sidecar and verifies it is a real executable rather than a wrapper, then
builds the installers — but only when run on Windows, since Tauri's MSI and NSIS targets need the
MSVC toolchain and cannot be cross-compiled. On other platforms it prepares and checks the artifact
and prints the one remaining command. CI builds both halves on every push.

## Architecture

- `src/` — React UI
- `sidecar/` — JSONL stdio host around `NovaAgent`
- `src-tauri/` — windowing, folder picker, settings store, sidecar process bridge
