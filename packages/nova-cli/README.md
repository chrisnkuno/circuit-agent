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

Nova needs one model provider. It uses the first one configured unless `--provider` says otherwise.

The easiest interactive setup is:

```bash
nova settings
```

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

**Spending is bounded before work starts.** `--budget N` is expressed in the selected local currency. In an interactive session Nova confirms that cap before starting a sandbox or calling a model; in a one-shot command the explicit flag is the approval. If the required FX rate is unavailable, Nova refuses to pretend it can enforce a converted cap.

**Undo is real.** Each turn snapshots the workspace into a private git index. `/undo` reverts modified files *and* removes files the agent created, without touching your staged changes.

**Verification is required.** An agent that changes files and then declares success without running anything is reported as `needs_verification`, not `completed`.

**Costs are honest.** Sub-cent amounts display as `$0.0034` rather than `$0.00`, converted amounts name the daily rate and its date, and an unpriced model says so instead of showing zero. Automatic conversion uses the keyless daily [exchange-api](https://github.com/fawazahmed0/exchange-api) endpoints with their fallback host; set `NOVA_FX_OFFLINE=true` to disable lookup.

**Estimates are token-based.** Before a turn, Nova counts the actual system prompt, conversation history, objective, and tool schemas, then forecasts cumulative input growth across the expected agent loop. `nova --estimate "task"` performs that preflight without starting a sandbox or calling a model. Provider-reported usage remains the final accounting truth.

## Voice, language and keyboard input

Run `/voice` to record from the default microphone, or `/voice path/to/audio.wav` to transcribe an existing file. The transcript is shown and can be edited or cancelled before it becomes a prompt. Voice transcription uses `OPENAI_API_KEY`, `gpt-4o-mini-transcribe` by default, and an OpenAI-compatible `/audio/transcriptions` endpoint. Set `VOICE_TRANSCRIPTION_URL` or `VOICE_MODEL` in `nova settings` when needed.

Microphone recording uses `ffmpeg` because it provides one maintained capture path across operating systems. Install it with your normal package manager and set `VOICE_INPUT_DEVICE` if the default device is not correct. Nova uses PulseAudio on Linux, AVFoundation on macOS, and DirectShow on Windows; `NOVA_FFMPEG_PATH` can point to a non-standard executable.

Controls are available in English, Mandarin Chinese, Hindi, Spanish, French, Arabic, Bengali, Portuguese, Russian, and Urdu. Choose one in `nova settings`, set `NOVA_LANGUAGE`, or pass `--language`. Stable slash-command names remain unchanged for scripts and muscle memory; `/help` and `/keys` localize their descriptions.

Prompt history is persisted per user, deduplicated, and filters likely credentials. Tab completes commands, `@path` completes project files, arrow keys search history, Ctrl-A/Ctrl-E navigate, Ctrl-W/Ctrl-U delete, Ctrl-L redraws, and Ctrl-C interrupts the active turn.

## Sandbox mode

`--sandbox` runs everything in a disposable E2B container. Files exist only there; `--upload` seeds it with a copy of your project, and `/pull` brings results back.

```bash
nova --sandbox --upload "try upgrading to the new API and run the tests"
```

The sandbox executes commands as argv against an allowlist rather than through a shell, so pipes and redirection are unavailable there — Nova says so rather than failing obscurely.

## Requirements

Node 22.5 or newer on Windows, macOS, or Linux. `git` enables checkpoints (Nova degrades to no-undo without it). `ffmpeg` is optional and needed only for direct microphone recording; existing audio files can still be transcribed without it.

MIT licensed.
