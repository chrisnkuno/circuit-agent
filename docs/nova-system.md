# The Nova agentic system

This is the whole system, described as it is built. It is written for an engineer who has to change
something and needs to know what will break — so it favours mechanisms and invariants over feature
lists, and says plainly where the boundaries are and what they do not protect.

Companion documents: `docs/architecture.md` (the hosted platform's contracts), `docs/gap-register.md`
(what is implemented versus verified), `docs/optimization-map.md` (performance budgets and their
probes), `docs/nova-desktop-backlog.md` (the desktop's audited gaps).

---

## 1. What Nova is

Nova is a coding agent that runs where the work is: a terminal (`nova`), a desktop window, or a
hosted worker. All three drive the same engine — one agent loop, one tool set, one permission model,
one transcript format — so a session behaves the same wherever it runs, and a fix lands everywhere
at once.

The product promise it is built around is **legible autonomy**: the machine may act on its own
inside a boundary a person can understand, price, interrupt, and audit. Every mechanism in this
document exists to keep one half of that sentence true.

Five properties follow from it, and they explain most of the design decisions below:

| Property | What it means in the code |
|---|---|
| **Bounded** | Every run has ceilings: iterations, tool calls, tokens, money. They are enforced by the runtime, not requested of the model. |
| **Gated** | Anything with an effect crosses an approval it cannot approve for itself. |
| **Auditable** | Every turn writes a hash-chained journal entry before its effect happens. |
| **Reversible** | Every turn snapshots the workspace; `/undo` puts it back. |
| **Honest** | "Completed" requires evidence that something was run. A model saying it verified is not evidence. |

---

## 2. The pieces

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Surfaces                                                                    │
│                                                                              │
│   nova (CLI, TUI)      nova-desktop (Tauri)      hosted worker (Convex)      │
│         │                     │                          │                   │
│         │              sidecar (stdio JSON)              │                   │
└─────────┼─────────────────────┼──────────────────────────┼───────────────────┘
          │                     │                          │
          ▼                     ▼                          ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│  @circuit-nova/nova-core  (packages/agent-core)                              │
│                                                                              │
│   NovaAgent ──────── session: context, memory, checkpoints, compaction       │
│      │                                                                       │
│      └── BoundedAgentRuntime ──── turn: the model loop, budgets, evidence    │
│               │            │                                                 │
│               │            └── tools ──── workspace, terminal, web, external │
│               │                                                              │
│               └── AgentTurnProvider ──── Anthropic · OpenAI · CircuitNotion  │
└──────────────────────────────────────────────────────────────────────────────┘
          │                                    │
          ▼                                    ▼
┌──────────────────────┐          ┌────────────────────────────────────────────┐
│ workspace backends   │          │ nova-state (Rust)                          │
│ local · E2B · Docker │          │ SQLite + FTS5 projection of the transcript  │
└──────────────────────┘          └────────────────────────────────────────────┘
```

**`packages/agent-core`** — published as `@circuit-nova/nova-core`. The engine: agent loop, tools,
permissions, workspace abstraction, session persistence, journal, checkpoints, memory, cost
accounting, provider adapters. Contains no terminal code and no `console.log`; it is embedded by
things that own their own output.

**`packages/nova-cli`** — the `nova` binary. Terminal rendering, slash commands, the guide, themes,
keybindings, background jobs, tabs, voice, ACP server, headless mode. Bundles the core.

**`packages/nova-state`** — a Rust binary that maintains a SQLite + FTS5 index over sessions and
event journals, so history search is instant. It is a *projection*: it can always be rebuilt from the
canonical files, and is dropped and rebuilt whenever its schema version changes.

**`apps/nova-desktop`** — a Tauri shell over a Node sidecar that hosts the same engine and speaks a
line-delimited JSON protocol over stdio.

**`convex/`, `lib/`** — the hosted platform: durable dispatcher, budget reservation and settlement,
approvals, artifacts, GitHub integration, payment holds.

---

## 3. A turn, end to end

This is the path every request takes. Everything else in this document is a detail of one of these
steps.

1. **The front end takes a request** and calls `NovaAgent.send(objective)`.

2. **A turn id is minted and the journal records that a turn started.** Ordered, not fsynced —
   nothing has happened yet, so a disk barrier here would cost latency and buy nothing.

3. **Project context is refreshed.** Instruction files (`AGENTS.override.md` → `NOVA.md` →
   `AGENTS.md` → `CLAUDE.md` → `.novarules`) are read from the repository root down to the working
   directory, deeper files taking precedence and the budget; the top-level layout, package scripts
   and git branch come along. Re-read every turn, because a long session must not keep following an
   `AGENTS.md` that changed three turns ago.

4. **The environment is probed** — once per session, cached. What shell rules apply, which package
   manager the lockfile names, which programs actually exist. This is what stops the agent running
   `npm test` in a bun repository, or piping in a sandbox that executes argv.

5. **Memory is recalled** against this turn's objective and attached to the *user* message — never to
   the system prompt, because the system prompt is the cached prefix (§7).

6. **A checkpoint is captured** of the workspace, before the agent can touch anything.

7. **Compaction runs if the transcript needs it** (§6).

8. **Tools are assembled** for the session's mode, including any skills, MCP servers, hooks and
   plugins discovered under `.nova/`.

9. **`BoundedAgentRuntime.execute` runs the loop:**
   - Ask the model. Stream the reply.
   - If it returned tool calls: check capability, ask the permission ledger, run them (read-only
     calls in parallel, effectful ones never), append results.
   - If it stopped: check the verification gate and the evidence ladder; nudge if warranted.
   - Repeat until done, or until a budget stops it.

10. **The result is folded back**: transcript, usage, cost, checkpoint, journal entries.

11. **The session is persisted** and the state index is marked dirty.

---

## 4. The agent loop

`BoundedAgentRuntime` (`agent-runtime.ts`) is the whole loop, and it is deliberately the only place
that talks to a model.

**Bounds it enforces.** `maxIterations`, `maxToolCalls`, `maxToolCallsPerTurn`, `maxToolResultChars`,
`maxTotalToolResultChars`, `maxOutputTokens`, and a money reservation. A run that hits one stops with
a terminal status naming which — never silently.

**Parallelism.** Consecutive tool calls that are read-only *and* declared parallel-safe run
concurrently; anything with an effect runs alone, in order. A tool declares its own `effect`, and the
runtime refuses to parallelise anything that has one.

**Tool results are bounded three ways**: per call, per iteration (a quarter of the total allowance —
eight parallel calls could otherwise append a whole context window in one step), and per turn. A
result larger than twice the per-call budget is written to `.nova/artifacts/` and replaced with a
head-and-tail excerpt plus a path; one within twice the budget goes through whole, because evicting
it costs more than it saves. An identical result already in the transcript is referenced, not
repeated.

**Truncated replies are resumed, not discarded.** `finish_reason: length` is a successful, incomplete
reply — the tokens are spent and the text is real — so the partial answer is kept and the model is
asked to continue. Tool calls from a truncated reply are dropped: their arguments are a JSON
fragment the model never finished choosing.

**An unstated finish reason is read from the payload.** Some gateways drop the final chunk; tool
calls mean a tool turn, text means a finished one, neither is an error. An unrecognised *word* is
still an error, because inventing a reading for it is how truncation gets mistaken for completion.

### The verification ladder

An agent that changes files and declares success without running anything is reported as
`needs_verification`, not `completed`. Evidence is ranked:

| Rung | What it proves | Example |
|---|---|---|
| `check` | The code is well-formed | typecheck, lint, build |
| `tests` | Units behave | `vitest`, `pytest` |
| `smoke` | The assembled thing runs | curl a route, run the CLI |
| `behavior` | The assembled thing behaves | Playwright, an integration suite |

A passing verification clears the "changed without verifying" flag and records its rung. If the run
stops with only compile-only evidence, the model is asked once — for executed tests *and* an
assembled-program check in the same message, because each ask costs a full transcript resend.

---

## 5. Permissions, modes and safety

**Four modes**, each a capability set:

| Mode | Can do | Approval |
|---|---|---|
| `plan` | Read, search, reason | Nothing to approve — the write tools are not in its tool set |
| `build` | Everything | Every effectful call asks |
| `auto` | Everything | Ordinary edits apply; sensitive actions still ask |
| `defender` | Everything, plus the security playbooks | Every effectful call asks, always |

Capabilities gate which tools exist for a mode, so a plan-mode session cannot call `write_file` — the
tool is not offered, rather than being offered and refused.

**Approvals bind to an action digest, never to a call id.** The digest covers the tool and its exact
arguments, so changed arguments need fresh consent, and an approval granted in one process cannot be
replayed for a different action in another. `allow_always` / `deny_always` persist against a scope
key carrying a policy version; bumping `APPROVAL_POLICY_VERSION` voids every stored approval.

**Some commands are refused outright rather than gated**, because a human approving quickly is
exactly the moment they will not notice which flag it was — recursive force deletes and
find-with-delete among them.

**Local execution is not sandboxed, and the code says so.** On your own machine an approved command
has exactly the authority your shell has. Nova narrows *what gets proposed* and contains the process
*tree* on Linux (an unprivileged user+PID namespace, so a cancelled command cannot leave background
processes behind) — neither is a security boundary. The approval prompt is the boundary. `--sandbox`
and `--sandbox docker` are the real ones.

**Nova's own credentials never reach a spawned command.** `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`E2B_API_KEY`, `NOVA_BILLING_KEY` and their siblings are stripped from the environment of anything
`run_command` starts — verified after `run_command("env")` printed one in full. A project's own
variables are left alone: they are the user's choice, made before Nova ran.

---

## 6. Context, compaction and cost

**Limits come from the model, not from a constant.** `providers/model-capabilities.ts` maps a model
id to its real context window and output ceiling; the session derives its budgets from that. An
unrecognised model falls back to a conservative 200K/16K — optimism about someone else's model is a
400 halfway through the work. Anthropic ids match by family prefix (a dated id is the same model);
OpenAI ids match exactly (`gpt-5.4-mini` is a different model with different limits).

**Compaction has two triggers and one boundary rule.** Past 70% of what is usable the transcript is
compacted as soon as the work reaches a clean stopping point; past 90% it is compacted regardless.
"A clean stopping point" is structural: the last message is a plain assistant message (not one
suspended between a tool call and its result) and nothing is marked in progress on the agent's plan.

What survives a compaction is chosen by size, not by count: the system prompt and the opening
request always, plus as much of the recent tail as fits in a fifth of the usable window, floored at
one complete exchange, and never starting on an orphaned tool result. The governing facts — the
mode, the original request, every approval and refusal, the open plan items — are re-derived from
live state and restated verbatim above the summary, because a constraint that survives only as a
sentence inside a summary stops existing a few compactions later.

**Cost is tracked in the user's own currency.** `CostLedger` prices every turn from provider-reported
usage, converts through a dated FX rate, and enforces `--budget` as a cap rather than a report. Sub-
cent amounts display as `$0.0034` rather than `$0.00`; an unpriced model says so instead of showing
zero. Slow mode caps the *rate* — fewer model rounds, smaller replies, a pause between turns — and
asks before an unusually expensive turn.

---

## 7. Talking to models

`AgentTurnProvider` is one method — `complete(request)` — plus an optional capability report. Three
adapters implement it (Anthropic Messages, OpenAI Chat Completions, CircuitNotion), and an
OpenAI-compatible path covers Ollama.

**Streaming is unconditional.** Output budgets are now large enough that an unstreamed reply would
hit the SDK's HTTP timeout — the request is billed and the answer lost. A caller that passes no delta
callback simply receives the collected turn.

**Prompt caching is a prefix match**, and the whole system is arranged around that. The render order
is tools → system → messages, so anything volatile in the system block invalidates the cache for the
entire transcript beneath it — a 0.1× read becoming a 1.25× write, every turn. Breakpoints sit on the
last tool, on the system block, and on a rolling message two from the end (never the newest content,
which would pay the write premium for something never read back). Two invalidators were found and
closed: recalled memory now rides with the objective, and the top-level directory listing ignores
generated directories so a test run cannot rewrite the prompt.

**Effort is a spend control.** Reasoning tokens bill as output and share the output budget, so where
the caller *knows* the work is cheap — compaction is reading, a delegated sub-task is bounded — the
request asks for low effort. Ordinary turns leave it unset: the provider's default is right, and
second-guessing it costs quality on exactly the requests that need it. It is sent only to models
whose capability record says the field exists, because an unknown field is a 400.

---

## 8. The workspace

`NovaWorkspace` is the boundary between the tools and the files. One interface, three backends —
local directory, E2B sandbox, Docker container — and the *same eleven tools* run against all of them,
with the same names and descriptions. That is deliberate: a model's behaviour is shaped by tool
names and descriptions, so changing them per backend would mean the agent that works well locally is
not the agent that runs remotely.

Every path is resolved against the root and refused if it escapes; symlinks are reported but never
followed. Reads are size-bounded, writes are size-bounded, and binary files are detected and skipped
rather than decoded.

The walk that backs `glob_files`, `grep_files` and `list_files` reads a level of directories
concurrently and yields them in queue order — deterministic, because a walk that yielded in
completion order would make `glob_files` return a different list on every call. Content search reads
files concurrently and rules a file out with a raw byte scan before decoding it into a line array.
Generated directories (`node_modules`, `dist`, `coverage`, `target`, …) are skipped everywhere.

---

## 9. What is on disk

Everything Nova keeps for a project lives under `.nova/`, in formats a person can read:

| Path | What it holds |
|---|---|
| `.nova/sessions/` | Session records: transcript, mode, model, cost, integrity digest |
| `.nova/events/<id>.jsonl` | The event journal — one JSON object per line, hash-chained |
| `.nova/artifacts/` | Tool output too large for the transcript, content-addressed |
| `.nova/memory.md` | Project memory: plain markdown bullets, editable and committable |
| `.nova/checkpoint-index` | A private git index for `/undo`; never touches your staged changes |
| `.nova/jobs.json`, `.nova/jobs/` | Durable background jobs and their logs |
| `.nova/projection.db` | The nova-state index — a projection, always rebuildable |
| `.nova/skills/`, `hooks/`, `mcp/`, `plugins/` | Project-declared extensions |
| `.nova/themes/` | Terminal themes |
| `.nova/children/` | Git worktrees for child sessions |

**The journal is the audit record.** Each entry carries a sequence number, the previous entry's hash,
and its own — so a missing or altered entry is detectable rather than merely unlikely. Entries are
appended through one serialized writer with a persistent handle. Durability is selective and the
distinction is the point: telemetry is ordered but not fsynced, while anything that must reach disk
*before* a side effect happens — a tool call, an approval, a turn transition — is fsynced first.

**Sessions are written atomically**: a temp file, fsynced, then renamed, under a lock, with a
revision check to catch a concurrent writer. The fsync is the durability guarantee, not overhead.

---

## 10. Extending the agent

Four mechanisms, all discovered from `.nova/`, all offered to the model as ordinary tools, and all
marked with where they came from so a tool Nova did not ship is never mistaken for one it did.

| Mechanism | Declared as | Runs as |
|---|---|---|
| **Skills** | `skill.json` manifests | A command through the workspace — so a skill works in a sandbox too |
| **Hooks** | Scripts in `.nova/hooks/` | Pre- and post-tool-call interception, on every tool |
| **MCP servers** | Server configs | JSON-RPC over stdio; tool list fetched once and refreshed when the server says so |
| **Plugins** | Plugin manifests | Bundles of the above |

External tools always require approval, whatever the mode: code that did not ship with Nova, running
with the user's authority, is exactly the thing a human should see before it runs.

**Delegation.** `delegate_task` runs one self-contained sub-task through a bounded sub-agent with its
own iteration and money reservation — never more than half of what is left of the turn — and reports
back in prose. It runs at low effort, because a bounded sub-task is the textbook cheap-work case.

---

## 11. The surfaces

**The CLI** is the reference implementation: a TUI with slash commands (`/mode`, `/model`, `/undo`,
`/diff`, `/cost`, `/pay`, `/scan`, `/files`, `/edit`, `/jobs`, `/detach`, `/tab`, `/guide`, …), a
searchable palette, an in-terminal guide whose coverage is enforced by a test, themes, keybindings
that are all on modifiers (a bare letter costs every message that starts with that word), and a
headless mode where every stdout byte is a complete JSON object and every terminal status has its
own stable exit code.

**Background jobs** outlive the prompt. A job has durable state, a log, and its own approval queue —
approvals bound to the action digest, so answering one cannot authorize a different action the worker
re-parked while the human was typing.

**The desktop** is a Tauri shell over a Node sidecar hosting the same engine, with tabs that each
carry their own session, model and cost. Its audited gaps are in `docs/nova-desktop-backlog.md`.

**The hosted platform** dispatches durable, budgeted, approval-gated work to a worker that runs the
same loop inside an E2B sandbox, with reservations and settlement against a ledger.

---

## 12. How quality is held

Three mechanisms, each mechanical, because none of this survives on good intentions.

**Invariant-first tests.** Every change gets tests at three levels — invariant (properties true for
all valid inputs), behavioural (the feature does what was asked, asserted on real output), and
functional (the assembled thing runs). A passing typecheck is not a test; it proves the code
compiles, not that it is correct. Level three is the one most often skipped and the one that catches
the most embarrassing failures.

**The optimization map** (`packages/agent-core/src/nova-cli/optimization-map.ts`) is a registry of
performance targets, each with a live probe, a two-sided budget, and the remediation to apply when it
breaks. The suite runs every probe. `bun run optimize:map` prints the table; `--json` is the form an
agent reads. Rules for adding one: measure the behaviour rather than the constant, bound both sides,
and mutation-test it — break the code it guards and watch it go red.

**The conformance suite** (`packages/agent-core/src/conformance.test.ts`) encodes the standards this
package already holds, so they cannot erode one reasonable-looking exception at a time. Zero-tolerance
rules: every executable module is exercised by a test, no empty catch, no `console.*` or
`process.exit` in library code, no suppressed type errors, no abandoned TODO markers, no orphaned
test files. Ratchets, which may only fall: type escapes at the SDK boundary, and modules without a
header comment.

The difference between the two kinds of rule is the whole design. A zero-tolerance rule fails on the
first violation rather than the hundredth. A ratchet lets work continue without anyone stopping to
pay off every debt first — while making it impossible to quietly add to them.

---

## 13. Configuration

Settings live beside the user's Nova config (`NOVA_CONFIG_DIR`), and every one is also an environment
variable, so a CI run configures the same things a person does.

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `CIRCUITNOTION_API_KEY` | Model providers |
| `*_BASE_URL`, `*_MODEL` | Per-provider endpoint and model overrides |
| `CIRCUITNOTION_RELAY_SECRET` | Authenticates to the relay Worker; never sent to the vendor |
| `E2B_API_KEY`, `E2B_CODING_TEMPLATE` | Remote sandboxes |
| `EXA_API_KEY` | Web search — the `web_search` tool exists only when it is set |
| `NOVA_BILLING_URL` / `NOVA_BILLING_KEY` | Enable `/pay`; both or neither |
| `NOVA_COUNTRY` / `NOVA_CURRENCY` | What money is displayed in |
| `NOVA_FX_OFFLINE` | Skip the daily FX lookup |
| `MODEL_*_PER_MILLION` | Price overrides for a model the catalog does not know |
| `NOVA_KEYS` | Keybinding overrides |
| `NOVA_CONFIG_DIR` | Where settings, user memory and caches live |

A tool that needs a credential does not exist without it, rather than existing and failing: only real
capabilities get a tool.

---

## 14. Glossary

**Action digest** — a hash of a tool call and its exact arguments; what an approval binds to.
**Artifact** — tool output too large for the transcript, written to disk and referenced by path.
**Boundary (compaction)** — a point where forgetting is safe: no suspended tool call, no in-progress
plan item.
**Capability** — a permission label on a tool; modes are sets of them.
**Checkpoint** — a snapshot of the workspace in a private git index, taken per turn.
**Effect** — what a tool does to the world: `none`, `workspace`, or `external`.
**Evidence rung** — how strong a verification result is: check < tests < smoke < behavior.
**Journal** — the hash-chained, append-only record of everything a session did.
**Projection** — the nova-state index; derived data, always rebuildable from canonical files.
**Ratchet** — a recorded count of an accepted debt that may only fall.
**Turn** — one user request and everything the agent does in service of it.
