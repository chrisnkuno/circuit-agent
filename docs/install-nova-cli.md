# Installing Nova CLI

Nova is a coding agent that runs in your terminal. It is published to the public npm registry as **`@circuit-nova/nova-cli`** (currently `1.1.0`) and installs a single `nova` binary.

## Requirements

| | |
|---|---|
| **Node.js** | 22.5 or newer (`node --version`) |
| **OS** | Windows, macOS, or Linux |
| **git** | Optional. Enables per-turn checkpoints and `/undo`; Nova runs without it, minus undo. |
| **ffmpeg** | Optional. Only needed for direct microphone recording with `/voice`. Existing audio files transcribe without it. |

If `node --version` prints anything below 22.5, install a current Node first (nvm, fnm, Volta, or your platform's installer) — npm will refuse the install on an older engine.

## Install

Pick whichever package manager you already use. All four install the same global `nova` command.

```bash
npm  install -g @circuit-nova/nova-cli
pnpm add    -g @circuit-nova/nova-cli
yarn global add @circuit-nova/nova-cli
bun  add    -g @circuit-nova/nova-cli
```

Verify:

```bash
nova --version
```

If the shell reports `nova: command not found`, your package manager's global bin directory isn't on `PATH`. Print it with `npm prefix -g` (append `/bin` on macOS/Linux) or `pnpm bin -g` / `bun pm bin -g`, and add that directory to `PATH` in your shell profile.

### Run without installing

To try it once, or to pin a version inside CI:

```bash
npx  @circuit-nova/nova-cli@1.1.0 --version
bunx @circuit-nova/nova-cli --providers
```

### Native index packages

The install also pulls a platform-matched **optional** dependency (`@circuit-nova/state-*`) that provides the native SQLite + FTS5 history index. These are declared `optionalDependencies`, so an unsupported platform or a blocked download does **not** fail the install — Nova falls back to a verified session-JSON search path instead. Check which path is active with:

```bash
nova history status
```

Supported targets are GNU and musl Linux on x64/arm64, Intel and Apple Silicon macOS, and x64/arm64 Windows. For development or an unusual packager, point `NOVA_STATE_BINARY` at a compiled binary directly.

## Configure a model provider

Nova needs exactly one model provider before it can do work. The interactive route is:

```bash
nova settings
```

The menu is navigable with arrow keys and Enter; every row is also numbered, so a typed number works too (this is the screen-reader-friendly path). Secrets are masked, and the config file is written to your platform's native per-user config directory with user-only permissions where the OS supports POSIX modes.

The environment route — environment variables always override saved settings, which keeps CI predictable:

```bash
export ANTHROPIC_API_KEY=...     # or OPENAI_API_KEY, or CIRCUITNOTION_API_KEY
nova --providers                 # shows exactly what is set and what is missing
```

Optional extras:

| Variable | Enables |
|---|---|
| `E2B_API_KEY` | `--sandbox` remote sandboxes |
| `EXA_API_KEY` | the bounded `web_search` tool |
| `MODEL_INPUT_PER_MILLION` / `MODEL_OUTPUT_PER_MILLION` | cost accounting for non-Anthropic models (Anthropic rates ship priced; an unpriced model reports `cost unknown` rather than inventing a number) |
| `NOVA_COUNTRY` / `NOVA_CURRENCY` | local-currency reporting |

## First run

```bash
cd your-project
nova                                  # interactive session
nova "fix the failing test in src/parser.ts"   # one request, then exit
nova --plan "how does auth work here?"         # read-only: write tools are never loaded
```

## Verifying the install

```bash
nova --version        # installed version
nova --providers      # provider keys detected
nova --doctor         # probes every endpoint Nova needs, names the one that fails
nova history status   # native index vs. portable fallback
```

`nova --doctor` is the one to reach for behind a corporate proxy or a country-level firewall — it tests each endpoint separately instead of failing as one opaque network error.

## Updating

Nova updates its own global installation through npm, pnpm, Yarn, or Bun. It checks the public registry, pins the exact version it found, and asks before invoking the package manager:

```bash
nova update                        # check, confirm, install
nova update --check                # check only, change nothing
nova update --yes                  # explicitly unattended
nova update --package-manager pnpm # override the detected manager
```

Without `--yes`, Nova refuses to mutate an installation when no interactive terminal is attached. Set `NOVA_UPDATE_PACKAGE_MANAGER` for a persistent override.

## Uninstalling

```bash
npm  uninstall -g @circuit-nova/nova-cli
pnpm remove    -g @circuit-nova/nova-cli
yarn global remove @circuit-nova/nova-cli
bun  remove    -g @circuit-nova/nova-cli
```

Per-project state lives in `.nova/` inside each repository (memory, skills, hooks, plugins, MCP config) and personal settings live beside your Nova config directory. Neither is removed by uninstalling the package — delete them by hand if you want a clean slate.

## Troubleshooting

**`EACCES` on a global npm install (macOS/Linux).** Don't `sudo`. Repoint npm's global prefix at a directory you own: `npm config set prefix ~/.npm-global`, then add `~/.npm-global/bin` to `PATH`.

**Unsupported engine.** Node is below 22.5. Upgrade Node rather than forcing the install — the CLI targets modern Node APIs.

**Native package failed to download.** Harmless. The install completes and Nova uses the portable fallback; confirm with `nova history status`.

**Nothing works and the error is a network one.** Run `nova --doctor`. It names the specific endpoint — registry, provider, FX rate host — that is unreachable.

## Building from source

From a clone of the repository, the CLI builds out of `packages/nova-cli`:

```bash
bun install
cd packages/nova-cli && bun run build   # emits dist/nova.mjs
```

The same build script runs on `prepublishOnly`. Note the release ordering: native `@circuit-nova/state-*` packages must be published and verified **first**, then their synchronized versions are added to the CLI's optional dependencies and the CLI is published. Keeping the two phases separate prevents a CLI version from referring to native packages that aren't in the registry yet.

---

MIT licensed. Source: [`packages/nova-cli`](https://github.com/chrisnkuno/circuit-agent/tree/main/packages/nova-cli) · Issues: [circuit-agent/issues](https://github.com/chrisnkuno/circuit-agent/issues)
