# nova

A coding agent that runs in your terminal — against your working tree, or inside an isolated remote sandbox when the work shouldn't touch your machine.

```bash
npm install -g @circuit-nova/nova-cli
nova "fix the failing test in src/parser.ts"
```

## What it does

Nova reads, searches, edits and runs commands in a real project, then reports what actually happened. It guards effectful work according to the selected mode, snapshots the workspace so you can undo a turn, and tells you what each request cost.

```
nova                        Interactive session
nova "add a health check"   One request, then exit
nova --plan                 Read and reason only — the write tools aren't loaded
nova --auto                 Auto-apply ordinary edits; sensitive actions still ask
nova --defender             Security review — find and fix real issues; every change still asks
nova --allow-sensitive      Approve a flagged task preflight; tool guards remain active
nova --sandbox              Work in a remote sandbox; your files are never touched
nova --resume               Continue the last session
nova history                Browse past sessions without starting a model
nova history search "text"  Search indexed snapshot and journal evidence
nova history status         Show native-index or portable-fallback status
nova --providers            Show which model providers are configured
nova --location EG          Use the country's local currency (locale-detected by default)
nova --currency EGP         Override with any supported ISO currency
nova --budget 500           Approve and enforce a session spend cap in that currency
nova --estimate "task"      Forecast input/output tokens and cost without calling a model
nova settings               Configure keys, URLs, models, pricing, language and voice
nova --language ar          Localize controls (also: en zh hi es fr bn pt ru ur)
nova acp                    Speak the Agent Client Protocol on stdio, for an editor
nova update                 Check and install the latest published CLI
nova update --check         Check without changing the installed version
```

With a CircuitNotion key, Nova defaults to `circuit-2-turbo`. `/models refresh` asks configured
providers for their current catalog; ordinary `/models` uses the cache so opening a menu does not
wait on the network. Slash commands belong inside an interactive session. Passing one as a one-shot
objective is rejected before model contact, preventing an invocation mistake from becoming a paid
prompt.

In a session: `/mode` shows the current permission posture, `/mode plan|build|auto|defender` switches it, and `/plan` `/build` `/auto` `/defender` remain quick shortcuts. Defender mode turns Nova into a security reviewer — the full tool set to actually run a scanner (including a built-in `scan_secrets` that matches likely credentials by pattern and always masks what it finds) and propose a fix, gated exactly like build so nothing is ever auto-approved. It works from a bundled, OWASP-2025-aligned set of playbooks: access control, security misconfiguration, software supply chain & CI/CD integrity, injection, client-side & browser security, auth/session handling, API security, SSRF, secrets, dependency risk, cryptography misuse, IaC/container hardening, exceptional-condition handling, business logic & race conditions, fuzzing and invariant-based testing, logging/monitoring/deterrence, and LLM/AI application security. `/undo` reverts the last turn, `/cost` shows the breakdown — totals, a table of every turn's tokens, tools, seconds and spend, and the shape of it as charts — `/pull` copies sandbox work back to disk, `/settings` opens configuration, `/voice` records a prompt, and `/keys` shows keyboard controls.

## Setup

Nova needs one model provider. It uses the one you last switched to, or the first one configured, unless `--provider` says otherwise.

The easiest interactive setup is:

```bash
nova settings
```

The menu is navigable with the arrow keys — Up/Down, PageUp/PageDown, Home/End — and Enter opens the highlighted setting. Values with a knowable set of answers (location, language, display currency, default provider) are picked from a list rather than typed, so choosing Rwanda does not require knowing it is `RW`, and each country shows the currency it selects. Typing letters filters a long list. Every row is still numbered and a typed number still jumps to it, which is the path that works with a screen reader; piped and scripted runs keep the plain numbered menu.

Settings use the native per-user config directory on Windows, macOS, and Linux. Secret values are masked in the menu and the file is written with user-only permissions where the operating system supports POSIX modes. Environment variables always override saved settings, which keeps CI and one-off shell configuration predictable.

```bash
export ANTHROPIC_API_KEY=...        # or OPENAI_API_KEY, or CIRCUITNOTION_API_KEY
nova --providers                    # shows exactly what's set and what's missing
```

Anthropic models are priced in this build, so costs are reported without further setup. For any other model, set its published rate — otherwise Nova reports `cost unknown` rather than inventing a number:

```bash
export MODEL_INPUT_PER_MILLION=1.5      # per million tokens, in MODEL_PRICE_CURRENCY (default USD)
export MODEL_OUTPUT_PER_MILLION=6
export NOVA_COUNTRY=RW                  # optional; otherwise LANG/LC_MONETARY is used
export NOVA_CURRENCY=RWF                # optional manual override; any supported ISO currency
# Both are also in `nova settings`, where changing your location takes effect immediately
export NOVA_FX_RWF_PER_USD=1320         # required to show USD-priced models in RWF
# Generic offline/manual pair: NOVA_FX_FROM=USD NOVA_FX_TO=EGP NOVA_FX_RATE=48.5
```

Remote sandboxes additionally need `E2B_API_KEY`.

Optional web search uses Exa. Add `EXA_API_KEY` through `nova settings` or your environment; `/providers` then reports `Exa search · web_search enabled`, and the agent receives a bounded highlights-only `web_search` tool. `EXA_BASE_URL` supports an Exa-compatible gateway without changing the tool contract.

## Updating Nova

Nova can update its global installation through npm, pnpm, Yarn, or Bun. It checks the public registry, pins the exact version it found, and asks before invoking the package manager:

```bash
nova update
nova --update
nova update --check
nova update --yes
nova update --package-manager pnpm
nova --version
```

Use `--yes` for an explicitly unattended update. Without it, Nova refuses to mutate an installation when no interactive terminal is attached. Set `NOVA_UPDATE_PACKAGE_MANAGER` to choose a persistent package-manager override.

## How it behaves

**Plan mode cannot write.** The write and command tools are not offered to the model at all — it's a capability boundary, not an instruction.

**Approvals start with a consequence-based safety preflight.** Before estimation or model contact, build and auto modes detect credential disclosure or high-impact credential lifecycle changes, destructive data operations, production releases, financial transactions, private-data export, external publication, or weakened access controls. Interactive runs ask whether to continue; unattended runs fail closed unless the operator explicitly passes `--allow-sensitive`. Merely reading a project-local `.env`, inspecting a project-owned environment variable, or configuring a local token the user intentionally supplied is ordinary development work and does not trip this task-level gate.

**Auto approval is guarded.** Auto mode skips prompts only for ordinary workspace-local edits and commands. It inspects the exact proposed command, file path, and new content first. Local secret reads such as `cat .env` may run, but credential-file writes, secret-like new content, likely credential transmission, production configuration, destructive or privileged commands, deploys, package publication, pushes, and network mutations still require a separate tool approval. Nova may use a pasted secret for the task the user named, but is instructed not to repeat it in prose, logs, summaries, examples, commits, or unrelated files, and never to send it to an unnamed external destination. `--allow-sensitive` acknowledges the task preflight; it never bypasses these operation-level gates. Build mode continues to ask for every effectful call. Decisions use `[y]es / [n]o / [a]lways / [d]eny always` and are remembered only for the exact action.

**Locally, an approved command runs as you.** This is the part worth being plain about: on your own machine there is no sandbox around `run_command`. Once you approve it, it has exactly the authority your shell has — it can read and write files outside the project and reach the network. Nova narrows *what gets proposed* (plan mode cannot run commands at all, a small set are refused outright, and auto mode still stops for anything sensitive), and Nova contains the process *tree* on Linux so a cancelled or timed-out command cannot leave background processes behind. Neither of those is a security boundary. The approval prompt is the boundary, which is why it shows the exact command and why a tool that did not ship with Nova always says where it came from. When you need a real one, `--sandbox` and `--sandbox docker` put the work inside a container.

**Spending is bounded before work starts.** `--budget N` is expressed in the selected local currency. In an interactive session Nova confirms that cap before starting a sandbox or calling a model; in a one-shot command the explicit flag is the approval. If the required FX rate is unavailable, Nova refuses to pretend it can enforce a converted cap.

**Switching models is a menu, not a lookup.** `/model` opens a picker: arrow to a model and press Enter, with each one's price beside it and the cursor starting on the one in use. Press `t` and the same models become a table — input and output price in columns of their own, `←`/`→` to aim at a column and `s` to order by it, so "which of these is cheapest" is a keystroke rather than a read-through. Each row keeps the number `/model <n>` takes, so sorting never renumbers anything; `Esc` returns to the menu, and Enter switches from either view. Providers you have no key for are rows you can select, and selecting one opens settings — so a missing key is something you fix from where you noticed it. Typed forms skip the menu entirely: `/model opus` matches on any part of a model id and says which candidates it meant if the name is ambiguous. The transcript carries across the switch, and your choice is remembered for the next launch.

**Large output leaves the conversation instead of being cut off.** A tool result too big for the transcript is written to `.nova/artifacts/`, and the model receives the beginning, the end, and the path. The end is the half that matters — a failing test says what failed on its last line — and the rest stays reachable through `read_file` with an offset, so nothing is lost to make room. Artifacts are content-addressed, so the same output repeated three times is one file.

**Compaction happens at a boundary, and cannot quietly drop the rules.** Past 70% of the context window Nova summarizes as soon as the work reaches a clean stopping point; past 90% it summarizes regardless. A summary is lossy by design, so the governing facts are never left inside one: the permission mode, the original request, every action you approved or refused, and the plan's open items are re-derived from live state at each compaction and restated verbatim above the summary. A constraint that survives only as a sentence in a summary is a constraint that stops existing a few compactions later.

**Undo is real.** Each turn snapshots the workspace into a private git index. `/undo` reverts modified files *and* removes files the agent created, without touching your staged changes.

**Verification is required.** An agent that changes files and then declares success without running anything is reported as `needs_verification`, not `completed`.

Passing targeted tests finish a focused change. Nova does not automatically pay another model
round to demand new property tests and an assembled-app smoke test after every small fix; when no
verification ran, it asks once for the smallest relevant existing check. If a model names a tool
the current mode does not expose, the runtime returns that fact once so Plan mode can recover with
a useful answer, then fails closed if the model repeats it.

**Paying happens on the provider's page, never in the terminal.** `/pay 5000` tops up your Nova credit: Nova creates a checkout, shows the link, a short code and a reference, and waits. Your card, PIN and mobile-money confirmation are entered on Circuit Pay's own page — Nova never sees them and never asks. Nothing is created until you answer the confirmation, amounts are whole RWF (a decimal is refused, not rounded), and every attempt carries an idempotency key so a retried request cannot become a second charge. Ctrl+C stops waiting without cancelling the payment; if it is still unconfirmed, Nova says so and keeps the reference for `/pay status <ref>` rather than calling it failed. `/pay` on its own shows the balance — always the figure the service reports, never one Nova worked out. After each CircuitNotion turn, Nova proactively warns when that confirmed balance is low, below the critical 500 RWF level, or dropping unusually fast. Before a demanding task it compares the token-based estimate with the confirmed balance and stops before contacting the model when even the conservative estimate cannot fit. Every notice points to `/cost`, `/slow`, and `/pay`; Nova never tops up automatically. The default low-balance floor is 2,000 RWF and can be changed with `NOVA_LOW_BALANCE_RWF`. Set `NOVA_BILLING_URL` and `NOVA_BILLING_KEY` to enable it.

**Costs are honest.** Sub-cent amounts display as `$0.0034` rather than `$0.00`, converted amounts name the daily rate and its date, and an unpriced model says so instead of showing zero. Automatic conversion uses the keyless daily [exchange-api](https://github.com/fawazahmed0/exchange-api) endpoints with their fallback host; set `NOVA_FX_OFFLINE=true` to disable lookup.

**Estimates are token-based.** Before a turn, Nova counts the actual system prompt, conversation history, objective, and tool schemas, then forecasts cumulative input growth across the expected agent loop. `nova --estimate "task"` performs that preflight without starting a sandbox or calling a model. Provider-reported usage remains the final accounting truth.

## Memory and recall

Nova keeps durable memory in plain markdown you can inspect, commit, edit, or delete: project knowledge lives in `.nova/memory.md`; personal preferences live beside your Nova settings. `# we use bun, not npm` records a project fact. `/memory` shows both stores and their budgets.

Memory is deliberately smaller than history. Core facts marked with `--core` are always recalled; everything else is selected locally for the current request by matching repository names, commands, files, and domain terms. Already-recalled entries are not sent again in the same thread. This keeps prompt cost bounded without an embedding service or sending memory to another provider.

```text
/memory add --kind convention we use bun, not npm
/memory add --core --user --kind preference keep explanations concise
/memory replace use bun => use bun 1.3 and never npm
/memory recall package scripts
/memory forget 2
```

Kinds are `preference`, `convention`, `decision`, `lesson`, and `fact`. Memory writes reject invisible formatting and instruction-shaped injection content. A unique text fragment can replace an entry, avoiding fragile row numbers when correcting knowledge. `/history search <text>` uses the local native SQLite + FTS5 index when its platform package is installed, returning ranked snapshot or journal evidence with context. It falls back automatically to verified session JSON when the native engine is unavailable. `/history status` shows which path is active. This is the larger episodic layer for details that do not deserve permanent prompt space.

`/history resume` opens a searchable conversation chooser and works across processes. The saved
permission mode returns with the transcript, while an explicit startup flag such as
`nova --auto --resume …` deliberately overrides it. Nova's verification nudges are internal: they
are neither counted as user turns nor indexed as things you said.

## Reliability evidence

Nova's scheduled end-to-end suite runs build, debug, scoped search, Defender review, and
cross-process resume journeys. It independently validates the result and scores completion,
verification, valid tools, token economy, estimate calibration, scope, and state. The repository's
`reliability/` directory contains the raw report and animated spectator UI. False success and
silent permission escalation impose hard score caps.

## Voice, language and keyboard input

Run `/voice` to record from the default microphone, or `/voice path/to/audio.wav` to transcribe an existing file. The transcript is shown and can be edited or cancelled before it becomes a prompt. Voice transcription uses `OPENAI_API_KEY`, `gpt-4o-mini-transcribe` by default, and an OpenAI-compatible `/audio/transcriptions` endpoint. Set `VOICE_TRANSCRIPTION_URL` or `VOICE_MODEL` in `nova settings` when needed.

Microphone recording uses `ffmpeg` because it provides one maintained capture path across operating systems. Install it with your normal package manager and set `VOICE_INPUT_DEVICE` if the default device is not correct. Nova uses PulseAudio on Linux, AVFoundation on macOS, and DirectShow on Windows; `NOVA_FFMPEG_PATH` can point to a non-standard executable.

Controls are available in English, Mandarin Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian, and Urdu. Choose one in `nova settings`, set `NOVA_LANGUAGE`, or pass `--language`. Stable slash-command names remain unchanged for scripts and muscle memory; `/help` and `/keys` localize their descriptions.

Prompt history is persisted per user, deduplicated, and filters likely credentials. Tab completes commands, `@path` completes project files, arrow keys search history, Home/End navigate, Alt-Backspace/Ctrl-U delete, Ctrl-L redraws, and Ctrl-C interrupts the active turn.

### Suggestions as you type

Typing `/` opens a list above the input bar, narrowing with every letter and showing what each command does — plus the key that also runs it, so the list teaches its own shortcuts. Up and Down move through it and Enter takes a row; keep typing and it keeps narrowing; press Return and the command runs. It is never modal: every keystroke still reaches the line editor, so `/model haiku` types straight through the list that is offering `/model`. Greyed-out ghost text completes the rest of the name inline, and `→` accepts it.

The list draws upward, into the rows directly above the bar. That is not a style choice — readline redraws its own line by erasing everything below it, so the rows above the bar are the only ones a list can occupy and survive a keystroke.

### Keys

The commands people reach for most are on Ctrl:

| | | | |
|---|---|---|---|
| `Ctrl+A` auto mode | `Ctrl+W` wander | `Ctrl+S` settings | `Ctrl+G` palette |

Every command with a shortcut also has an Alt mnemonic, which is the fuller set:

| | | | |
|---|---|---|---|
| `Alt+W` wander | `Alt+M` model | `Alt+A` auto mode | `Alt+P` plan mode |
| `Alt+D` diff | `Alt+U` undo | `Alt+C` cost | `Alt+O` tools |
| `Alt+H` help | `Alt+T` new tab | `Alt+←` `Alt+→` tabs | `Alt+B` detach |

**Tabs hold several pieces of work; the one in front is the one that runs.** Each tab keeps its own
conversation, model, mode, cost and location, and switching away pauses that piece of work rather
than leaving it running — a terminal transcript has one bottom, and two agents printing into it at
once would interleave into something neither of them said. When you want work that keeps going while
you do something else, that is `/detach`, `/jobs` and `/watch`: a detached job survives the terminal
closing and streams into the session without taking the prompt. (Nova's desktop window is the other
way round — it has a transcript per tab, so its tabs do run at the same time.)

The function keys still work for the commands that had them (`F1` help, `F2` mode, `F3` model, `F4` wander, `F6` jobs, `F8` diff, `F9` todos) — several routes to the same command, so a terminal that swallows one does not cost you the feature. That redundancy is the reason there is a Ctrl layer at all: Alt is the modifier terminals are worst at delivering (tmux eats it by default, and macOS Terminal sends Option as a composition modifier unless you have found the "Use Option as Meta key" checkbox), so the most-used commands get a route that does not depend on it.

Three of those Ctrl chords were readline line-editing keys, and taking them is not free. Each function moved to a key readline already handles natively, and `/keys` prints the move beside the chord that took it:

| Was | Now | Still available as |
|---|---|---|
| `Ctrl+A` move to start of line | `/auto` | `Home` |
| `Ctrl+W` delete the previous word | `/wander` | `Alt+Backspace` |
| `Ctrl+S` XOFF flow control | `/settings` | — (raw mode disables flow control, so this key was inert) |

A line-editing key can only be taken when its function has somewhere else to live, which is why `Ctrl+U` (delete to start of line) and `Ctrl+K` (delete to end) stay refused — nothing else does their job. `Ctrl+C`, `Ctrl+D`, Tab and Enter can never be rebound at all.

There is no `Ctrl+M`. It is byte `0x0D`, which is exactly what Return sends, so no terminal can tell the two apart — binding it would fire the shortcut on every message you send. The same is true of `Ctrl+I` (Tab) and `Ctrl+J`. `/model` is on `Alt+M` and `F3`; asking for `ctrl+m` in your configuration reports this rather than failing silently.

Bare letters are not shortcuts, for a reason worth knowing: this prompt is where you type your request, so a bare `w` for wander would cost you every message beginning with "write".

`Ctrl+G` opens the command palette, which searches every command by name *or* by what it does — typing `revert` finds `/undo`, and letters that are not adjacent still match, so `wndr` finds `/wander`. Arrow keys, `Ctrl+P`/`Ctrl+N`, PageUp/PageDown and Home/End all move through it.

`/keys` shows the live table, including anything your terminal is unlikely to deliver. To rebind, set `NOVA_KEYS` (or the key-bindings entry in `nova settings`) to a comma-separated list like `/diff=alt+x, /wander=off`. An override replaces that command's default keys rather than adding to them.

## Sandbox mode

`--sandbox` runs everything in a disposable E2B container. Files exist only there; `--upload` seeds it with a copy of your project, and `/pull` brings results back.

```bash
nova --sandbox --upload "try upgrading to the new API and run the tests"
```

The sandbox executes commands as argv against an allowlist rather than through a shell, so pipes and redirection are unavailable there — Nova says so rather than failing obscurely.

`--sandbox docker` uses a local Docker container instead of a remote one, for keeping work off your working tree without sending it to a third party. Pick the image with `--docker-image` or `DOCKER_CODING_IMAGE`.

## Extending Nova: skills, hooks, plugins and MCP

Everything here lives under `.nova/` in your project, so it travels with the repository and works the same in a local, Docker or E2B session. `/tools` lists whatever is currently loaded and where each piece came from.

**Skills** are commands you name and describe, in `.nova/skills/<name>/skill.json`:

```json
{
  "name": "coverage",
  "description": "Reports test coverage for a package.",
  "command": "npm run coverage -- --scope {{package}}",
  "inputSchema": {
    "type": "object",
    "properties": { "package": { "type": "string" } },
    "required": ["package"],
    "additionalProperties": false
  }
}
```

`{{package}}` is filled in with the model's argument, quoted for the shell that will run it — arguments are never pasted into the command raw.

**Hooks** are scripts that see every tool call, in `.nova/hooks/pre-tool-use/` and `.nova/hooks/post-tool-use/`. They run in filename order and receive the call as base64 JSON in `NOVA_HOOK_EVENT_B64`. A pre-tool-use hook that exits non-zero blocks the call and its stderr becomes the reason the model is given; a post-tool-use hook can only warn, since the work has already happened.

**MCP servers** go in `.nova/mcp.json` as `{ "servers": [{ "id": "…", "command": "…", "args": [], "env": {} }] }`. Nova speaks stdio JSON-RPC to them and offers their tools alongside its own.

**Plugins** bundle all three under `.nova/plugins/<name>/`, with a `plugin.json` naming any MCP servers plus optional `skills/` and `hooks/` directories in the same formats.

Every tool that does not ship with Nova is approval-gated on every call regardless of mode, and the approval prompt names where it came from — a tool called `deploy` from an MCP server never looks like one of Nova's own.

On Windows, hook scripts need an extension `cmd.exe` can execute (`.cmd` or `.bat`, or a `.ps1` invoked through one); a `.sh` file will not run without a POSIX shell installed. Skill commands and hook invocations are quoted for `cmd.exe` automatically when the session is local — a sandbox session is always quoted for Linux, since that is what the container runs.

## Editors: the Agent Client Protocol

`nova acp` runs the same agent over stdio in [ACP](https://agentclientprotocol.com), the protocol Zed and JetBrains use to host an agent, so an editor can drive a Nova session without a bespoke integration. Streaming replies arrive as `session/update` notifications, every tool call is announced and updated, and an approval becomes a `session/request_permission` request the editor answers — the same four decisions the terminal offers, with the same rule that anything other than an explicit allow is a refusal.

```jsonc
// what an editor sends, one JSON-RPC message per line
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}
{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/path/to/project"}}
{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"…","prompt":[{"type":"text","text":"fix the failing test"}]}}
```

`session/load` resumes a stored session, and `session/set_mode` switches between `plan`, `build`, `auto` and `defender` — rebuilding the session under the new capability set, exactly as `/mode` does in the terminal, because plan mode is a mode in which the write tools are not loaded rather than one where they are discouraged. While `nova acp` is running, stdout carries only protocol messages; diagnostics go to stderr.

## Requirements

Node 22.5 or newer on Windows, macOS, or Linux. `git` enables checkpoints (Nova degrades to no-undo without it). `ffmpeg` is optional and needed only for direct microphone recording; existing audio files can still be transcribed without it.

MIT licensed.
