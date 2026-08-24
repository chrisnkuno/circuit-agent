# Implementation status

What is built, and what "built" currently means for each piece. This is a status record, not a
feature pitch: an entry appears here when the code exists, and the Activation status section below
says plainly which parts have been exercised against real providers and which have not.

For per-capability evidence — implemented versus *verified*, with the trace that proves it — see
[gap-register.md](gap-register.md). For what is not built yet, see
[product-backlog.md](product-backlog.md).

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
- A real, non-simulated agent terminal at `/terminal`: `run coding <objective>` creates an actual authenticated task and run in Convex, dispatches a real model and a real E2B sandbox, and streams the real `agentRunEvents` ledger live. See [the activation guide](../guides/activation.md#agent-terminal-activation) — it is off by default.
- An animated ASCII stage-track in the terminal, driven by nothing but the real `agentSteps` documents — it never shows progress that didn't happen.
- Multi-interface task supervision: a task launched from the web terminal, from Telegram, or on a recurring schedule all share one orchestration path (`apps/web/convex/codingRunPlan.ts`), authorized either by a real session or an already-verified organization identity. Telegram pairing uses the same short-lived, hashed, single-use code pattern as the GitHub App and Google OAuth flows. Recurring "coding-task" schedules reuse the existing schedule infrastructure on an isolated claim path that can't regress the deployed calendar digest.
- Task history and resume: the terminal shows every past task in status folders (active / completed / needs attention) via live Convex reactivity, and picking one reattaches to its real live status — pick up a run from any device, any session, at any point.
- Parallel task branches: starting a new `run coding <objective>` opens its own independently tracked branch instead of replacing the one in flight, so multiple real runs can execute at once; a tab strip switches between them, and each keeps updating live in the background regardless of which tab is active.
- Modular panel layout: the console, task history, and schedule/Telegram panel are three CSS Grid slots with three fixed named arrangements (Stacked / Split / Focus — the last widens the console column by the golden ratio, 1.618:1). The choice persists per browser via localStorage.
- Dynamic, context-aware presets: the terminal's one-click buttons are generated by a real CircuitNotion call (`gpt-5.6-luna`, chosen for cost-sensitive high-volume work) based on repo-connection state and recent task history, cached per organization and only regenerated when that context actually changes — not billed, and not on every page load. Falls back to the static preset set if the model isn't configured or the call fails.
- Context-aware presets: the terminal's one-click buttons only offer repository-dependent objectives (write a missing test, fix a failing check) once a GitHub repository is actually connected; otherwise they offer objectives that make sense against an empty workspace.
- Deployed at [circuit-nova.vercel.app](https://circuit-nova.vercel.app), gated by a free whole-site password (Vercel's own Password Protection needs a paid add-on this team doesn't have — see `apps/web/middleware.ts`).

## Activation status

The full production coding-dispatch path has completed live, end-to-end runs against real providers, including through the deployed Convex action rather than only from a developer machine. `CodingAgentWorker` with `CircuitNotionCodingModelProvider` and a real E2B sandbox completed a plan-write-verify cycle, and the newer `IterativeCodingAgentWorker` with `CircuitNotionAgentTurnProvider` completed a 5-turn, 5-tool-call loop that wrote a source file and a passing test. The Convex dispatcher now runs on a one-minute cron, so a queued coding run executes automatically rather than requiring a manual trigger. Dispatching through the deployed `/terminal` UI (real sign-up, real task, real budget authorization, real worker claim) first surfaced that CircuitNotion's Cloudflare protection blocks the call when it originates from Convex Cloud's shared outbound IP instead of a developer machine — the step failed closed with 0 RWF spent rather than a false success. Deploying `services/circuitnotion-relay` and pointing `CIRCUITNOTION_BASE_URL`/`CIRCUITNOTION_RELAY_SECRET` at it resolved this: a subsequent live `/terminal` run completed all four real coding steps end to end for 33 RWF, with the cron alone carrying the run from the second step onward. See the Model gateway row in [docs/planning/gap-register.md](gap-register.md) for the full trace. The Google Calendar control plane, vault, webhook, and schedule worker are deployed to the Convex development environment. Final user-consent verification remains blocked until a Google Cloud OAuth web client ID and secret are configured; every other catalogue connector remains inactive. GitHub repository provisioning is built and unit-tested but has no registered App yet. Production readiness still requires migrating the dispatcher to the iterative worker, real payment authorization, durable repository cloning into the E2B workspace, and provider-specific research/writing workers.
