# Circuit-Nova

An early foundation for a task-priced, multi-interface AI agent system.

Users should know a task's expected RWF cost and maximum approved spend before an agent executes it. Convex persists the durable work state; E2B is the intended isolated execution layer; Circuit Pay is the intended billing adapter.

The web workspace can automatically infer a coarse country from deployment metadata or browser locale, and users can override both country and display currency. Quotes and spend are converted with a dated daily rate for presentation; the authoritative cap, reservation, settlement, and audit ledger remain integer RWF amounts. Approval prompts show that RWF ledger amount alongside any conversion.

## Current implementation

- Responsive task quote interface with RWF estimate, confidence, assumptions, and hard cap.
- Hermes-inspired narrow capability registry with core, skill, and connector layers.
- Distinct capability-scoped workflows for coding, research, writing, and operations.
- Typed token-based task-cost estimator with input/output forecasts, uncertainty ranges, infrastructure allowances, and tests.
- Convex schema for tasks, quotes, payment holds, and immutable task events.
- Idempotent `createQuotedTask` mutation, ready to be called after client authentication is wired.
- Explicit provider contracts for Circuit Pay and E2B.
- Dependency-graph validation, fair multi-run scheduling, failure propagation, and cancellation states.
- Integer-RWF task budget enforcement with reservation and settlement tests.
- Durable worker leases, approval requests, evidence references, and idempotent usage records in the Convex model.
- Organization-scoped roles and backend authorization boundaries.
- Step-scoped RWF reservations with expired-lease release and retry policy.
- Auditable dispatcher planning that combines graph validity, fair global scheduling, provider readiness, approvals, and budgets.
- Concrete E2B adapter with secure access, approved-template gating, bounded runtime, command allowlisting, opt-in internet, and sandbox termination.
- OpenAI Responses API coding planner with code-versioned prompts, Structured Outputs, explicit model selection, non-stored responses, and complete token accounting.
- Provider-neutral bounded agent loop with iterative tool calls, cumulative RWF accounting, cancellation, approval pauses, context limits, and incremental events.
- CircuitNotion native Chat Completions tool adapter, verified live with `gpt-5.6-luna`.
- Interactive E2B coding tools for confined reads, searches, writes, commands, and classified verification evidence.
- Delegated child-run policy that can only reduce parent capabilities, budget, depth, and iteration authority.
- Daily-life connector catalogue for Calendar, Gmail, Drive, Notion, Todoist, Slack, WhatsApp Business, and Home Assistant.
- Multi-app workflow compiler with dependency-aware parallel reads and explicit approval states for every external write.
- Durable Convex connection metadata, action intents, schedules, idempotency keys, and connector audit events; credential values remain in an external vault.
- Deployed Google Calendar vertical slice with state + PKCE OAuth, AES-256-GCM credential vault, offline token refresh/revocation, bounded event reads, approval-gated idempotent event creation, verified push channels, and leased calendar-digest schedules.
- Conservative token-to-RWF model reservation plus reconciliation from actual provider usage.
- Bounded coding worker that writes scoped files, runs checks, observes cancellation checkpoints, captures content-addressed evidence, and terminates E2B in every exit path.
- Convex heartbeat, sandbox identity, artifact metadata, approval records, and lifecycle transitions ready for deployment validation.
- Minute-based expired-lease recovery and coding-dispatch crons, deployed and running on the Convex development environment.
- Secret-safe provider readiness diagnostics at `/api/health`.
- Desktop and mobile-viewport Playwright coverage for the current operational interface.
- GitHub App repository provisioning: JWT app authentication, short-lived installation tokens, authoritative installation lookup (never trusting a browser redirect), fork/branch trust classification, namespaced patch branches, idempotent approval-gated PR creation, a state-bound install callback, and a signature-verified installation webhook.
- A GitHub Actions workflow runs the test, typecheck, and build gates on every push and pull request.
- Procedural-memory skills: evidence-gated distillation of a completed run into a versioned, slugged skill, relevance-and-budget recall, approval-gated Convex storage that can only ever add a new version, and advisory-only prompt composition the iterative worker already applies when skills are supplied.
- A second, interchangeable sandbox backend (`DockerSandboxProvider`) behind the same `InteractiveCodingSandboxProvider` contract E2B implements, talking to the Docker CLI as argv-only subprocess calls under the identical command and file policy, selected by an explicit factory function that defaults to E2B.
- A real, non-simulated agent terminal at `/terminal`: `run coding <objective>` creates an actual authenticated task and run in Convex, dispatches a real model and a real E2B sandbox, and streams the real `agentRunEvents` ledger live. See [Agent terminal activation](#agent-terminal-activation) below — it is off by default.
- An animated ASCII stage-track in the terminal, driven by nothing but the real `agentSteps` documents — it never shows progress that didn't happen.
- Multi-interface task supervision: a task launched from the web terminal, from Telegram, or on a recurring schedule all share one orchestration path (`convex/codingRunPlan.ts`), authorized either by a real session or an already-verified organization identity. Telegram pairing uses the same short-lived, hashed, single-use code pattern as the GitHub App and Google OAuth flows. Recurring "coding-task" schedules reuse the existing schedule infrastructure on an isolated claim path that can't regress the deployed calendar digest.
- Task history and resume: the terminal shows every past task in status folders (active / completed / needs attention) via live Convex reactivity, and picking one reattaches to its real live status — pick up a run from any device, any session, at any point.
- Parallel task branches: starting a new `run coding <objective>` opens its own independently tracked branch instead of replacing the one in flight, so multiple real runs can execute at once; a tab strip switches between them, and each keeps updating live in the background regardless of which tab is active.
- Modular panel layout: the console, task history, and schedule/Telegram panel are three CSS Grid slots with three fixed named arrangements (Stacked / Split / Focus — the last widens the console column by the golden ratio, 1.618:1). The choice persists per browser via localStorage.
- Dynamic, context-aware presets: the terminal's one-click buttons are generated by a real CircuitNotion call (`gpt-5.6-luna`, chosen for cost-sensitive high-volume work) based on repo-connection state and recent task history, cached per organization and only regenerated when that context actually changes — not billed, and not on every page load. Falls back to the static preset set if the model isn't configured or the call fails.
- Context-aware presets: the terminal's one-click buttons only offer repository-dependent objectives (write a missing test, fix a failing check) once a GitHub repository is actually connected; otherwise they offer objectives that make sense against an empty workspace.
- Deployed at [circuit-nova.vercel.app](https://circuit-nova.vercel.app), gated by a free whole-site password (Vercel's own Password Protection needs a paid add-on this team doesn't have — see `middleware.ts`).

## Activation status

The full production coding-dispatch path has completed live, end-to-end runs against real providers, including through the deployed Convex action rather than only from a developer machine. `CodingAgentWorker` with `CircuitNotionCodingModelProvider` and a real E2B sandbox completed a plan-write-verify cycle, and the newer `IterativeCodingAgentWorker` with `CircuitNotionAgentTurnProvider` completed a 5-turn, 5-tool-call loop that wrote a source file and a passing test. The Convex dispatcher now runs on a one-minute cron, so a queued coding run executes automatically rather than requiring a manual trigger. Dispatching through the deployed `/terminal` UI (real sign-up, real task, real budget authorization, real worker claim) first surfaced that CircuitNotion's Cloudflare protection blocks the call when it originates from Convex Cloud's shared outbound IP instead of a developer machine — the step failed closed with 0 RWF spent rather than a false success. Deploying `cloudflare/circuitnotion-relay` and pointing `CIRCUITNOTION_BASE_URL`/`CIRCUITNOTION_RELAY_SECRET` at it resolved this: a subsequent live `/terminal` run completed all four real coding steps end to end for 33 RWF, with the cron alone carrying the run from the second step onward. See the Model gateway row in [docs/gap-register.md](docs/gap-register.md) for the full trace. The Google Calendar control plane, vault, webhook, and schedule worker are deployed to the Convex development environment. Final user-consent verification remains blocked until a Google Cloud OAuth web client ID and secret are configured; every other catalogue connector remains inactive. GitHub repository provisioning is built and unit-tested but has no registered App yet. Production readiness still requires migrating the dispatcher to the iterative worker, real payment authorization, durable repository cloning into the E2B workspace, and provider-specific research/writing workers.

## CircuitNotion relay (Cloudflare Worker)

CircuitNotion's Cloudflare protection blocks Convex Cloud's shared outbound IP range, so a live coding run dispatched through the deployed Convex action used to fail even though the identical call succeeds from a developer machine (see the Model gateway row in [docs/gap-register.md](docs/gap-register.md)). [cloudflare/circuitnotion-relay](cloudflare/circuitnotion-relay) is a small reverse-proxy Worker, deployed and wired in this environment, that gives the call a different egress path and resolves it; see its own README for deploy steps and how to point `CIRCUITNOTION_BASE_URL`/`CIRCUITNOTION_RELAY_SECRET` at it in another deployment.

## Agent terminal activation

`/terminal` is a real execution surface, not a demo, gated behind two deployment-only environment variables that both default to unset/disabled:

```bash
bunx convex env set ALLOW_TERMINAL_LIVE_EXECUTION true
bunx convex env set ALLOW_DEV_PAYMENT_BYPASS true
```

`ALLOW_DEV_PAYMENT_BYPASS` lets an authenticated organization owner authorize their own task's payment hold without a real Circuit Pay transaction (`convex/devPayment.ts`) — this is how the terminal exercises the real dispatcher before Circuit Pay is verified. **Never enable either flag on a deployment reachable by anyone other than trusted developers**: an owner who enables them can authorize a task's cap without a real payment. `run coding <objective>` only executes the plan's `coding`-role steps (inspect, reproduce, implement, checks); the approval-gated review step is intentionally left out of the terminal's live plan because no reviewer-role worker exists yet.

## Google Calendar activation

Create a Google OAuth **Web application** client, enable the Calendar API, and register the exact callback shown by `GOOGLE_OAUTH_REDIRECT_URI`. Then set the two remaining server-only values on the Convex deployment:

```bash
bunx convex env set GOOGLE_OAUTH_CLIENT_ID
bunx convex env set GOOGLE_OAUTH_CLIENT_SECRET
bunx convex dev --once
```

The connector requests only `calendar.events.owned`, offline access, state, and PKCE. The client secret and vault key are Convex environment variables; OAuth and action payloads are encrypted before database insertion and never sent to the browser.

## GitHub App activation

Create a GitHub App with a **Setup URL** of `NEXT_PUBLIC_SITE_URL` + `/api/connectors/github/callback` and a **Webhook URL** of the Convex site URL + `/github/webhook`, subscribed to the `installation` and `installation_repositories` events. Then set the server-only values on the Convex deployment:

```bash
bunx convex env set GITHUB_APP_ID
bunx convex env set GITHUB_APP_SLUG
bunx convex env set GITHUB_APP_PRIVATE_KEY
bunx convex env set GITHUB_WEBHOOK_SECRET
bunx convex dev --once
```

Installation identity is never trusted from the browser redirect: the callback only carries a state-bound installation ID, which the server re-resolves against GitHub using the App's own JWT before recording anything. The App private key never leaves Convex environment state, and every repository action mints a fresh, short-lived installation token rather than persisting one.

## Development

```bash
bun install
bun run dev
bun test
bun run typecheck
bun run build
bun run test:e2e
```

A Convex development deployment is configured and its generated bindings (`convex/_generated`) are committed, so `bun run typecheck` and `bun run build` work without any additional setup. After editing `convex/schema.ts` or any `convex/*.ts` function, regenerate bindings against your own deployment before typechecking:

```bash
bunx convex dev --once
```

CI builds with placeholder `NEXT_PUBLIC_CONVEX_URL`/`NEXT_PUBLIC_CONVEX_SITE_URL` values, so the build gate never depends on a real deployment being reachable.

### Benchmarking the CLI

```bash
bun run build:packages          # the benchmark measures the built artifact, not the source
bun run bench                            # report medians against the committed baseline
bun run bench -- --baseline bench/baseline.json
bun run bench -- --save bench/baseline.json    # adopt current numbers as the new baseline
bun run bench -- --only startup          # one group, while iterating
```

It times what a person actually waits on: the floor under every invocation, help and provider resolution, a cold first run with an empty V8 compile cache, and a whole turn against a local model stub so the model's own latency is excluded.

Two properties keep it honest. It reports median and p95 rather than a mean, because one GC pause should not become the headline. And it refuses to call a difference an improvement when it is smaller than that run's own spread — a change inside the noise is reported as noise, so "faster" in the output means the machine agreed twice.

Numbers are only comparable within one machine. Commit a baseline when you have deliberately moved it, and re-measure on the same box you intend to compare against.

## System map

See [docs/architecture.md](docs/architecture.md) for boundaries, lifecycle, pricing invariant, and provider activation gates.

The multipurpose merge strategy and phased Hermes integration are documented in [docs/hermes-hybrid-architecture.md](docs/hermes-hybrid-architecture.md).

The current system is assessed in [docs/assessment-technical.md](docs/assessment-technical.md). The philosophical direction and staged delivery plan are in [docs/assessment-roadmap.md](docs/assessment-roadmap.md).

The actionable, evidence-based backlog is tracked in [docs/gap-register.md](docs/gap-register.md).

## Todo

Product backlog for the terminal task list and cross-component connectivity (not yet implemented):

- [x] **Stop on task list** — `TaskHistory` active tasks now carry a Stop control wired to `agentRuns.requestTaskCancellation`, which soft-cancels every non-terminal run of the task (workers stop at the next checkpoint) and withdraws any approval still pending against it, so a stopped task leaves nothing decidable behind. Browser-verified. Recurring schedules already have Pause/Activate; there is still no true in-flight run pause.
- [x] **Live sandbox state** — The task list now shows the running step, its progress, and the real `sandboxId` the worker reported on its last heartbeat, with the heartbeat age; a lapsed lease is shown as stalled rather than running. Read from the worker's own heartbeat rather than trusting run status. Still to do: an active probe (`Sandbox.getInfo` / `docker inspect`) to catch a sandbox that died without the lease lapsing.
- [x] **Resend email notifications** — Lifecycle mail is sent on run start and on every terminal outcome (completed / failed / cancelled) to each active member's recorded notification email, which is captured and kept current from the sign-in identity. Every message states what was spent against what was approved, including on failure and cancellation, since silence about cost reads as "this cost nothing". Config-gated on `RESEND_API_KEY`/`RESEND_FROM` and best-effort, so a mail outage can never fail the run that triggered it. Code-complete and unit-tested; **not yet live-verified** — needs a Resend key and a verified sender domain.
- [x] **Webhook-heavy connectivity** — Inbound: a signed `/e2b/webhook` endpoint receives [E2B sandbox lifecycle events](https://e2b.dev/docs/sandbox/lifecycle-events-webhooks), verified in constant time and de-duplicated on E2B's delivery id (it retries three times, ten seconds apart). Live-verified against the deployment: valid signatures accepted, unsigned/forged/tampered payloads rejected 401, retried deliveries applied once. Internal: run lifecycle is push-driven — a completed step, a granted approval, and an expired retry backoff each wake the dispatcher directly instead of waiting for its cron. Still open: outbound org-configurable webhooks, and pushing sandbox/Telegram/Resend status onto the same bus.

Notes on what is deliberately *not* done in the webhook path: a `sandbox.lifecycle.killed` event does not fail or retry its step. The worker stops its own sandbox before recording the step outcome, so every healthy step also emits a kill while its row still reads "running" — acting on that signal would re-run work that had just succeeded. The event is used to correct what the UI claims (a sandbox that is gone stops being shown as live); deciding a step's fate stays with the worker outcome and lease recovery, which can actually tell success from failure.
