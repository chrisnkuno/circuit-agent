# Architecture

Three processes, one window.

```
┌─────────────────────────────────────────────────────────────┐
│  src-tauri/  — Rust shell                                   │
│  windowing · folder picker · settings store · updater       │
│  owns the sidecar process and bridges stdio to the webview  │
│                                                             │
│  ┌───────────────────────────┐   JSONL over stdio           │
│  │  src/  — React window     │◄─────────────┐               │
│  │  components/  what is seen│              │               │
│  │  lib/         the logic   │              │               │
│  └───────────────────────────┘              │               │
└─────────────────────────────────────────────┼───────────────┘
                                              ▼
                          ┌────────────────────────────────────┐
                          │  sidecar/  — the host               │
                          │  NovaSessionDaemon per session      │
                          │  tab routing · cost ledger · tools  │
                          └────────────────┬───────────────────┘
                                           │  imports
                                           ▼
                      @circuit-nova/nova-core  (npm, from circuit-agent)
                      agent runtime · providers · workspaces · cost
```

## Why a sidecar at all

The window is a webview. The agent needs a filesystem, a process table, a network client and an
SDK that assumes Node — none of which a webview should be handed. Putting the runtime in a separate
process means the webview never needs filesystem permission of its own: a file preview shows the
*session's* workspace, so a sandboxed tab shows the sandbox's copy rather than a same-named file on
this machine.

In release builds the sidecar is compiled by `bun build --compile` into a single self-contained
executable that embeds its own runtime, so **an installed app needs no Node**. Tauri resolves it as
an `externalBin` by target triple, which is why macOS ships two per-architecture bundles instead of
one universal binary.

## The seam with nova-core

`@circuit-nova/nova-core` is developed in
[chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent) and consumed here as a
published npm dependency. It owns everything the CLI and the window must agree about:

- the agent loop and the tool contract
- what each permission mode allows — Plan does not offer write tools to the model at all
- provider adapters, the price catalog and cost accounting
- the durable `.nova/` session format, including its permission mode, so resuming a read-only
  planning thread in the window cannot silently reopen it with build authority

This repository owns everything about *seeing and driving* that work: panels, shortcuts, the
approval dialog, tabs, packaging, the updater.

The rule that follows: never reimplement a core behaviour here to avoid a cross-repo round trip.
The CLI and the window disagreeing about what a mode permits is the exact bug the shared core
prevents.

## Tabs

`NovaSessionDaemon` serialises turns *per session* rather than globally, so the window's tabs
genuinely run side by side. The terminal deliberately does the opposite — a scrolling transcript
has one bottom, and two agents printing into it would interleave — so `nova`'s tabs pause when you
leave them and `/detach` is its answer for parallel work. Neither surface should be described in
the other's terms.

Because turns are concurrent, every session-scoped request carries an optional `tabId`, and every
event the sidecar emits is stamped with the tab it came from — taken from the daemon's own
`sessionId`, never from whichever tab is in front. A request naming no tab means "the one in
front", which is what it meant when there was only one.

`sidecar/src/tabs.ts` does the routing; `src/lib/tabs.ts` is its counterpart in the window. A
change to one almost always needs the other.

## Standing constraints

- **Nothing is fetched at runtime.** No webfonts, no CDN, a real CSP in `tauri.conf.json`. A
  desktop window that waits on a third-party host to paint its own text breaks offline.
- **The approval dialog has no default button.** Focus lands on the dialog, so Enter cannot
  approve a command.
- **Dev and release run the same artifact.** `beforeDevCommand` compiles the sidecar binary. They
  diverged once, and a broken Windows package went unnoticed for months.
- **The guide is generated from the shortcut table** the matcher reads, and the suite fails if a
  shortcut is undocumented or a topic claims a chord that does not exist.

## Where to look

| Question | File |
| --- | --- |
| What does the sidecar accept? | `sidecar/src/protocol.ts` |
| Where does a turn actually run? | `sidecar/src/host.ts` |
| How does the window talk to it? | `src/lib/ipc.ts` |
| Per-tab state and event routing | `src/lib/tabs.ts`, `sidecar/src/tabs.ts` |
| Which key does what | `src/lib/shortcuts.ts` |
| What is still missing | [backlog.md](backlog.md) |
