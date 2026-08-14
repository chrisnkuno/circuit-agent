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
nova update                 Check and install the latest published CLI
nova update --check         Check without changing the installed version
```

In a session: `/mode` shows the current permission posture, `/mode plan|build|auto` switches it, and `/plan` `/build` `/auto` remain quick shortcuts. `/undo` reverts the last turn, `/cost` shows the breakdown, `/pull` copies sandbox work back to disk, `/settings` opens configuration, `/voice` records a prompt, and `/keys` shows keyboard controls.

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

**Approvals start with a safety preflight.** Before estimation or model contact, build and auto modes detect objectives involving credentials, destructive data operations, production releases, financial transactions, private data, external publication, or weakened access controls. Interactive runs ask whether to continue; unattended runs fail closed unless the operator explicitly passes `--allow-sensitive`.

**Auto approval is guarded.** Auto mode skips prompts only for ordinary workspace-local edits and commands. It inspects the exact proposed command, file path, and new content first. Credential files, secret-like content, production configuration, destructive or privileged commands, deploys, package publication, pushes, and network mutations still require a separate tool approval. `--allow-sensitive` acknowledges the task preflight; it never bypasses these operation-level gates. Build mode continues to ask for every effectful call. Decisions use `[y]es / [n]o / [a]lways / [d]eny always` and are remembered only for the exact action.

**Locally, an approved command runs as you.** This is the part worth being plain about: on your own machine there is no sandbox around `run_command`. Once you approve it, it has exactly the authority your shell has — it can read and write files outside the project and reach the network. Nova narrows *what gets proposed* (plan mode cannot run commands at all, a small set are refused outright, and auto mode still stops for anything sensitive), and Nova contains the process *tree* on Linux so a cancelled or timed-out command cannot leave background processes behind. Neither of those is a security boundary. The approval prompt is the boundary, which is why it shows the exact command and why a tool that did not ship with Nova always says where it came from. When you need a real one, `--sandbox` and `--sandbox docker` put the work inside a container.

**Spending is bounded before work starts.** `--budget N` is expressed in the selected local currency. In an interactive session Nova confirms that cap before starting a sandbox or calling a model; in a one-shot command the explicit flag is the approval. If the required FX rate is unavailable, Nova refuses to pretend it can enforce a converted cap.

**Switching models is a menu, not a lookup.** `/model` opens a picker: arrow to a model and press Enter, with each one's price beside it and the cursor starting on the one in use. Providers you have no key for are rows you can select, and selecting one opens settings — so a missing key is something you fix from where you noticed it. Typed forms skip the menu entirely: `/model opus` matches on any part of a model id and says which candidates it meant if the name is ambiguous. The transcript carries across the switch, and your choice is remembered for the next launch.

**Undo is real.** Each turn snapshots the workspace into a private git index. `/undo` reverts modified files *and* removes files the agent created, without touching your staged changes.

**Verification is required.** An agent that changes files and then declares success without running anything is reported as `needs_verification`, not `completed`.

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

## Voice, language and keyboard input

Run `/voice` to record from the default microphone, or `/voice path/to/audio.wav` to transcribe an existing file. The transcript is shown and can be edited or cancelled before it becomes a prompt. Voice transcription uses `OPENAI_API_KEY`, `gpt-4o-mini-transcribe` by default, and an OpenAI-compatible `/audio/transcriptions` endpoint. Set `VOICE_TRANSCRIPTION_URL` or `VOICE_MODEL` in `nova settings` when needed.

Microphone recording uses `ffmpeg` because it provides one maintained capture path across operating systems. Install it with your normal package manager and set `VOICE_INPUT_DEVICE` if the default device is not correct. Nova uses PulseAudio on Linux, AVFoundation on macOS, and DirectShow on Windows; `NOVA_FFMPEG_PATH` can point to a non-standard executable.

Controls are available in English, Mandarin Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian, and Urdu. Choose one in `nova settings`, set `NOVA_LANGUAGE`, or pass `--language`. Stable slash-command names remain unchanged for scripts and muscle memory; `/help` and `/keys` localize their descriptions.

Prompt history is persisted per user, deduplicated, and filters likely credentials. Tab completes commands, `@path` completes project files, arrow keys search history, Ctrl-A/Ctrl-E navigate, Ctrl-W/Ctrl-U delete, Ctrl-L redraws, and Ctrl-C interrupts the active turn.

### Mnemonic keys

The common commands are on Alt plus their first letter, so you rarely have to type one:

| | | | |
|---|---|---|---|
| `Alt+W` wander | `Alt+M` model | `Alt+A` auto mode | `Alt+P` plan mode |
| `Alt+D` diff | `Alt+U` undo | `Alt+C` cost | `Alt+O` tools |
| `Alt+H` help | `Alt+T` new tab | `Alt+←` `Alt+→` tabs | `Alt+B` detach |

`Ctrl+G` opens the command palette, and the function keys still work for the commands that had them (`F1` help, `F2` mode, `F3` model, `F4` wander, `F6` jobs, `F8` diff, `F9` todos) — two routes to the same command, so a terminal that swallows one does not cost you the feature.

They are on Alt rather than bare letters for a reason worth knowing: this prompt is where you type your request, so a bare `w` for wander would cost you every message beginning with "write". Alt keeps the mnemonic without taking the letter.

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

## Requirements

Node 22.5 or newer on Windows, macOS, or Linux. `git` enables checkpoints (Nova degrades to no-undo without it). `ffmpeg` is optional and needed only for direct microphone recording; existing audio files can still be transcribed without it.

MIT licensed.
