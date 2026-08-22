# The Nova optimization map

A map that goes stale is a map that lies. This one is executable: every claim below is a target in
`packages/agent-core/src/nova-cli/optimization-map.ts` with a live probe, a budget, and the fix to
apply when the budget breaks.

```
bun run optimize:map          # the whole picture, including what is not yet probed
bun run optimize:map --json   # the same, machine-readable — what an agent should read
bunx vitest run packages/agent-core/src/nova-cli/optimization-map.test.ts
```

The test is the continuous part. A change that quietly spends a thousand extra tokens per request
fails the suite the day it lands, rather than being noticed in a bill three weeks later.

## The loop

```
        ┌──────────────────────────────────────────────────────────┐
        │                                                          │
   measure ──▶ compare to budget ──▶ fail ──▶ read remediation ──▶ fix
        ▲                            │                             │
        │                            └── pass ──▶ record baseline  │
        └──────────────────────────────────────────────────────────┘
```

Every target carries the three things that make a failure actionable without a human in the loop:
what was measured, what it should be, and what to do about it. That is deliberate — a finding
written as prose is work for a person; a finding written as `{measured, budget, remediation}` is
work an agent can pick up, reproduce, fix, and re-measure.

**Three rules for adding a target.** Each was learned by getting it wrong first:

1. **Measure the behaviour, not the constant.** A probe that reads back the constant it guards
   proves only that the constant is still there. The eviction probe runs a real result through the
   real runtime — which is why it catches a loss band that a threshold assertion could not.
2. **Bound both sides.** A ceiling-only budget passes when the measurement collapses to zero, which
   is usually a worse bug than the one being guarded. Verified the hard way: the eviction probe read
   `<= 1.05` and stayed green while its regression was deliberately reintroduced, because eviction
   makes that ratio *smaller*.
3. **An honest gap beats a fake number.** A target with no probe reports `unmeasured` everywhere. A
   map that counts "no probe" as "fine" quietly becomes decoration.

**Every new target must be mutation-tested**: break the code it guards, watch it go red, restore.

## The map, by layer

Baselines measured 2026-08-22 on this repository. `—` means no automated probe yet.

### Prompt — what a request costs before the user has spoken

| target | now | budget | state |
|---|---|---|---|
| `prompt.fixed-cost.build` | 4,534 tok | 2,000–6,000 | ok |
| `prompt.fixed-cost.defender` | 6,047 tok | 4,000–9,000 | ok (was 20,420) |
| `prompt.prefix-stability` | 0 volatile values | 0 | ok |

The defender playbooks — 43,919 characters, ~14,300 tokens — used to be sent whole on every request
of every iteration. They are now a 1,222-character index plus a `read_playbook(id)` tool, so the
model pulls the two or three categories the project actually has a surface for.

Prefix stability is a caching property, not an aesthetic one: caching is a strict prefix match over
tools → system → messages, so one changed byte in the system block invalidates the cache for the
whole transcript beneath it — a 0.1× read becoming a 1.25× write, every turn. Two invalidators were
found and closed: recalled memory (selected per-objective, now travels with the objective) and the
top-level directory listing (a test run creating `coverage/` rewrote the prompt).

### Context — how much of the window is usable

| target | now | budget | state |
|---|---|---|---|
| `context.compaction-headroom.200k` | 0.77 of window | 0.50–0.95 | ok (was 0.28) |
| `context.compaction-headroom.1m` | 0.78 of window | 0.70–0.95 | ok (was 0.056) |
| `context.compaction-retention` | 0.16 of usable | 0.01–0.30 | ok (was 0.49) |

Retention is the third of these and the newest. "Keep the last six messages" treated a two-line
acknowledgement and a 40,000-character test log as the same size: six of the latter carried ~60,000
tokens *past* the compaction that happened because the transcript was too large, and six of the
former threw away context the next turn plainly needed. The tail is now sized in tokens — a fifth of
what is usable, floored at one complete exchange, still never starting on an orphaned tool result.

Two causes, both fixed. The estimator used a byte-dominated pessimistic figure (~3× the real token
count), and the context limit was the constant `200_000` for every model on every provider. Limits
now come from `providers/model-capabilities.ts`; an unknown model still gets exactly the old
conservative numbers, because optimism about someone else's model is a 400 mid-task.

### Transcript — what tool results cost

| target | now | budget | state |
|---|---|---|---|
| `transcript.no-eviction-loss-band` | 1.00 | 0.95–1.05 | ok |
| `transcript.large-result-excerpt` | 0.03 of budget | 0.01–0.35 | ok (was 1.0) |

Eviction to an artifact is a clear win above roughly twice the per-call budget and a clear loss
below it: measured at a 40,000-character budget, a 41,000-character result evicted to a 39,864
character excerpt — 1,136 saved — and then invited a `read_file` worth up to 40,000. Results within
2× now go through whole; genuine monsters become a path plus a small head-and-tail sample.

Also here: identical results are referenced by digest instead of paid for twice, and one iteration
of parallel calls can no longer append a whole context window in a single step.

### Provider — talking to the model efficiently

| target | now | budget | state |
|---|---|---|---|
| `provider.capability-coverage` | 1.00 | 1.00 | ok |

Every hosted provider's default model must resolve to real, published limits. Ollama is excluded by
design: a local model's window is whatever the user's own model file says, and the conservative
fallback is the honest answer rather than a gap.

Both providers now stream unconditionally (output budgets are large enough that an unstreamed reply
risks the SDK's HTTP timeout), send a stable prompt-cache key, and pass through an effort setting
where the model accepts one. Compaction and delegated sub-agents run at low effort — reasoning
tokens bill as output and share the output budget, so effort is a spend control, not a preference.

### Runtime — the agent loop

| target | now | budget | state |
|---|---|---|---|
| `runtime.iteration-append-cap` | 0.10 of allowance | 0.01–0.30 | ok |
| `runtime.nudge-round-trips` | 4 model calls | 3–4 | ok |

The nudge target guards a decision that predates this pass: the test and behaviour rungs are asked
in one message. Walking the ladder one question per model call costs a full transcript resend per
rung — on a 100K-token conversation, a 114-token nudge costs 100,114 input tokens.

Eight parallel calls at the per-call budget was ~107,000 tokens appended in one step — on a 200K
model that is the context error itself, not a step towards it.

### State — the Rust index (`packages/nova-state`)

| target | now | budget | state |
|---|---|---|---|
| `state.index-throughput` | 62,268 docs/s | ≥ 20,000 | ok (was 3,937) |
| `state.search-latency-p50` | 0.237 ms | ≤ 1 ms | ok (was 0.83) |

94% of a rebuild was fsync — one durable commit per session. Sources are now read outside the write
transaction and written in batches; FTS deletes go by rowid rather than a subquery fts5 cannot
optimise; hot statements are prepared once; and search truncates candidates before assembling
evidence (a broad query: 271 ms → 36 ms). Durability was not weakened to get there.

Probed by `bun run bench:state` rather than by the TypeScript suite — the numbers above were
verified independently of the agent that produced them.

### CLI — everything between Enter and an answer

| target | now | budget | state |
|---|---|---|---|
| `cli.workspace-walk` | 6.1 ms | ≤ 60 ms | ok (was 41 ms) |
| `cli.grep-latency` | 14 ms warm | ≤ 250 ms | ok (401 → 93 ms cold) |
| `cli.startup` | — | ≤ 200 ms | not yet probed |

The bundle was not code-split, so `await import("providers/factory")` bought nothing — Bun hoisted
the whole subtree into the entry file and the OpenAI, Anthropic and zod runtimes executed on
`nova --help`. Of 755 module sections, 510 ran before a prompt could be drawn. With `splitting: true`
and `.mjs` chunk naming: entry **3.90 MB → 0.94 MB**, `--help` **0.17 s → 0.12 s** measured here.
The `.mjs` naming is load-bearing — `dist/` has no package.json in the local build, so a `.js` chunk
would be read as CommonJS and fail the moment the ESM entry imported it.

The walk reads a level of directories at once instead of awaiting one `readdir` at a time, and grep
reads files concurrently with a raw `Buffer.indexOf` prefilter that rules a file out before decoding
it into a line array. Both keep deterministic output order, which is not incidental: a concurrent
walk that yielded in completion order would make `glob_files` return a different list on every call.

MCP `tools/list` is now fetched once per connection instead of once per turn, invalidated by the
server's own `notifications/tools/list_changed` — which the client previously discarded, since it
only ever looked at messages carrying an id.

**Deliberately not changed:** rendering was suspected of being O(n²) per streaming delta and is not —
`MarkdownStream` is line-oriented and incremental, measured 15–23 ms for a 50 KB reply regardless of
delta size. `saveSession` is fsync-bound at ~23 ms/turn, and that fsync *is* the durability
guarantee; trimming around it saves 8–10 ms and weakening it is a policy decision, not an
optimization. Skill manifests are still re-read each turn (0.33 ms here) because caching them would
mean a user editing a skill has to restart the session — the wrong trade for a local file read.

## Open, ranked

1. **`documents_context` index is redundant in nova-state** — its columns are already the prefix of
   a UNIQUE index. Removing it needs an on-disk schema version bump.
3. **The state benchmark corpus is unrepresentative** — it writes no `integrity` field and no
   journals, so digest verification and the whole journal path are invisible to `bench:state`.
4. **OpenAI `tool_search` / `defer_loading`** would cut per-request tool-schema cost, but need the
   Responses API; the agent path is Chat Completions.
5. **Exact token counting** is available on both providers (`count_tokens`, `responses.inputTokens.count`)
   and would remove estimator drift from the compaction decision, at one HTTP call per decision.

## Tried and rejected

**Batching the verification nudge with the evidence asks.** The reasoning was sound and the code was
written and tested: files changed with nothing run is one state, so ask everything at once. Tracing
the runtime disproved it — any *passing* verification clears the needs-verification flag, so that
branch only fires when there is no evidence at all, where the evidence rungs never fire either. It
saved no round trip, and marking the rungs "asked" would have quietly weakened the evidence ladder
for a later climb. Reverted. The probe written to guard it survived, pointed at the escalation that
does cost a round trip, after two rewrites in which it measured the same number whichever way the
code behaved.

## How Nova uses this on itself

The intended loop, and the reason the registry is data rather than prose:

1. `bun run optimize:map --json` — every target with its status, measurement, and remediation.
2. For each `fail`, the remediation names the file and the mechanism; reproduce it with the probe.
3. Fix, re-run the probe, then the suite.
4. When the fix changes what "good" means, update the budget **and** its baseline in the same
   commit, so the record shows what changed and when.

A target is never quietly relaxed to make a build pass. Widening a budget is a decision that gets
written down next to the number it replaced.
