# System gap register

This register is the implementation source of truth for what Circuit-Nova can do now, what remains simulated or inactive, and what evidence closes each gap. A feature is not marked complete because an interface, schema, or adapter exists; it closes only when the named verification evidence exists.

## Status definitions

| Status | Meaning |
|---|---|
| Implemented | Code exists and is covered by local automated verification |
| Integration-ready | A concrete adapter or durable model exists, but no real provider call has been verified |
| Blocked | Required configuration, credentials, provider contract, or product decision is absent |
| Not started | No meaningful implementation exists yet |

## P0 — required for a real coding-agent private beta

| System | Current state | Status | Next implementation | Closure evidence |
|---|---|---|---|---|
| Convex control plane | Schema, organization scoping, runs, steps, approvals, leases, usage, recovery cron, and internal dispatch snapshot exist | Integration-ready | Configure dev/preview/prod; generate bindings; add backend test harness and migrations | Generated Convex types pass CI; tenant, lifecycle, and recovery integration tests pass against a deployment |
| Authentication and tenancy | Role matrix and backend permission helpers exist | Blocked | Add auth provider, session bridge, organization bootstrap, invite/revoke flow | Authenticated negative tests prove cross-tenant reads and writes fail |
| Durable dispatcher | Pure planner and Convex Node action atomically claim fair, budgeted, approval-gated coding work and observe cancellation checkpoints; a one-minute cron now ticks it automatically, and the exact production path (`CodingAgentWorker` + live CircuitNotion + live E2B) completed one real run end to end | Integration-ready | Exercise concurrent claim, cancellation, and restart recovery against the live scheduled dispatcher | Kill-and-resume test reaches one truthful terminal state without duplicate usage |
| Model gateway | Typed OpenAI Responses and CircuitNotion Chat Completions adapters use explicit models, schema validation, timeouts, refusals, and usage capture; CircuitNotion `gpt-5.6-luna` completed live smoke plans **called from this machine**, but the identical call **from the deployed Convex Node action** was blocked with an HTML Cloudflare bot-challenge page (403) — CircuitNotion's WAF does not currently trust Convex Cloud's outbound IP range, even though the same API key and code path work outside it | Blocked (for the deployed path) | Ask CircuitNotion to allowlist Convex Cloud's egress IPs, or configure `OPENAI_API_KEY`/`CODING_MODEL_PROVIDER=openai` as a deployed-path fallback, then repeat the live dispatch test | A live coding step dispatched through the deployed cron (not a local script) reaches the provider and reconciles real usage |
| E2B execution | Secure adapter and tested worker write bounded files, run policy-approved commands, capture evidence, heartbeat, check cancellation, and force cleanup; a live isolated proof-file task completed and terminated | Integration-ready | Build the repository provisioner and repeat against a Git fixture | Live E2B test clones a fixture repo, changes it, runs checks, exports evidence, and terminates the sandbox |
| GitHub authorization | `RepositoryProvider` contract, a GitHub App adapter (JWT app auth, short-lived installation tokens, authoritative installation lookup, fork/branch trust classification, namespaced patch branches, idempotent approval-gated PR creation), Convex `githubInstallations` schema and functions, a state-bound install callback, and a signature-verified webhook route all exist and are unit-tested (24 tests) | Integration-ready | Register a GitHub App, configure `GITHUB_APP_ID`/`GITHUB_APP_SLUG`/`GITHUB_APP_PRIVATE_KEY`/`GITHUB_WEBHOOK_SECRET`, and connect the coding worker to clone an authorized repository into the E2B workspace | Revoked access fails closed; approved workflow creates one tested PR with no long-lived token in E2B |
| Budget enforcement | Quote, cap, reservation, settlement, overage approval, and replay guard exist | Implemented locally | Enforce shared invariants in deployed Convex tests and ingest real provider usage | Negative, replay, concurrent-claim, and reconciliation tests show zero unapproved overrun |
| Circuit Pay | Payment state and adapter contract exist | Blocked | Verify official API, auth/checkout or hold semantics, signed webhooks, refund/release, idempotency | Provider sandbox transactions and replayed webhooks reconcile exactly to the internal ledger |
| Artifacts and evidence | Worker creates content-addressed manifests; Convex models tenant-linked metadata and rejects unrecorded completion references | Integration-ready | Store artifact blobs in Convex Storage and add authenticated streaming/download plus retention | Every completed coding run has retrievable, tenant-scoped evidence or an explicit no-artifact reason |

## P1 — required before broader customer use

| System | Current state | Status | Next implementation | Closure evidence |
|---|---|---|---|---|
| Web operations workspace | Quote UI works on desktop/mobile viewports; a second surface (`/terminal`) now creates a real authenticated task+run through `startLiveCodingRun` and streams the real `agentRunEvents` ledger live via Convex reactivity — proven end to end (real auth, real budget, real dispatcher claim, real truthful failure recording) even though the specific provider call is currently blocked (see Model gateway). Behind two explicit deployment-only flags (`ALLOW_TERMINAL_LIVE_EXECUTION`, `ALLOW_DEV_PAYMENT_BYPASS`), since Circuit Pay is not real yet | Integration-ready | Build task detail/retry/cancel/artifact review in the main workspace; remove the dev payment bypass once Circuit Pay is verified | Two-device browser test observes one durable run and safely approves/cancels it |
| Native mobile | Responsive web only | Not started | Expo app with shared contracts, push, deep links, biometrics, voice/files, reconnect-safe mutations | Phone-only end-to-end task supervision succeeds after app termination and reconnect |
| Observability | Health endpoint reports configuration readiness | Integration-ready | Structured events, trace IDs, logs, metrics, alerts, SLOs, provider probes | Operator can trace a task across quote, payment, Convex, model, E2B, and artifact storage |
| Security hardening | Secure E2B defaults and authorization concepts exist | Integration-ready | Threat model, secret manager, network allowlists, prompt-injection defenses, scanning, audit export | P0 threats have automated controls and no unresolved critical findings |
| Evaluations | Domain unit and browser workflow tests exist | Integration-ready | Representative coding corpus, quality grader, destructive-action tests, fault injection | Release dashboard tracks success, evidence quality, cost error, cancellation, and recovery |
| Notification service | Approval states exist | Not started | Push/email/in-app delivery with dedupe, expiry, and deep links | Retries never duplicate an approval action; sensitive approval requires authenticated app context |
| Connector platform | Google Calendar OAuth, encrypted vault, token refresh/revocation, scoped reads, encrypted approval-gated event writes, verified push channels, and leased digest schedules are implemented and deployed to development; seven catalogue apps remain manifests only | Integration-ready | Configure a Google OAuth web client and complete user consent, read, approved write, watch, digest, and revoke proofs | Calendar consent, scoped read, approval-gated insert, webhook, schedule replay, expiry, revocation, and tenant-isolation tests all pass live |
| Multipurpose capability platform | Validated registry, four task graphs, persisted capability IDs, bounded tool loop, CircuitNotion tool adapter, interactive E2B coding tools, verification ledger state, and delegation policy exist; one isolated live coding loop passed | Integration-ready | Migrate the Convex dispatcher to the iterative worker, then add research, writing, and connector workers | Each task kind completes one live evidence-backed run through the same control plane |
| Procedural skills | Versioned, evidence-gated skill distillation (`lib/skills.ts`), relevance-and-budget recall, advisory-only prompt guidance, and Convex approval-gated storage (`convex/skills.ts`, new `skill:manage` permission) exist and are tested; the iterative worker composes any supplied skills into its system prompt | Integration-ready | Call `proposeFromRun` after a completed run and populate the iterative worker's `skills` field with `selectRelevantSkills`; both wait on the same dispatcher migration above | A recalled skill measurably shortens a repeat task's iteration count with the audit trail proving which skill version influenced the run |
| Sandbox backend portability | A second `InteractiveCodingSandboxProvider` implementation (`lib/providers/docker.ts`, argv-only Docker CLI calls, same command/file policy as E2B) exists behind an explicit `createCodingSandboxProvider` selector that defaults to E2B | Integration-ready | Point `convex/dispatcher.ts` at the selector instead of `createE2BProvider` directly, then run one live coding step against a local Docker image | A live run completes identically through both backends with matching evidence shape |

## P2 — required for platform scale

| System | Status | Exit condition |
|---|---|---|
| Calibrated RWF estimator | Integration-ready | Current token estimator and configured RWF catalog must be calibrated against live P50/P90 usage; FX and catalog versions must be attached to every quote |
| Organization policy and enterprise controls | Not started | SSO, retention, data region, audit export, and action policy are enforced centrally |
| Workflow and connector SDK | Not started | Versioned SDK, signed packages, permission review, evaluation requirements, and removal process exist |
| Capacity and abuse controls | Not started | Per-org quotas, queue backpressure, rate limits, fraud controls, and load-test targets are enforced |
| Disaster recovery | Not started | Restore, provider outage, ledger reconciliation, and regional failure runbooks are exercised |

## Verified in the current local build

- 197 domain, worker, registry, orchestration, runtime, connector, multitasker, delegation, and adapter tests pass, including 24 for the GitHub App adapter, 16 for skill distillation/recall, 12 for the Docker sandbox backend, and 15 for the terminal simulation core.
- TypeScript checking and the optimized Next.js build pass; a GitHub Actions workflow now runs test/typecheck/build on every push and pull request.
- Thirteen Playwright checks pass across desktop Chromium and a mobile Chromium viewport; one desktop duplicate of the mobile-only geometry test is intentionally skipped.
- The browser suite verifies quote recalculation, local-only reservation honesty, multiple run planning, fair scheduling display, graph validity, truthful multi-app workflow previews, provider blocking, the health endpoint, and absence of horizontal mobile overflow.
- With real CircuitNotion and E2B credentials configured **and called from this machine**, the exact production dispatcher path (`CodingAgentWorker` + `CircuitNotionCodingModelProvider` + `E2BSandboxProvider`) completed one live run: a real model plan, a real sandbox, a passing verification command, and full evidence capture, for 6 RWF in 13.4s. A second live run through the newer iterative tool-loop worker (`IterativeCodingAgentWorker` + `CircuitNotionAgentTurnProvider`) completed 5 model turns and 5 tool calls, wrote a source file and a test file, and passed `node --test`, for 8 RWF in 22.7s.
- The `dispatchTick` Convex action existed but was not wired to anything; nothing would ever have claimed a queued coding run in a deployed environment. It is now on a one-minute cron alongside lease recovery.
- Repeating that same dispatch **through the deployed `/terminal` UI** (real sign-up, real `createQuotedTask`, real `createTaskRun`, real `dispatchTick`) surfaced a real environment-specific finding: CircuitNotion's Cloudflare protection returns an HTML bot-challenge page to Convex Cloud's outbound IP, so the identical call that succeeds from this machine fails from the deployed action. The system's own invariants held correctly through that failure — 0 RWF was spent, the task reached `blocked` (not a false `completed`), and every state transition is in the real `agentRunEvents`/`usageLedger` tables (queried directly, not just read from the UI). Fixed alongside this: `dispatcher.ts` was storing raw provider error bodies (in this case a multi-KB HTML page) verbatim as a permanent step/event summary; `summarizeWorkerError` (`lib/worker-runtime.ts`) now recognizes an HTML error page and stores a short, honest summary instead, and bounds every other error message to 500 characters.

## Next executable slice

The next slice should close one vertical path rather than add more agent categories:

```text
provider-neutral turn and tool protocol
  -> capability-specific prompt/tool selection
    -> E2B browser and data workers
      -> persisted research/writing evidence
        -> approval-gated connector worker
          -> one live run per task kind
```

Circuit Pay activation should follow the same path after its real contract is verified. Until then, the task cap remains a budget-control promise rather than a captured payment.
