# Documentation

Four kinds of document, kept apart because they age differently. Architecture describes what is
true; guides describe what to do; reference is looked up rather than read; planning goes stale on
purpose and is dated so you can tell.

## Architecture — how it works and why

| Document | What it answers |
| --- | --- |
| [architecture/nova-system.md](architecture/nova-system.md) | The whole system: every surface, the shared core beneath them, the boundaries and what they do *not* protect. Start here. |
| [architecture/hosted-platform.md](architecture/hosted-platform.md) | The hosted control plane's contracts: boundaries, run lifecycle, the pricing invariant, provider activation gates. |
| [architecture/agentic-coding-deep-dive.md](architecture/agentic-coding-deep-dive.md) | The coding agent in depth — the bounded loop, tool-turn repair, verification, result context. |
| [architecture/hermes-hybrid.md](architecture/hermes-hybrid.md) | The capability-registry merge strategy and the phased Hermes integration. |

## Guides — how to do a thing

| Document | What it answers |
| --- | --- |
| [guides/install-nova-cli.md](guides/install-nova-cli.md) | Installing and running the `nova` CLI. |
| [guides/activation.md](guides/activation.md) | Turning on the relay, the live terminal, Google Calendar and the GitHub App on a deployment. |
| [guides/defender-brain-pipeline.md](guides/defender-brain-pipeline.md) | How the signed Defensive Brain feed is researched, reviewed, signed and distributed. |

Contributing itself is [../CONTRIBUTING.md](../CONTRIBUTING.md), at the root where people look for it.

## Reference — looked up, not read

| Document | What it answers |
| --- | --- |
| [reference/optimization-map.md](reference/optimization-map.md) | Every performance target with its probe and budget. Run `bun run optimize:map` before optimizing anything. |
| [reference/codebase-maintenance-map.md](reference/codebase-maintenance-map.md) | A ranked audit of where this codebase is hardest to maintain, and the prescribed fix for each. |
| [reference/terminal-design-system.md](reference/terminal-design-system.md) | The TUI's design system — layout, colour, motion, and the rules the CLI's rendering obeys. |

## Planning — dated, and expected to go stale

| Document | What it answers |
| --- | --- |
| [planning/gap-register.md](planning/gap-register.md) | Implemented versus **verified**, per capability, each row carrying the evidence. The honest picture. |
| [planning/implementation-status.md](planning/implementation-status.md) | What is built, and what "built" currently means for each piece. |
| [planning/product-backlog.md](planning/product-backlog.md) | What is not built yet, for the task list and cross-component connectivity. |
| [planning/assessment-technical.md](planning/assessment-technical.md) | A technical assessment of the system as it stands. |
| [planning/assessment-roadmap.md](planning/assessment-roadmap.md) | The direction and the staged delivery plan. |

## Documents that live elsewhere

- Each package documents itself: [`packages/agent-core`](../packages/agent-core/README.md),
  [`packages/nova-cli`](../packages/nova-cli/README.md),
  [`packages/nova-state`](../packages/nova-state/README.md) — the last with its own
  [`INVARIANTS.md`](../packages/nova-state/INVARIANTS.md), which is the contract its Rust tests
  enforce.
- The desktop app's architecture and backlog moved with it to
  [chrisnkuno/nova-desktop](https://github.com/chrisnkuno/nova-desktop).

## Writing one

Put a new document in the section that matches how it will be *used*, not what it is about. If it
tells someone how to do something, it is a guide even when it is mostly architecture. Date anything
in `planning/` — an undated status document is indistinguishable from a wrong one.
