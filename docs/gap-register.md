# System gap register

This register is the implementation source of truth for what Circuit Agent can do now, what remains simulated or inactive, and what evidence closes each gap. A feature is not marked complete because an interface, schema, or adapter exists; it closes only when the named verification evidence exists.

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
| Durable dispatcher | Pure dispatcher plus a tested coding-worker engine plan fair, budgeted, approval-gated work and observe cancellation checkpoints | Integration-ready | Add the scheduled Convex Node action that atomically claims work and invokes the worker | Kill-and-resume test reaches one truthful terminal state without duplicate usage |
| Model gateway | Typed OpenAI Responses adapter uses code-versioned prompts, Structured Outputs, timeouts, refusals, explicit model identity, and complete usage capture | Integration-ready | Exercise real credentials; add fast/balanced/expert evaluation routing and provider fallback | Recorded live token usage reconciles to step usage; refusal, timeout, fallback, and malformed-response cases pass |
| E2B execution | Secure adapter and tested worker write bounded files, run policy-approved commands, capture evidence, heartbeat, check cancellation, and force cleanup | Integration-ready | Build the approved coding template and authorized repository provisioner | Live E2B test clones a fixture repo, changes it, runs checks, exports evidence, and terminates the sandbox |
| GitHub authorization | Coding request contract mentions repositories | Not started | Create GitHub App flow, installation-token vault, repo/ref validation, patch branch, approval-gated PR | Revoked access fails closed; approved workflow creates one tested PR with no long-lived token in E2B |
| Budget enforcement | Quote, cap, reservation, settlement, overage approval, and replay guard exist | Implemented locally | Enforce shared invariants in deployed Convex tests and ingest real provider usage | Negative, replay, concurrent-claim, and reconciliation tests show zero unapproved overrun |
| Circuit Pay | Payment state and adapter contract exist | Blocked | Verify official API, auth/checkout or hold semantics, signed webhooks, refund/release, idempotency | Provider sandbox transactions and replayed webhooks reconcile exactly to the internal ledger |
| Artifacts and evidence | Worker creates content-addressed manifests; Convex models tenant-linked metadata and rejects unrecorded completion references | Integration-ready | Store artifact blobs in Convex Storage and add authenticated streaming/download plus retention | Every completed coding run has retrievable, tenant-scoped evidence or an explicit no-artifact reason |

## P1 — required before broader customer use

| System | Current state | Status | Next implementation | Closure evidence |
|---|---|---|---|---|
| Web operations workspace | Quote UI and local plan visualization work on desktop/mobile viewports | Integration-ready | Connect authenticated Convex data, task detail, live logs, approvals, retry/cancel, artifact review | Two-device browser test observes one durable run and safely approves/cancels it |
| Native mobile | Responsive web only | Not started | Expo app with shared contracts, push, deep links, biometrics, voice/files, reconnect-safe mutations | Phone-only end-to-end task supervision succeeds after app termination and reconnect |
| Observability | Health endpoint reports configuration readiness | Integration-ready | Structured events, trace IDs, logs, metrics, alerts, SLOs, provider probes | Operator can trace a task across quote, payment, Convex, model, E2B, and artifact storage |
| Security hardening | Secure E2B defaults and authorization concepts exist | Integration-ready | Threat model, secret manager, network allowlists, prompt-injection defenses, scanning, audit export | P0 threats have automated controls and no unresolved critical findings |
| Evaluations | Domain unit and browser workflow tests exist | Integration-ready | Representative coding corpus, quality grader, destructive-action tests, fault injection | Release dashboard tracks success, evidence quality, cost error, cancellation, and recovery |
| Notification service | Approval states exist | Not started | Push/email/in-app delivery with dedupe, expiry, and deep links | Retries never duplicate an approval action; sensitive approval requires authenticated app context |
| Connector platform | Narrow provider contracts exist | Not started | OAuth vault, permission manifests, revocation, connector health, read/draft/execute tiers | First connector passes consent, expiry, revocation, replay, and tenant-isolation tests |

## P2 — required for platform scale

| System | Status | Exit condition |
|---|---|---|
| Calibrated RWF estimator | Integration-ready | Current token estimator and configured RWF catalog must be calibrated against live P50/P90 usage; FX and catalog versions must be attached to every quote |
| Organization policy and enterprise controls | Not started | SSO, retention, data region, audit export, and action policy are enforced centrally |
| Workflow and connector SDK | Not started | Versioned SDK, signed packages, permission review, evaluation requirements, and removal process exist |
| Capacity and abuse controls | Not started | Per-org quotas, queue backpressure, rate limits, fraud controls, and load-test targets are enforced |
| Disaster recovery | Not started | Restore, provider outage, ledger reconciliation, and regional failure runbooks are exercised |

## Verified in the current local build

- 63 domain, worker, and adapter tests pass with 96.86% function and 99.59% line coverage over the tested core.
- TypeScript checking and the optimized Next.js build pass.
- Seven Playwright checks pass across desktop Chromium and a mobile Chromium viewport; one desktop duplicate of the mobile-only geometry test is intentionally skipped.
- The browser suite verifies quote recalculation, local-only reservation honesty, multiple run planning, fair scheduling display, graph validity, provider blocking, the health endpoint, and absence of horizontal mobile overflow.
- OpenAI and E2B adapters plus their composed worker are tested with fake providers; no live model request or sandbox was created because credentials, price inputs, and an approved coding template are not configured.

## Next executable slice

The next slice should close one vertical path rather than add more agent categories:

```text
auth + Convex activation
  -> GitHub installation token
    -> model-planned coding step
      -> E2B clone / edit / test
        -> persisted logs and patch
          -> approval-gated PR
```

Circuit Pay activation should follow the same path after its real contract is verified. Until then, the task cap remains a budget-control promise rather than a captured payment.
