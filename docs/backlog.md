# Nova Desktop — what it should be, what is missing, and the task list

> Paths in this document are relative to this repository. References to `nova-cli` and the agent
> core point into [chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent), where
> they are developed.


Audited 2026-08-27 against this repository (React + Tauri shell, `sidecar/` Node host driving
`@circuit-nova/nova-core`) and compared with what [`nova-cli`](https://github.com/chrisnkuno/circuit-agent/tree/main/packages/nova-cli) already does. Every gap below
names the file that proves it, so nothing here rests on impression. Same rule as the gap register:
an item closes on named evidence, not on a component existing.

## What a desktop agent app is expected to be

Two things decide this, and only one of them comes from the market.

**From the field (2026).** The agent itself is table stakes — multi-file edits, tool use, long-running
work. What separates a desktop app from a terminal is that it *hosts* the agent: it surfaces the work
(diffs, cost, plan, activity) and then gets out of the way; it runs work in the background and tells
you when it is done; it survives being closed; and it uses the OS — notifications, tray, deep links,
a real updater — because that is the only reason to leave the terminal at all.

**From this codebase.** Nova's own promise is legible autonomy: bounded, priced, interruptible,
auditable work. A desktop window is where that promise is easiest to keep — there is room for the
diff next to the approval, the cost next to the turn, the plan next to the transcript — and every gap
below is a place where the window is currently *less* legible than the terminal.

The bar this list is written against:

1. Everything the CLI can do is reachable in the window, or is deliberately and visibly not.
2. Nothing consequential is approved blind — an approval shows the exact change, not a summary.
3. Long work survives: the window can close, the engine can die, the session comes back.
4. The OS is used where it is the difference: notification on completion, tray, single instance.
5. The window never becomes a dead frame that looks merely busy.

## P0 — the window is currently worse than the terminal at these

| # | Gap | Evidence | Closure evidence |
|---|---|---|---|
| 1 | **Partially closed — the engine can restart, but tabs do not reconnect automatically.** The dead-engine screen now starts a fresh sidecar and reapplies settings; the last project reopens and saved sessions are resumable. Exact per-tab recovery after a crash remains missing. | `src/App.tsx`, `src/lib/ipc.ts` | Full closure: kill the sidecar mid-session; the app automatically restarts it, re-opens every tab by session id, and replays each transcript without manual selection |
| 2 | **Closed 2026-08-27 — file approvals show the exact proposed change.** The daemon forwards the bounded write/edit preview and safety classification; the modal renders the new file or exact old/new replacement before any decision. | `src/components/ApprovalModal.tsx`, `sidecar/src/host.ts` | Integration test observes the preview before responding, denies it, and proves the file stayed unchanged; component tests cover write/edit rendering and sensitive reasons |
| 3 | **No background work.** The CLI has `/detach`, `/jobs`, `/watch`, `/attach` and durable job state; the sidecar has no job handlers at all, so the desktop can only run what the front tab is watching. | `sidecar/src/host.ts:164-244` (no job case), [`nova-cli/src/jobs-command.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/jobs-command.ts) | Start work, close the window, reopen: the job is still running and its output is attachable; approvals raised by a background job reach the window |
| 4 | **Closed 2026-08-27 — memory is reachable and shared.** The window lists, adds and forgets project/user memory through the same core files as `/memory`, including kind and exact scoped index. | `src/components/MemoryPanel.tsx`, `src/lib/ipc.ts` | Component coverage plus shared sidecar/core implementation; cross-surface packaged smoke remains in the release checklist below |
| 5 | **Partially closed 2026-08-27 — Undo scopes match; checkpoint browsing remains.** The window exposes code, conversation, or both, restores visible conversation after undo, and refreshes the diff. It still lacks a checkpoint timeline for restoring older turns. | `src/components/ModeBar.tsx`, `sidecar/src/host.ts`, `sidecar/src/host.test.ts` | Real Git test proves code-only restore; add a browsable checkpoint timeline to fully close |

## P1 — capability the terminal has and the window does not

| # | Gap | Evidence | Closure evidence |
|---|---|---|---|
| 6 | **No content search.** `files.list` is glob-only and `files.read` reads; there is no grep, so finding code in the window means asking the agent to do it. | `src/lib/ipc.ts:167,180`, `sidecar/src/host.ts:229-237` | Project-wide search returns ranked matches with file:line and opens the hit |
| 7 | **Files are read-only.** The CLI has a built-in editor (`/edit`) that writes through the workspace, sandbox included; the desktop can only view. | `sidecar/src/host.ts:233` (no write case), [`nova-cli/src/editor-screen.tsx`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/editor-screen.tsx) | A file edited in the window is written through the workspace and appears in the next diff |
| 8 | **Closed 2026-08-27 — tools and provenance are visible.** The panel reads `NovaDaemonClient.inspectTools()` for the active tab and shows mode-scoped built-ins, skills/plugins/MCP provenance, effect and approval posture. | `src/components/ToolsPanel.tsx`, `sidecar/src/host.ts` | Sidecar integration and component tests cover mode scoping, provenance and filtering |
| 9 | **Inline `@` completion is missing.** The File panel can already append a real `@path` mention, but typing `@` in the composer offers no project-tree completion. | `src/lib/composer.ts`, `src/components/FilePanel.tsx` | Typing `@` completes against the project tree and the selected reference reaches the turn unchanged |
| 10 | **No transcript export.** Copy exists per message; there is no session export or share. | `src/components/Message.tsx:9` | A session exports to Markdown/JSON with tool calls and cost intact |
| 11 | **No way to pay.** The CLI now has `/pay` (top-up, balance, `status <ref>`) against a billing gateway; the desktop has no payment surface at all, and a window is the easier place to show a checkout. | [`nova-cli/src/pay.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/pay.ts) vs this repository (no billing IPC) | The window creates a checkout, shows the link and code, confirms the payment, and shows the balance the service reports |
| 12 | **Voice and `/wander` are CLI-only.** Both exist in the CLI and have no desktop surface; the window is where a microphone is actually convenient. | [`nova-cli/src/voice.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/voice.ts), [`nova-cli/src/wander.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/wander.ts) | Voice capture produces an editable prompt in the composer |

## P2 — desktop-native behaviour that is entirely absent

| # | Gap | Evidence | Closure evidence |
|---|---|---|---|
| 13 | **No OS notification when long work finishes or an approval is waiting.** Zero references to the notification plugin anywhere in the app. This is the single biggest reason to run a desktop agent rather than a terminal one, and it is not wired. | no match for `notification` in `src`, `src-tauri/src`, `tauri.conf.json` | An approval raised while the window is unfocused fires a native notification that focuses the right tab |
| 14 | **No tray, no global shortcut, no deep link, no single-instance guard.** | same search, `src-tauri/capabilities/default.json` | Tray shows running/waiting state; a global chord focuses the composer; `nova://` opens a session; a second launch focuses the existing window |
| 15 | **Window state is not remembered** beyond workspace state — size, position and monitor are not restored. | `src/lib/ipc.ts:228-235` | Reopening restores the previous window geometry |
| 16 | **No offline/credential-failure state distinct from a crash.** Provider failures surface as generic errors. | `src/lib/crash.ts`, `src/App.tsx` boot error path | A provider outage and a missing key produce distinct, actionable states |

## Done in the 2026-08-27 desktop parity pass

- Resumed sessions now repaint their durable user/assistant transcript instead of showing an empty
  window while the model privately retains the context.
- The Activity panel forwards named progress and keeps bounded successful command/tool output
  expandable, so a passing test run is visible evidence rather than a green word with no output.
- The Changes panel receives the current diff stat on open/resume/turn/undo; the diff and open-file
  panels re-read when the workspace revision changes.
- `/tools` and `/memory` now have native desktop panels backed by the same daemon/core paths.
- Undo now offers code, conversation or both. Full completion still requires the older-checkpoint
  timeline, not another undo implementation.
- Edit/write approvals render the exact proposed replacement or new-file contents and the core's
  sensitive-action reason before a decision is accepted.
- A searchable Commands palette (Ctrl G) exposes desktop actions by intent, following the CLI's
  progressive-discovery model without routing UI actions through slash-command text.
- A dead sidecar now has a real Restart engine action that reapplies settings and restores the last
  project instead of sending the user to Settings with no route back to work.

## Exact work remaining for full parity

1. P0: sidecar crash restart/reconnect and per-tab transcript replay.
2. P0: durable background jobs with attach/watch and approval routing after window restart.
3. P0: checkpoint timeline and restore-to-selected-turn.
4. P1: project-wide content search, workspace-backed editing, inline `@` completion, transcript export, payment, voice and
   the bounded research lab.
5. P2: native notifications, tray/single-instance/deep links, window geometry restore, and distinct
   offline/provider states.
6. Release proof: packaged Linux smoke, then signed Windows and macOS packages, with a real visual
   pass for narrow/short windows, resumed transcripts, diff refresh, approvals and updater behavior.

## Done in this pass (CLI)

- **Environment awareness before the first command.** The agent now probes what is actually installed
  where commands run — backend and shell rules, package manager from the committed lockfile, and a
  measured available/missing program list — and states it in the system prompt.
  `@circuit-nova/nova-core/nova-cli/environment.ts`, probed once per session in `agent.ts`.
- **A missing program is reported as one.** `run_command` now names the program and tells the model
  not to retry, instead of returning a bare `ENOENT` the model reads as transient.
  `@circuit-nova/nova-core/nova-cli/tools.ts` (`missingProgram`).
- **Paying from the CLI.** `/pay <amount>` tops up Nova credit through a provider-agnostic billing
  gateway with a Circuit Pay adapter: the CLI creates a checkout and polls, and the card or PIN is
  only ever entered on the provider's page. Nothing is created before the confirmation, an
  unconfirmed payment is never reported as failed, and the balance is always read back rather than
  computed. `@circuit-nova/nova-core/nova-cli/billing`, [`nova-cli/src/pay.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/pay.ts).
- **`Unsupported model finish reason: null` fixed.** An unstated finish reason is read from the
  payload (tool calls → tool turn, text → stop) rather than throwing away a complete turn; an
  unrecognised *word* still errors. `@circuit-nova/nova-core/providers/openai-compatible.ts`,
  `circuitnotion.ts`.

`/todos` and `/detach` were checked and are implemented in the CLI (`nova-cli/src/commands.ts:34,53`,
`jobs-command.ts:70`) — the lines quoted from the session were their help text, not a failure. Their
desktop equivalents are items 3 and 5 above.
