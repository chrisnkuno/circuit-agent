# Circuit Nova codebase maintenance map

Status: current-tree audit on 2026-08-24. Scores are **maintenance priority**, where 10 means
"address first" and 1 means "stable enough to leave alone." They are not product-quality scores.

## Executive decision

Circuit Nova is a monorepo containing four products, not one application:

1. the published `nova` terminal product;
2. the Tauri desktop product;
3. the hosted Next.js + Convex control-plane product;
4. the CircuitNotion Cloudflare relay service.

They should share execution contracts and provider adapters, but not entrypoints, presentation code,
or release lifecycles. The desired dependency direction is one-way:

```text
apps/control-plane-web       apps/nova-desktop       packages/nova-cli
          |                         |                       |
          +-------------------------+-----------------------+
                                    |
                            packages/nova-engine
                                    |
              +---------------------+--------------------+
              |                     |                    |
      packages/agent-runtime  packages/providers  packages/nova-state
                                                    | history index
                                                    + security brain (separate DB/corpus)

services/circuitnotion-relay (independently deployed provider infrastructure)
tooling/reliability          (tests and release evidence, never runtime code)
```

An application may depend downward in this diagram. Shared packages must never import an app.
The CLI and desktop may share `nova-engine`; neither may import the other's UI, test fixtures, or
release scripts.

## Current products and ownership

| Priority | Current area | Product responsibility | Current problem | Target boundary |
|---:|---|---|---|---|
| 10/10 | `packages/nova-cli/src/nova.ts` | CLI bootstrap, preflight, commands, session loop, rendering | One 4,700-line entrypoint owns unrelated policies and UI flows; almost every CLI change collides here | `packages/nova-cli/src/{bootstrap,commands,preflight,session,ui}` with a thin `main.ts` composition root |
| 9/10 | `packages/agent-core/src/nova-cli` | Session engine, tools, policy, persistence, jobs, ACP, local integrations | Shared engine code is named and organized as CLI code, although desktop and ACP consume it | Move interface-neutral code to `packages/nova-engine`; keep only true terminal concerns in `nova-cli` |
| 9/10 | `packages/agent-core/src/agent-runtime.ts` | Provider-neutral bounded model/tool loop | Correct central authority, but model retries, tool-turn repair, accounting, verification, and result-context policy live in one 850-line unit | Split internal modules under `packages/agent-runtime/src/`; retain one public `BoundedAgentRuntime` facade |
| 8/10 | root `app`, `components`, `lib`, `convex` | Hosted task/control-plane web product | A second agent system and its domain code live at repository root, making "core" ambiguous and coupling root scripts to one product | Move together to `apps/control-plane-web`; keep its Convex deployment and domain `lib` private to that app |
| 8/10 | session journal + snapshot flow | Canonical CLI/desktop recovery state | A task can perform workspace effects and then surface a persistence error while saving its final status/session | Give persistence an explicit degraded result and recovery journal; never relabel already-executed effects as if no work occurred |
| 7/10 | `apps/nova-desktop` | Tauri UI and Nova sidecar host | Product is correctly separated physically, but the sidecar assembles runtime concerns and its tests reach into CLI PTY fixtures | Depend on public `nova-engine` test helpers; remove `../../../../packages/nova-cli/src/pty/*` imports |
| 7/10 | `packages/agent-core/src/providers` | CircuitNotion, OpenAI, Anthropic, E2B, Docker, Exa | Provider and sandbox adapters share a package with Nova session policy; optional SDK loading and retry policy are hard to own independently | Extract `packages/providers` and `packages/workspaces`, each with conformance suites |
| 6/10 | `scripts`, `reliability`, root release config | Builds, packaging, scheduled evidence | Product builds and generated reliability-site publication are mixed in one flat script directory | Group as `tooling/{build,release,reliability}` and expose root scripts only as stable aliases |
| 6/10 | `packages/nova-state` | Read-only native history index plus separately stored Defensive Brain | Native runtime boundary is good, but two read models now share one protocol/release package and must not share schemas or authority | Keep one sidecar for distribution efficiency; compartmentalize `history` and `brain` modules, databases, benchmarks, and canonical sources |
| 4/10 | `cloudflare/circuitnotion-relay` | Independently deployed model relay | Correctly isolated, but `cloudflare/` describes a vendor rather than the service role | Move to `services/circuitnotion-relay`; keep its own tests and deployment config |
| 3/10 | `reliability/site` | Published evidence viewer | Generated run fixtures and maintained site source occupy the same tree | Keep source in `tooling/reliability/site`; generate run artifacts into an ignored output directory |

## Main execution-engine stop map

The runtime should recover only before effects or through explicit model-visible tool errors. Safety
decisions must stay terminal.

| Stop or failure point | Current behavior | Policy |
|---|---|---|
| Transient provider timeout, network reset, 408/409/425/429, selected 5xx | Retry the identical model request up to two times before any returned tool call can execute | Recover automatically; bounded exponential backoff |
| 400/401/403/404/422 and other explicit permanent HTTP failures | Surface immediately | Do not retry a bad endpoint, credential, or request |
| Too many tool calls in one model turn | Reject the batch, explain the exact limit to the model, allow two corrected turns | Recover automatically; execute none of the rejected batch |
| Empty, duplicate-id, missing-id, or non-object-argument tool turn | Reject before approval or execution and allow two corrected turns | Recover automatically without creating invalid provider history |
| Individual tool throws or returns an error | Return an `isError` tool result to the model | Model may retry or choose another approach; counts against bounded budgets |
| Unavailable/out-of-scope tool | One model-visible correction, then fail closed | Preserve capability boundary |
| User denies an operation or model refuses | `blocked` | Intentional terminal state |
| Approval is pending | `needs_approval` or an interactive wait | Intentional pause; daemon clients need an approval timeout/reattach policy |
| User cancellation | `cancelled` at the next safe checkpoint | Intentional terminal state; provider/tool-specific abort signals are future work |
| Model, tool-call, output, context, or approved-money budget exhausted | `iteration_limit` | Intentional bounded stop; UI should offer a continuation with a newly approved budget |
| Workspace changed without passing verification | One correction, then `needs_verification` | Intentional integrity gate |
| Journal/session persistence fails after effects | Exception can obscure the runtime result | Priority fix: return `completed_with_persistence_warning`-style metadata or durable recovery instructions |
| Compaction provider fails before the main runtime | Entire turn fails | Apply the same transient provider retry utility or skip only when the un-compacted prompt still fits |

## CLI engine compartment plan

The extraction should preserve behavior at every step. Do not rewrite the CLI and move it at the
same time.

```text
packages/nova-cli/src/
  main.ts                    argv -> composition root -> exit code
  bootstrap/
    config.ts                env and saved settings resolution
    providers.ts             provider selection and model catalog wiring
    workspace.ts             local, Docker, E2B startup
  preflight/
    affordability.ts         estimate, balance, and approved cap
    safety.ts                task-level sensitive-operation confirmation
  commands/
    registry.ts              slash/subcommand metadata and dispatch
    session.ts               mode, model, resume, undo, detach
    billing.ts               pay, balance, cost
    workspace.ts             files, diff, pull, tools
  session/
    interactive.ts           prompt loop only
    headless.ts              one-shot protocol and exit mapping
  ui/
    terminal/                readline, PTY-safe layout, Markdown, screen host
    renderers/               events, tables, charts, errors
```

```text
packages/nova-engine/src/
  session/                   NovaAgent orchestration, compaction, checkpoints
  execution/                 tool registry, delegation, artifacts
  policy/                    capabilities, approvals, safety
  persistence/               journal, snapshots, projection, memory
  jobs/                      daemon, detached work, worker protocol
  integrations/             skills, plugins, MCP, hooks
```

`nova-engine` must have no ANSI, readline, TermUI, React, Tauri, or process-exit imports. The CLI and
desktop should receive the same typed engine events and render them independently.

## Unused and generated-area findings

### Confirmed generated or disposable directories

These are ignored build/runtime outputs, not source. They can be removed by a future
`bun run clean` command without changing product behavior:

- `.next`, `.convex`, `.vercel`, `coverage`, `dist`, `test-results`, `tmp`;
- package-local `node_modules` and `dist` folders;
- `apps/nova-desktop/{dist,sidecar/dist,src-tauri/target,src-tauri/binaries}`;
- `packages/nova-state/target` and root/package `*.tsbuildinfo` files;
- `bench` currently contains only ignored local benchmark output.

Do not put product source or durable evidence in any of these directories.

### Confirmed tracked orphans

Repository-wide reference searches find no consumer for these files:

- `probe.mjs` — one-machine Playwright probe with a hard-coded Windows Chromium path;
- `probe-sidecar.mjs` — one-off sidecar probe with a hard-coded user credential-file path;
- `mobile-check.mjs` — one-off mobile page probe superseded by Playwright coverage;
- `components/download-work-button.tsx` — exported but not imported;
- `components/side-panel.tsx` — exported but not imported; desktop has unrelated CSS with the same class name.

Delete the three probes after preserving any still-useful interaction as a real test. Decide whether
the two components belong on a planned screen within one release; otherwise delete them and their
now-private support code only after checking whether that support code has another caller.

### Intentionally non-runtime directories

- `public/downloads` contains documentation only; installers now come from GitHub Releases. Move
  that note into the desktop release README and remove the empty placeholder directory.
- `.agents` and `.codex` are currently empty local convention directories. Keep them only if a
  checked-in instruction or tool configuration is added.
- `reliability/site/runs/latest` is published evidence, not application source. It is used by the
  reliability site, but should be generated during publication rather than reviewed as hand code.

No whole tracked product folder is currently safe to delete. `cloudflare/circuitnotion-relay`,
`packages/nova-state`, the root web/Convex tree, desktop, CLI, and agent core all have live imports,
build scripts, deployment documentation, or release workflows.

## Ordered cleanup program

### P0 — reliability without moves

1. Keep the bounded provider and malformed-tool-turn recovery tests green.
2. Make final session persistence failures distinguishable from execution failures.
3. Add daemon approval timeout/disconnect recovery and provider-call abort support.
4. Add a root `clean` script with an explicit allowlist of generated paths.
5. Delete or convert the confirmed probe/orphan files.

Exit gate: focused runtime, CLI PTY, desktop sidecar, typecheck, build, and relevant E2E suites pass.

### P1 — establish real package boundaries

1. Create `packages/agent-runtime` from the provider-neutral loop and cost interfaces.
2. Create `packages/nova-engine` from interface-neutral files currently under `agent-core/src/nova-cli`.
3. Make `nova-cli` and desktop sidecar consume only public package exports.
4. Add dependency-boundary checks that reject app imports from shared packages and private-source
   imports between products.

Exit gate: no behavior change, package builds are independently runnable, and circular imports are zero.

### P2 — split product composition roots

1. Decompose `nova.ts` by the CLI plan above until `main.ts` only wires dependencies and exit codes.
2. Split desktop `screens/Chat.tsx` into session controller, event projection, composer, and panels.
3. Move root web/Convex code into `apps/control-plane-web` as one deployment unit.
4. Move the relay under `services` and reliability/build systems under `tooling`.

Exit gate: each product has an owner README containing dev, test, build, release, deploy, and rollback commands.

### P3 — consolidate duplicate concepts

Audit the root web agent worker against `nova-engine` before sharing code. Share only contracts that
have the same authority and lifecycle. In particular, do not merge Convex durable orchestration with
the local CLI session merely because both use words such as "task", "run", or "approval".

Candidates for deliberate consolidation are provider request/usage types, capability identifiers,
cost arithmetic, verification evidence, and sandbox conformance. Product-specific authentication,
billing authorization, persistence, and UI state should remain separate.

## Maintenance rules after reorganization

- Every product and package owns a README with purpose, public API, commands, and deployment status.
- Every folder has one authority; generated state never sits beside hand-maintained source.
- Shared packages export public entrypoints; cross-product relative imports are forbidden.
- Runtime retry code may wrap only pre-effect operations or operations with explicit idempotency keys.
- All terminal statuses have one documented exit code, resume path, and user-facing explanation.
- Package-level tests cover invariants; CLI PTY and desktop interaction tests cover real interfaces;
  E2E tests cover assembled products.
- Refactors move one boundary at a time and preserve a green conformance suite before deleting the
  old path.
