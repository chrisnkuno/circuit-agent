# nova

A coding agent that runs in your terminal — against your working tree, or inside an isolated remote sandbox when the work shouldn't touch your machine.

```bash
npm install -g @circuit-nova/nova-cli
nova "fix the failing test in src/parser.ts"
```

## What it does

Nova reads, searches, edits and runs commands in a real project, then reports what actually happened. It asks before every change, snapshots the workspace so you can undo a turn, and tells you what each request cost.

```
nova                        Interactive session
nova "add a health check"   One request, then exit
nova --plan                 Read and reason only — the write tools aren't loaded
nova --auto                 Apply edits without per-call approval
nova --sandbox              Work in a remote sandbox; your files are never touched
nova --resume               Continue the last session
nova --providers            Show which model providers are configured
nova --location EG          Use the country's local currency (locale-detected by default)
nova --currency EGP         Override with any supported ISO currency
nova --budget 500           Approve and enforce a session spend cap in that currency
nova update                 Check and install the latest published CLI
nova update --check         Check without changing the installed version
```

In a session: `/plan` `/build` `/auto` switch modes, `/undo` reverts the last turn, `/cost` shows the breakdown, `/pull` copies sandbox work back to disk.

## Setup

Nova needs one model provider. It uses the first one configured unless `--provider` says otherwise.

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

**Every effectful call is approved.** `[y]es / [n]o / [a]lways / [d]eny always`, remembered per tool for the session. A denial sticks: the agent finds another route rather than asking again.

**Spending is bounded before work starts.** `--budget N` is expressed in the selected local currency. In an interactive session Nova confirms that cap before starting a sandbox or calling a model; in a one-shot command the explicit flag is the approval. If the required FX rate is unavailable, Nova refuses to pretend it can enforce a converted cap.

**Undo is real.** Each turn snapshots the workspace into a private git index. `/undo` reverts modified files *and* removes files the agent created, without touching your staged changes.

**Verification is required.** An agent that changes files and then declares success without running anything is reported as `needs_verification`, not `completed`.

**Costs are honest.** Sub-cent amounts display as `$0.0034` rather than `$0.00`, converted amounts name the daily rate and its date, and an unpriced model says so instead of showing zero. Automatic conversion uses the keyless daily [exchange-api](https://github.com/fawazahmed0/exchange-api) endpoints with their fallback host; set `NOVA_FX_OFFLINE=true` to disable lookup.

## Sandbox mode

`--sandbox` runs everything in a disposable E2B container. Files exist only there; `--upload` seeds it with a copy of your project, and `/pull` brings results back.

```bash
nova --sandbox --upload "try upgrading to the new API and run the tests"
```

The sandbox executes commands as argv against an allowlist rather than through a shell, so pipes and redirection are unavailable there — Nova says so rather than failing obscurely.

## Requirements

Node 20 or newer. `git` for checkpoints (Nova degrades to no-undo without it rather than failing).

MIT licensed.
