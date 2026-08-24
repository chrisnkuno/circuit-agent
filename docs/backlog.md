# Nova Desktop — what it should be, what is missing, and the task list

> Paths in this document are relative to this repository. References to `nova-cli` and the agent
> core point into [chrisnkuno/circuit-agent](https://github.com/chrisnkuno/circuit-agent), where
> they are developed.


Audited 2026-08-22 against this repository (React + Tauri shell, `sidecar/` Node host driving
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
| 1 | **The engine dying kills the app.** `onSidecarExit` sets a boot error and stops; there is no restart, no reconnect, no session recovery. One sidecar crash costs the whole window and every open tab. | `src/App.tsx:126`, `src/lib/ipc.ts:195` | Sidecar killed mid-session: the app restarts it, re-opens each tab's session by id, and replays the transcript; test asserts recovery without a manual relaunch |
| 2 | **Approvals are granted without seeing the change.** The modal shows a one-line summary; `write_file`/`edit_file` are approved with no diff and no file preview. The security boundary of the app asks for consent to text nobody has read. | `src/components/ApprovalModal.tsx` (no diff path), `src/lib/approval.ts:37` | An edit approval renders the unified diff (and a write shows the content) before any decision is possible; test asserts the dialog cannot decide without the change being rendered |
| 3 | **No background work.** The CLI has `/detach`, `/jobs`, `/watch`, `/attach` and durable job state; the sidecar has no job handlers at all, so the desktop can only run what the front tab is watching. | `sidecar/src/host.ts:164-244` (no job case), [`nova-cli/src/jobs-command.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/jobs-command.ts) | Start work, close the window, reopen: the job is still running and its output is attachable; approvals raised by a background job reach the window |
| 4 | **Memory is implemented but unreachable.** `memory.list`/`memory.add`/`memory.forget` exist in the sidecar and have no IPC wrapper and no UI, so the desktop agent silently has none of the project memory the CLI accumulates. | `sidecar/src/host.ts:202-206` vs `src/lib/ipc.ts` (no memory export) | A fact remembered in the window is recalled in a later desktop session and by the CLI in the same project |
| 5 | **Undo is one turn, one shape.** The CLI undoes code, conversation, or both, and lists checkpoints; the desktop has a single `undo` with no scope and no checkpoint list. | `src/lib/ipc.ts:117`, `sidecar/src/host.ts:706` | Checkpoint list is browsable and restorable, with code/conversation/both selectable, matching `/undo` |

## P1 — capability the terminal has and the window does not

| # | Gap | Evidence | Closure evidence |
|---|---|---|---|
| 6 | **No content search.** `files.list` is glob-only and `files.read` reads; there is no grep, so finding code in the window means asking the agent to do it. | `src/lib/ipc.ts:167,180`, `sidecar/src/host.ts:229-237` | Project-wide search returns ranked matches with file:line and opens the hit |
| 7 | **Files are read-only.** The CLI has a built-in editor (`/edit`) that writes through the workspace, sandbox included; the desktop can only view. | `sidecar/src/host.ts:233` (no write case), [`nova-cli/src/editor-screen.tsx`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/editor-screen.tsx) | A file edited in the window is written through the workspace and appears in the next diff |
| 8 | **What the agent can call is invisible.** No desktop equivalent of `/tools`: skills, hooks, MCP servers and plugins loaded from `.nova/` are not listed anywhere in the UI. | [`nova-cli/src/tools-command.ts`](https://github.com/chrisnkuno/circuit-agent/blob/main/packages/nova-cli/src/tools-command.ts) vs `src` (no tools panel) | A panel lists tools, providers and hook scripts for the session, built from the same call the turn uses |
| 9 | **No `@` file references in the composer.** The composer has no mention grammar, so context has to be described in prose. | `src/lib/composer.ts` (no `@` handling), `src/components/FilePanel.tsx` | Typing `@` completes against the project tree and the reference reaches the turn as a real path |
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
