# Agentic Coding Systems: Source-Level Deep Dive and Circuit Agent Implementation Blueprint

Status: implementation guide

Research date: 2026-08-09

Audience: coding agents and maintainers extending Circuit Agent and Nova CLI

## 1. Purpose

This document turns a source-level study of OpenCode, Cline, and OpenAI Codex into an implementation blueprint for Circuit Agent. It is not a feature-copying checklist. Its goal is to identify the durable engineering patterns behind capable coding agents, decide which ones fit Circuit Agent, and define contracts and acceptance criteria precise enough for an implementation agent to execute.

The central conclusion is:

> Keep Circuit Agent's TypeScript orchestration, Convex control plane, provider integrations, budget accounting, and clients. Build a versioned agent protocol and durable event model first. Then consider a small Rust execution sidecar for the security- and process-intensive local runtime. Do not rewrite the whole product in Rust.

Circuit Agent already has a differentiated foundation: task-priced execution, local-currency presentation, budget reservation and settlement, hosted execution, and a bounded tool loop. Its largest gaps are not model intelligence or language performance. They are protocol durability, exact approval resumption, local process isolation, context provenance, extension boundaries, and a shared runtime contract across web and CLI.

## 2. Method and source snapshots

The comparison is based on code and documentation at fixed upstream revisions, not just marketing pages.

| Project | Revision studied | License | Primary implementation |
| --- | --- | --- | --- |
| OpenCode | `38e10eb1408feb700021b8e8766fb0ab41bf84e2` | MIT | TypeScript |
| Cline | `45403900964a74aa5ae3683a0e61b535600b97e0` | Apache-2.0 | TypeScript |
| OpenAI Codex | `266c6920d9b82fe4d68959529565256b12a9be99` | Apache-2.0 | Rust |

These projects evolve quickly. The pinned revisions make every architectural claim reproducible. When borrowing code instead of reimplementing a behavior, preserve the applicable license and notices and perform a license review. Architectural inspiration does not remove code-license obligations.

The study focused on:

- the turn loop and model/tool state machine;
- context construction, compaction, and instruction discovery;
- tool registration, execution, and output normalization;
- approvals, policy, sandboxing, and recovery;
- persistence, replay, resumability, and client protocols;
- subagents, workspaces, extensions, and provider abstraction;
- CLI, IDE, headless, and server integration surfaces.

## 3. The common agentic-coding stack

All three systems converge on a layered design even where their product surfaces differ:

```text
clients: CLI / TUI / IDE / web / automation
                  |
versioned protocol and event stream
                  |
thread + turn + item/session coordinator
                  |
context assembler <-> compactor <-> instruction/skill discovery
                  |
model adapter <-> streaming normalizer <-> tool-call repair
                  |
tool registry -> policy -> approval -> sandbox/executor -> result
                  |
event log + projections + checkpoints + telemetry
```

A production coding agent is therefore not just an LLM repeatedly calling tools. It is a resumable state machine whose correctness depends on six invariants:

1. Every state transition is representable and replayable.
2. Every side effect passes through one policy and execution path.
3. Every approval identifies the exact proposed action and policy context.
4. Context reduction never corrupts tool-call/result structure.
5. Cancellation, failure, and restart leave a recoverable session.
6. All clients observe the same canonical event semantics.

## 4. OpenCode deep dive

### 4.1 Product and architecture

OpenCode is a TypeScript monorepo with a core agent package plus terminal, desktop, web, SDK, plugin, protocol, server, and provider surfaces. Its useful architectural characteristic is not merely breadth; the interactive products are clients around a reusable session engine.

The central implementation areas are:

- `packages/opencode/src/session/`: the loop, message processing, LLM integration, compaction, instructions, and revert behavior;
- `packages/opencode/src/agent/`: built-in and custom agent profiles;
- `packages/opencode/src/tool/`: built-in tools and registry;
- `packages/opencode/src/permission/`: permission rule evaluation and pending approvals;
- `packages/opencode/src/provider/`: model/provider discovery and normalization;
- `packages/opencode/src/snapshot/`: workspace snapshots and restoration;
- `packages/opencode/src/server/`: the client-facing server.

### 4.2 Agent loop

OpenCode's session prompt loop is an explicit controller rather than a single SDK convenience call. It:

1. marks the session busy and reconstructs non-compacted history;
2. repairs incomplete tool-call follow-ups when providers stop unexpectedly;
3. starts ancillary work such as title generation;
4. handles subtask and compaction requests;
5. detects context overflow before sampling;
6. resolves the selected agent, model, instructions, and current tool set;
7. applies plugin transformations;
8. streams normalized model events through a processor;
9. chooses retry, continuation, compaction, or termination;
10. prunes obsolete output while preserving session meaning.

This is important: provider completion is evidence, not authority. The host loop decides whether the turn is actually complete.

### 4.3 Agents and modes

OpenCode represents agents as data: prompt, model, mode, step limits, options, and permission rules. Built-ins include build and plan modes plus specialized hidden agents for compaction, titles, and summaries. The plan agent enforces its restriction by denying mutation tools, not merely by adding a prompt saying “do not edit.”

That separation should be copied conceptually. A mode is a capability profile plus policy, not a UI label.

### 4.4 Tools and model normalization

The tool registry exposes file reads, search, edits, patches, shell execution, LSP, web access, MCP tools, skills, planning, questions, and task delegation. It can hide denied tools from the model. The LLM layer normalizes provider streams, applies provider-specific transformations, repairs malformed tool calls where possible, and emits a common event representation.

Two practical lessons follow:

- Tool availability should be derived per turn from capabilities, policy, environment, and model support.
- Provider quirks belong in adapters, not in the agent loop or individual tools.

### 4.5 Permission model

OpenCode evaluates ordered wildcard rules with the last match winning. A request can resolve to allow, ask, or deny. An approval can apply once or for a broader session scope; rejection resolves other pending work safely. Some risky patterns, such as external directories and repeated identical calls, are designed to ask by default.

The strength is composability. The limitation for Circuit Agent is that broad “always allow” choices still need action-aware scoping when money, external systems, or shell commands are involved.

### 4.6 Context and instructions

OpenCode collects global and project instructions from files such as `AGENTS.md`, supports configured file paths and URLs, and discovers nested instructions when the agent enters deeper directories. It records which instructions have already been attached so they are not blindly duplicated.

This makes instructions part of context assembly with provenance and scope. Circuit Agent should not concatenate repository guidance into an opaque system prompt; it should retain source path, applicable directory, hash, priority, and the turn in which each instruction became active.

### 4.7 Compaction and recovery

OpenCode prunes old tool output, reserves a recent-turn tail, invokes a dedicated compaction agent, and carries the previous summary forward. Overflow can trigger compaction and replay. Git-based snapshots support diffs, restoration, and session reversion.

The key implementation lesson is to treat compaction as a first-class, billable model operation that creates a versioned context artifact. It must preserve unresolved approvals, active plans, recent tool-call pairs, file changes, verification status, and budget state.

### 4.8 Subagents and extensions

OpenCode supports foreground and background task agents, depth limits, child sessions, resumable task identifiers, cancellation, and notification back into the parent. Child permissions are attenuated rather than silently broadened. MCP, skills, plugins, custom tools, formatters, and LSP integrations extend the core without changing the main loop.

The pattern worth adopting is a small tool protocol and explicit child-session relationship. Background work should never be an untracked promise living only in process memory.

### 4.9 OpenCode lessons for Circuit Agent

Adopt:

- data-driven agent profiles and capability-enforced modes;
- provider-neutral streaming events;
- dynamic tool exposure;
- scoped instruction discovery with provenance;
- dedicated compaction and summary artifacts;
- resumable child sessions and permission attenuation;
- snapshot/revert as part of the session model.

Do not copy uncritically:

- a permission choice keyed too broadly for paid or external actions;
- a large extension surface before the protocol and security boundaries stabilize;
- provider-specific fixes inside generic session state.

## 5. Cline deep dive

### 5.1 Product and layered SDK

Cline combines IDE-first workflows with a reusable SDK. Its open source stack is intentionally layered:

```text
shared contracts
    -> LLM providers
    -> browser-compatible agent runtime
    -> Node core: sessions, tools, hub, automation
    -> CLI and VS Code clients
```

This dependency direction makes the core agent portable and prevents UI packages from becoming the source of truth.

### 5.2 Runtime loop

`AgentRuntime` exposes run, continue, abort, subscribe, restore, and snapshot operations. A run:

1. applies plugins and hooks;
2. streams provider output into typed events;
3. recognizes and executes tool calls;
4. runs safe independent calls in parallel where allowed;
5. enforces completion-tool policy;
6. tracks iteration limits and loop mistakes;
7. compacts and retries after context overflow;
8. asks the host for approvals through a callback;
9. emits state that clients can subscribe to.

The Node session orchestrator surrounds this with longer-lived conversation storage, event adaptation, mistake/loop tracking, OAuth recovery, and fresh runtime creation per run. The separation between ephemeral run machinery and durable session ownership is a strong pattern.

### 5.3 Plan and Act

Cline's Plan and Act modes are explicit capability boundaries. Plan mode cannot edit files or execute commands; Act mode restores those capabilities without discarding the conversation. The product can use different models for planning and acting.

This demonstrates a useful contract for Circuit Agent:

```ts
type Mode = {
  name: string;
  capabilities: CapabilitySet;
  modelPolicy?: ModelSelectionPolicy;
  completionPolicy: CompletionPolicy;
};
```

The server, CLI, and model should all receive the same effective mode object.

### 5.4 Tool approval and command safety

Cline groups auto-approval by categories such as reads, edits, commands, browser actions, and MCP. Tool calls can mark themselves as requiring approval. Desktop approval requests use a fail-closed mechanism with timeouts. “YOLO” approval is intentionally described as dangerous.

This user-friendly category model is valuable for settings. It should not be the internal authorization key. Internally, approvals need a canonical action digest covering tool name, normalized arguments, workspace, side-effect class, estimated spend, network target, and policy version.

### 5.5 Checkpoints

Cline creates shadow-Git checkpoints around tool operations, including untracked content. Users can restore code, conversation, or both. Checkpoints are persistent enough to survive normal client flows.

Circuit Agent's current private-index checkpoints are directionally similar. The missing pieces are persisted checkpoint metadata, stable relationships to events/turns, explicit restore modes, and recovery testing after process restart.

### 5.6 Hub-and-spoke sessions

Cline's SDK documents a hub daemon that owns sessions while clients attach as spokes over WebSocket. Sessions outlive any one client. Multiple clients can observe or provide capabilities, and the system combines a SQLite index with JSON as a source of truth.

This solves a recurring CLI/IDE problem: the terminal UI, editor, and automation runner should not each implement a separate agent. Circuit Agent needs the same principle, even if it chooses JSON-RPC over local sockets and Convex for hosted projections.

### 5.7 Customization and automation

Cline exposes rules, ignore files, hooks, plugins, skills, MCP, browser actions, subagents/teams, schedules, and connectors. Its CLI supports interactive, headless, and automation-oriented usage. Connector sessions can map to external conversation threads with access controls.

The architectural lesson is to distinguish three extension types:

- context extensions: rules and skills;
- capability extensions: tools and MCP servers;
- lifecycle extensions: hooks and plugins.

Conflating them creates permissions that are difficult to explain or audit.

### 5.8 Cline lessons for Circuit Agent

Adopt:

- a layered SDK with shared contracts below clients;
- session ownership outside the short-lived sampling loop;
- capability-enforced Plan and Act modes;
- persistent checkpoints with separate code/conversation restore choices;
- a daemon/app-server boundary so sessions survive clients;
- hook and tool-policy interception points;
- mistake and loop detection as explicit runtime services.

Do not copy uncritically:

- approval categories as the underlying authorization model;
- every IDE or connector before one canonical protocol is stable;
- an extension install path that can silently gain ambient credentials.

## 6. OpenAI Codex deep dive

### 6.1 Product and Rust workspace

Codex is a Rust workspace whose core powers a CLI/TUI, non-interactive execution, an app server used by clients, sandboxing, protocol definitions, skills, hooks, MCP, and multi-agent operations. Its architecture is particularly instructive for local security, process lifecycle, and a versioned client boundary.

### 6.2 Turn lifecycle

Codex's turn implementation coordinates:

1. pre-sampling compaction;
2. required MCP availability;
3. step context and world-state capture;
4. skills, plugins, and instructions;
5. lifecycle hooks;
6. queued user steering input;
7. reuse of a model-client session;
8. sampling, tools, and pending input;
9. context and token accounting;
10. automatic compaction or a new context window;
11. stop hooks and continuation decisions.

This makes “a turn” a durable orchestration boundary, not just one provider request. Steering can be queued while the turn is active rather than forcing the client to fake a new unrelated session.

### 6.3 Tool registry and orchestration

Codex registers typed tool specifications and routes normalized response items to handlers. Some tool namespaces can be deferred and discovered through tool search. The execution orchestrator centralizes the order of operations:

```text
normalize action
  -> evaluate policy and cached decision
  -> request approval if required
  -> select sandbox/profile
  -> execute attempt
  -> classify sandbox or network denial
  -> optionally request escalation and retry
  -> emit result and audit metadata
```

That ordering prevents each shell or patch tool from inventing its own security semantics.

### 6.4 Approvals and sandboxing are separate

Codex separates whether an action requires human approval from how the resulting process is constrained. The official security documentation describes OS-enforced sandboxing, workspace-write defaults with network disabled, protected metadata paths, several approval modes, and optional network controls. This is a foundational distinction:

- approval answers: “may this exact action be attempted?”
- sandbox answers: “what can the attempt physically access?”

One cannot replace the other. A user can approve a command and still benefit from filesystem and network limits. Conversely, a sandboxed command may still warrant approval because it spends money, modifies files, or has surprising intent.

Codex supports platform-specific enforcement, including macOS Seatbelt, Linux sandbox mechanisms, and Windows handling. Approval cache keys incorporate more than a tool name: command, working directory, environment, sandbox mode, permissions, or patch paths can participate.

### 6.5 AGENTS.md instruction hierarchy

Codex loads instruction files from the project boundary down to the working directory, supports override files, applies a byte budget, and retains provenance. Deeper files take precedence in their scope. This produces deterministic, inspectable repository guidance.

Circuit Agent should support the same conceptual hierarchy while keeping its parser independent. The context assembler should expose active instruction sources to clients and the audit log.

### 6.6 App server and protocol

Codex's app server is a JSON-RPC 2.0 interface, primarily over JSONL on standard input/output, with experimental socket transports. Its domain is expressed as thread, turn, and item objects. It supports thread start/resume/fork, turn start/steer/interrupt, streaming deltas, approvals, configuration, skills, and MCP. Schemas and TypeScript bindings can be generated from the protocol.

This is the most relevant architectural reference for Nova CLI. A strict protocol allows the TUI, headless runner, IDE, and tests to share the same state machine. In non-interactive mode, machine-readable events go to standard output and diagnostics go to standard error, preventing logs from corrupting automation output.

### 6.7 Persistence and replay

Codex records append-only JSONL rollouts and maintains projections in a state database. Threads can be resumed and forked. The event log supports inspection and makes partial failures diagnosable.

For Circuit Agent, event sourcing should be pragmatic rather than ideological: JSONL can be the recoverable local source of truth, with SQLite indexes/projections for query speed, while Convex stores the hosted canonical events and projections.

### 6.8 Subagents and inherited policy

Codex child agents are sessions with inherited effective configuration and runtime policy. Multi-agent tools can spawn, message, wait, close, and resume them. This is safer than treating delegation as an untyped model call because child state, permissions, and lifecycle remain visible.

Circuit Agent should additionally attenuate money and tool budgets: a child may receive a subset of the parent's remaining RWF, tool-call allowance, time, filesystem scope, and network policy, never more.

### 6.9 Codex lessons for Circuit Agent

Adopt:

- a thread/turn/item protocol with generated bindings;
- append-only events plus query projections;
- centralized policy/approval/sandbox orchestration;
- OS-enforced local isolation and protected metadata paths;
- a headless JSONL contract with clean stdout/stderr separation;
- hierarchical repository instructions;
- durable steering, interrupt, resume, and fork semantics;
- subagents as policy-inheriting child sessions.

Do not copy uncritically:

- a Rust-wide implementation merely because Codex is written in Rust;
- the full product protocol before Circuit Agent's minimum domain is specified;
- any sandbox claim without platform-specific verification and adversarial tests.

## 7. Essential feature matrix

Legend: **core** means necessary for a trustworthy general coding agent; **advanced** means high-value after the core is stable; **product** means dependent on the chosen user experience.

| Capability | OpenCode | Cline | Codex | Priority for Circuit Agent |
| --- | --- | --- | --- | --- |
| Explicit agent/tool loop | Yes | Yes | Yes | Core |
| Provider-neutral event normalization | Yes | Yes | Yes | Core |
| Streaming and cancellation | Yes | Yes | Yes | Core |
| Capability-enforced plan mode | Yes | Yes | Yes | Core |
| Exact resumable approvals | Yes/partial by scope | Host callback and policy | Strong action-aware path | Core |
| OS-enforced local sandbox | Not the central guarantee | Approval/checkpoint centered | Strong platform layer | Core for local shell |
| Context compaction | Yes | Yes | Yes | Core |
| Durable session resume | Yes | Yes | Yes | Core |
| Checkpoint/revert | Git snapshots | Shadow Git | Patch/session facilities | Core |
| Hierarchical repo instructions | Yes | Rules/instructions | Yes | Core |
| Headless machine protocol | Server/SDK | CLI/SDK | JSONL app server/exec | Core |
| Cost and budget accounting | Model metadata/cost | Usage oriented | Token/usage oriented | Existing differentiator; core |
| Local-currency presentation | No central equivalent | No central equivalent | No central equivalent | Existing differentiator; core |
| Skills and rules | Yes | Yes | Yes | Advanced |
| MCP | Yes | Yes | Yes | Advanced |
| Hooks/plugins | Yes | Yes | Yes | Advanced |
| LSP/formatters/diagnostics | Yes | IDE-integrated | Tool/client dependent | Advanced |
| Subagents | Yes | Yes | Yes | Advanced |
| Worktree/isolation per task | Supported workflows | Related workflows | Supported workflows | Advanced |
| Background/scheduled agents | Yes | Yes | Yes/product-dependent | Product |
| IDE, desktop, web, connectors | Multiple | Strong IDE/connectors | CLI/app/IDE surfaces | Product |

The essential kernel is therefore smaller than the union of their feature lists:

1. canonical protocol and event model;
2. durable session and turn state;
3. provider-normalized streaming;
4. structured tool lifecycle;
5. policy, exact approval, and containment;
6. context provenance and compaction;
7. cancellation, recovery, and checkpoints;
8. budget/usage accounting;
9. tests and replay tooling.

Everything else should extend this kernel rather than bypass it.

## 8. Where the projects converge and differ

### 8.1 Convergence

All three have independently arrived at the same principles:

- the host, not the model, owns completion and safety decisions;
- modes restrict tools as well as prompts;
- sessions outlive individual provider calls;
- context must be actively managed;
- provider output needs normalization;
- extensions need stable tool and lifecycle contracts;
- recovery requires checkpoints or an event history;
- capable products expose one agent through multiple clients.

### 8.2 Meaningful differences

OpenCode is especially strong as an open, provider-flexible TypeScript agent/server ecosystem. Cline is especially strong in IDE workflow, SDK layering, checkpoints, and hub-and-spoke product design. Codex is especially strong in local sandbox enforcement, typed protocol boundaries, replayable execution, and systems-level runtime control.

Circuit Agent should combine these patterns selectively:

```text
OpenCode: provider/tool extensibility + instruction/context design
Cline:    SDK layering + session hub + checkpoints + Plan/Act UX
Codex:    protocol + policy/sandbox split + replay + local executor
Circuit:  monetary budgets + RWF/local currency + hosted job control
```

## 9. Circuit Agent current-state audit

The following reflects the repository at the research date. Concurrent work may improve individual cells; implementation agents must verify current code before modifying it.

| Area | Current state | Gap and next contract |
| --- | --- | --- |
| Bounded loop | Implemented in `BoundedAgentRuntime` | Move lifecycle to canonical turn/item events; make all continuations resumable |
| Tool budgets | Implemented | Persist reservations and per-call settlement in the event stream |
| RWF/model accounting | Strong foundation | Account for compaction, summaries, retries, and child agents; preserve source exchange rate and timestamp |
| Local currency | Being expanded across web/CLI | Keep ledger authoritative in RWF; store display currency, locale, rate source/time separately |
| Plan/build/auto modes | Partial and useful | Express as versioned capability/policy profiles shared by web, CLI, and hosted runs |
| Approval | Action-scoped for Nova CLI | Exact SHA-256 action digests and durable request/decision events are implemented; deferred cross-process approval resumption still remains |
| Approval UX | Web/CLI paths exist | CLI now distinguishes rejection from pending approval; expiration and externally resumed decision commands remain |
| Local shell | Bounded hybrid executor | Ordinary commands use direct argv; explicit shell syntax uses the shell only after exact-action approval; an OS sandbox and environment/network profiles remain |
| E2B/Docker | Implemented providers | Normalize them behind the same executor result and policy contract as local execution |
| Streaming | Runtime stream plus protocol journal | Durable events have protocol version, sequence, and hash-chain replay; deltas remain intentionally ephemeral and reconnect cursors remain |
| Session persistence | Atomic v2 snapshots plus JSONL journal | Checksums, locks, optimistic revisions, atomic rename, truncated-tail recovery, and conflict rejection are implemented; SQLite index/fork/archive remain |
| Conversation history | Implemented in the shared runtime | Native structured messages and tool pairs cross CLI turns; transcript validation rejects orphaned or unresolved calls |
| Compaction | Billable and structurally bounded | Model usage is now charged to the same turn/session budget; richer source-range metadata and replaceable summary revisions remain |
| Checkpoints | Private Git index | Persist checkpoint metadata and event linkage; support code-only, conversation-only, and combined restore |
| Instructions | Root-to-CWD hierarchy implemented | Overrides, hashes, deep-first size budgeting, and per-turn refresh are implemented; dynamic discovery during nested file reads remains |
| Tool registry | Useful built-ins | Add typed JSON schemas, versioning, effect classification, cancellation, deterministic result envelopes |
| Permissions | Capability scope exists | Centralize policy order; add path, command, network, credential, external-write, and spend dimensions |
| Network policy | Provider-specific/ad hoc | Add domain/method policy and audited network broker for local execution |
| App server | Missing locally | Add one session-owning daemon/service used by TUI, headless CLI, IDE, and tests |
| Headless protocol | Versioned internal narrow waist | Protocol/event types are implemented in core; a dedicated app-server transport and strict stdout/stderr headless contract remain |
| MCP/skills/hooks | Hosted pieces, not unified in Nova CLI | Add after protocol/security; require declared permissions and provenance |
| Subagents | Hosted delegation concepts | Add child sessions, budget attenuation, task IDs, mailboxes, cancellation, and workspace isolation |
| LSP/formatter | Missing from core | Add diagnostic and formatting tools after stable executor/tool schemas |
| Evaluation | Unit tests exist | Add transcript replay, provider VCR, fault injection, policy adversarial tests, and golden event traces |

### 9.1 Highest-risk correctness gaps

Before expanding the feature list, resolve these:

1. **Approval resumption:** a pending tool call must survive client disconnect or process restart and execute at most once after an idempotent approval.
2. **Action-scoped authorization:** approving `run_command` once must not approve arbitrary future commands.
3. **Local shell containment:** quoting and prompt policy cannot substitute for OS enforcement.
4. **Native history:** flattening structured history harms tool-call integrity and provider caching.
5. **Complete accounting:** all model calls, including compaction and retry, must debit the same authoritative budget.
6. **Atomic persistence:** interrupted writes must not destroy the only session copy.

### 9.2 Applied Nova CLI architecture baseline

The first optimized mixed-architecture slice is now implemented in the repository:

- `agent-runtime.ts` accepts and validates native structured history instead of flattening previous turns;
- `permissions.ts` binds standing choices to stable exact-action digests and safely discards legacy broad allows;
- `protocol.ts` defines legal turn transitions and a versioned, sequenced, hash-chained JSONL journal;
- `session.ts` writes schema-v2 checksummed snapshots through a lock, optimistic revision check, fsync, and atomic rename;
- `command.ts` uses a direct-exec fast path, retains an explicit shell path only when syntax requires it, bounds output, and terminates process trees;
- `prompt.ts` loads repository instruction files from broad to specific, records hashes, budgets deeper rules first, and refreshes them every turn;
- compaction usage is included in the same RWF and token accounting returned and persisted for the turn.

This is the TypeScript narrow waist that a future Rust `nova-exec` can implement without changing the model loop, policy semantics, session format, or clients. Remaining work should extend these contracts rather than create parallel CLI-only behavior.

## 10. Target architecture

### 10.1 Package boundaries

Evolve toward these logical packages. They can begin as folders and become packages only when dependency boundaries are proven.

```text
@circuit-nova/protocol
  versioned schemas, generated types, JSON-RPC methods, event envelopes

@circuit-nova/agent-kernel
  turn state machine, context assembly, model normalization, compaction

@circuit-nova/policy
  capabilities, approval rules, action digests, spend/network/filesystem policy

@circuit-nova/executor
  TypeScript interface and local/E2B/Docker adapters

@circuit-nova/session-store
  JSONL event log, SQLite projection, migrations, checkpoints

@circuit-nova/app-server
  session ownership, subscriptions, JSON-RPC transport, capability brokerage

@circuit-nova/nova-cli
  TUI and headless client only; no private duplicate agent loop
```

Dependency direction must be one-way: clients depend on protocol; app server depends on kernel/store/policy; the kernel depends on protocol abstractions, never on a UI.

### 10.2 Canonical domain types

At minimum define:

```ts
type Thread = {
  id: ThreadId;
  parentThreadId?: ThreadId;
  workspace: WorkspaceRef;
  createdAt: string;
  status: "active" | "archived";
  protocolVersion: number;
};

type Turn = {
  id: TurnId;
  threadId: ThreadId;
  status: "queued" | "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  mode: ModeSnapshot;
  budget: BudgetSnapshot;
  contextRevision: string;
};

type Item =
  | UserMessageItem
  | AssistantMessageItem
  | ReasoningItem
  | ToolCallItem
  | ToolResultItem
  | ApprovalItem
  | ContextSummaryItem
  | CheckpointItem
  | VerificationItem;

type EventEnvelope<T> = {
  protocolVersion: number;
  eventId: string;
  sequence: number;
  threadId: ThreadId;
  turnId?: TurnId;
  timestamp: string;
  causationId?: string;
  correlationId?: string;
  payload: T;
};
```

IDs must be stable across retries. Every mutating command requires an idempotency key. Event schemas are additive within a protocol version; breaking changes require migration logic.

### 10.3 Turn state machine

```text
queued -> assembling_context -> sampling -> handling_tool
                                      |          |
                                      |          +-> waiting_approval
                                      |                    |
                                      |                    +-> handling_tool
                                      |
                                      +-> compacting -> sampling
                                      +-> waiting_input -> sampling
                                      +-> verifying -> completed

Any active state -> cancelling -> cancelled
Any active state -> failed (with a resumable or terminal classification)
```

Illegal transitions must be rejected by the store, not tolerated by clients. “Needs approval” is a durable state, not a return value that discards the runtime stack.

### 10.4 Agent-loop algorithm

```ts
while (!turn.isTerminal) {
  assertLease(turn);
  ingestSteeringAndDecisions();
  recoverIncompleteItems();

  if (contextWouldOverflow()) {
    await runBillableCompaction();
    continue;
  }

  const context = assembleContextWithProvenance();
  const tools = registry.resolve(effectiveCapabilitiesAndPolicy());
  const response = await model.stream(context, tools, signal);

  for await (const event of normalize(response)) {
    append(event);
    if (event.isToolCall) await routeToolCall(event);
  }

  if (hasPendingApprovalOrInput()) continue;
  if (requiresVerification()) await verify();
  decideContinueCompactRetryOrComplete();
}
```

No tool may execute directly from a provider callback. First append the proposed call, normalize it, derive policy, and establish its idempotency key.

### 10.5 Context assembly and provenance

Context should be constructed from typed sections:

1. platform safety and runtime facts;
2. product/agent mode instructions;
3. repository instructions from root to working directory;
4. selected skills with source/version;
5. workspace and Git state;
6. compacted history plus preserved recent items;
7. current user input and queued steering;
8. available tool schemas;
9. current money, token, time, and tool budgets.

Each section records token estimate, source, priority, hash, and inclusion reason. Context budgeting should be deterministic enough to reproduce from an event log.

Compaction must:

- operate only at safe item boundaries;
- never leave a tool call without its result or pending state;
- preserve user constraints verbatim where necessary;
- preserve modified-file inventory, tests, errors, pending approvals, plan, and budget;
- emit source item ranges and the summarizer model/usage/cost;
- be replayable and replaceable if a later migration improves summaries.

### 10.6 Tool lifecycle

Every tool follows one pipeline:

```text
schema validation
-> canonical argument normalization
-> side-effect and resource classification
-> policy evaluation
-> budget reservation
-> approval decision or durable wait
-> executor selection and sandbox profile
-> checkpoint if required
-> execution with cancellation/deadline/output limits
-> result normalization
-> usage settlement
-> verification signal
-> event append
```

The result envelope should distinguish tool failure, policy denial, approval rejection, timeout, cancellation, sandbox denial, network denial, budget denial, and host failure. Do not collapse these into an arbitrary error string.

### 10.7 Approval semantics

An approval request should include:

```ts
type ApprovalRequest = {
  id: string;
  toolCallId: string;
  actionDigest: string;
  summary: string;
  normalizedArguments: unknown;
  effect: "read" | "workspace_write" | "external_write" | "credential" | "spend";
  workspaceScope: string[];
  networkTargets: string[];
  estimatedRwf?: number;
  policyVersion: string;
  expiresAt?: string;
};
```

Decisions are `approve_once`, `approve_scope`, `reject`, or `cancel`. A scoped approval stores the explicit rule produced, not a Boolean against the tool name. Before execution, recompute the digest and reject stale or modified requests. A transaction/compare-and-set must ensure at-most-once transition from approved to executing.

### 10.8 Persistence

For local sessions:

- append events to checksummed JSONL using flush/fsync policy proportional to risk;
- keep a SQLite projection for thread lists, search, usage totals, and pending approvals;
- write snapshots atomically using temporary file plus rename;
- use a lease or file lock per active thread;
- rebuild the projection from JSONL;
- include schema versions and tested migrations;
- encrypt or redact secrets and never record raw credential values.

For hosted sessions:

- model the same event envelope in Convex;
- use mutations for idempotent state transitions;
- use durable scheduled work for retries/timeouts;
- retain a client cursor for reconnect/replay;
- keep ledger mutations authoritative and transactionally linked to usage events.

### 10.9 App-server surface

A minimal JSON-RPC surface is enough:

```text
initialize
thread/start, thread/resume, thread/fork, thread/archive, thread/list
turn/start, turn/steer, turn/interrupt, turn/resume
approval/decide, approval/list
checkpoint/list, checkpoint/restore
config/get, config/set
model/list, tool/list, skill/list
event/subscribe, event/replay
```

The local transport can begin with JSONL over stdio. Add Unix sockets/named pipes only when session survival or multiple clients require them. Generate TypeScript types and JSON Schema from one protocol definition. Use bounded queues and explicit slow-consumer behavior.

### 10.10 Skills, hooks, plugins, and MCP

Add these only after the policy and protocol foundation:

- **Skill:** versioned context/instructions plus optional declared resources; no code execution by default.
- **Hook:** lifecycle callback with declared input/output schema, timeout, failure policy, and permissions.
- **Plugin:** packaged collection of skills/hooks/tools/config with a manifest and trust decision.
- **MCP server:** external capability provider with per-server tool allowlist, credential boundary, transport limits, and audit events.

Installation permission and runtime permission are separate. A plugin update that changes declared permissions requires renewed consent.

### 10.11 Subagents and workspaces

A child agent is a child thread with:

- parent/child and task identifiers;
- an explicit objective and completion contract;
- attenuated capabilities, paths, network access, time, tool calls, and RWF;
- its own context and event stream;
- a mailbox for progress and final results;
- cancellation and resume behavior;
- an optional isolated Git worktree or sandbox workspace.

Concurrent edits require ownership rules. Default to separate worktrees for mutating children. A parent should merge or apply a child's patch only after conflict and verification checks.

### 10.12 Observability and cost

Record structured metrics without exposing secrets:

- provider/model/request ID and latency stages;
- input, cached, output, reasoning, and compaction tokens;
- estimated and settled RWF plus display-currency conversion metadata;
- tool queue, approval wait, execution, and verification durations;
- retries classified by provider, policy, sandbox, network, or application cause;
- context composition and compaction ratios;
- turn result and stop reason.

Money invariants belong in tests: reserved amount is never negative; settled usage never disappears; retries and compaction are charged once; display-currency rounding never changes the RWF ledger.

## 11. Should Circuit Agent use Rust?

### 11.1 What Rust would genuinely improve

Rust is valuable where Circuit Agent must control untrusted or long-running local processes:

- one small native executable with low idle overhead;
- reliable subprocess trees, signals, PTYs, cancellation, and output backpressure;
- memory-safe parsing at a security boundary;
- explicit concurrency without a Node event-loop bottleneck under many streams;
- platform adapters for filesystem policy and sandbox mechanisms;
- resource controls, environment filtering, and descriptor/handle ownership;
- easier distribution of an execution daemon without requiring a Node runtime.

Codex demonstrates that Rust can support a large portable local-agent runtime and standalone CLI. That is evidence of feasibility, not evidence that every Circuit Agent layer benefits from rewriting.

### 11.2 What Rust will not materially improve

Rust will not make model inference, network round trips, or human approval substantially faster. Those dominate most agent turns. It will not automatically produce a secure sandbox: OS-specific policies, correct process containment, network mediation, tests, and maintenance do that. It also does not solve protocol design, context quality, approval semantics, or durable accounting.

### 11.3 Options

| Option | Benefits | Costs and risks | Decision |
| --- | --- | --- | --- |
| TypeScript only | Fastest delivery, shared types, current team fit | Harder native sandbox/process control; Node runtime distribution | Acceptable short term if local shell is restricted |
| Full Rust rewrite | Single systems stack; strongest native control potential | High rewrite risk; duplicates working Convex/provider/UI code; slower product iteration | Reject |
| Hybrid Rust executor | Native security/process benefits behind a small interface; preserves existing product | IPC/versioning, cross-compilation, signing, and two-language maintenance | Recommended, gated by a spike |

### 11.4 Recommended boundary: `nova-exec`

Keep in TypeScript:

- agent loop and model adapters;
- context, compaction, skills, and MCP coordination;
- monetary ledger and currency presentation;
- Convex jobs, schedules, and hosted state;
- app server initially, CLI/TUI, web, and IDE clients.

Consider implementing in Rust:

- argv-based process spawn and process-tree cancellation;
- PTY sessions and bounded streaming;
- filesystem capability broker;
- platform sandbox profile application;
- environment/credential filtering;
- network mediation hooks;
- CPU, memory, output, and wall-time enforcement;
- canonical execution audit facts.

Use a narrow versioned JSONL protocol over stdio first, or Unix sockets/named pipes if a persistent daemon is required. The TypeScript side sends a fully normalized, policy-approved request; Rust applies the physical constraint and returns structured events. The Rust process must never decide product billing or silently broaden a capability.

Example boundary:

```ts
type ExecRequest = {
  version: 1;
  requestId: string;
  executable: string;
  argv: string[];
  cwd: string;
  envAllowlist: string[];
  filesystem: { read: string[]; write: string[] };
  network: { mode: "none" | "allowlist"; hosts: string[] };
  limits: { wallMs: number; outputBytes: number; memoryBytes?: number };
};
```

Do not use WebAssembly as the main OS sandbox for arbitrary repository commands. WASM can isolate tools compiled for WASI, but normal compilers, package managers, shells, and project scripts require host process and filesystem mediation.

### 11.5 Rust adoption gates

Build the sidecar only if a two-week spike proves all of the following on supported platforms:

1. process-tree cancellation leaves no child behind;
2. filesystem deny tests prevent writes outside allowed roots;
3. network-disabled tests fail closed;
4. PTY throughput and output limits outperform or simplify the Node path;
5. cold start and idle memory meet packaging targets;
6. protocol compatibility and crash recovery tests pass;
7. CI can cross-build, sign, checksum, and update binaries;
8. the team accepts ownership of platform-specific sandbox code.

If these gates fail, keep the executor in TypeScript and use proven external isolation such as E2B/Docker while reducing the privilege of local mode.

## 12. Implementation roadmap

Each phase must leave the repository usable and include migrations when it changes stored state.

### Phase 0: invariants and protocol skeleton

Deliver:

- protocol package with versioned Thread, Turn, Item, Event, ToolSpec, Approval, Budget, and PermissionProfile schemas;
- written state-transition table;
- canonical IDs, sequence rules, and idempotency keys;
- golden JSON fixtures and compatibility tests.

Accept when malformed events and illegal transitions fail deterministically, fixtures round-trip, and web/CLI consume the same generated types.

### Phase 1: correctness repairs in the current runtime

Deliver:

- durable exact tool-call approval and same-turn resumption;
- action-digest decisions and scoped standing rules;
- native structured history instead of objective-string flattening;
- compaction/retry usage included in budget settlement;
- atomic/versioned CLI session persistence;
- argv-aware local command execution where possible; clearly restrict unsafe shell fallback.

Accept with restart-during-approval, duplicate-decision, compaction-billing, corrupted-session, cancellation, and command-argument tests.

### Phase 2: event store and app server

Deliver:

- append-only local JSONL store and rebuildable SQLite projection;
- session-owning app server over JSONL stdio;
- start/resume/fork/archive and turn start/steer/interrupt;
- replay cursor and reconnect semantics;
- TUI as a client of the server, not a parallel runtime.

Accept when killing and restarting the client does not kill or corrupt the owned session, replay reconstructs identical projections, and headless stdout parses as JSONL.

### Phase 3: context and repository intelligence

Deliver:

- root-to-CWD `AGENTS.md`/override discovery with provenance and limits;
- deterministic context assembler and debug view;
- structurally safe compaction artifacts;
- workspace/Git world-state snapshots;
- diagnostic, formatter, and optional LSP tools.

Accept with nested-scope precedence tests, token-budget golden tests, tool-pair preservation, and context reproduction from logged inputs.

### Phase 4: policy, containment, and Rust spike

Deliver:

- centralized policy -> approval -> sandbox -> execute ordering;
- filesystem, network, command, environment, external-write, credential, and spend dimensions;
- protected metadata paths;
- adversarial local-executor suite;
- `nova-exec` spike and written gate results.

Accept only when denied actions fail physically as well as logically. Decide Rust adoption from measurements, not preference.

### Phase 5: extension platform

Deliver:

- skill manifest and provenance;
- typed lifecycle hooks;
- MCP client with per-server policy;
- plugin manifest, install-time permission review, version pinning, and revocation;
- tool search/deferred exposure if tool count warrants it.

Accept with malicious/slow extension tests, timeout behavior, permission-change re-consent, secret redaction, and deterministic disable/uninstall.

### Phase 6: client completeness

Deliver:

- polished TUI approval, diff, cost, location/currency, and checkpoint flows;
- headless `--json`/JSONL mode with stable exit codes;
- IDE client only after protocol stability;
- shared configuration precedence and diagnostics.

Accept when the same recorded turn renders consistently across TUI, headless, and web, with RWF ledger values and local-currency displays agreeing.

### Phase 7: subagents and workspace isolation

Deliver:

- child-thread protocol, mailboxes, wait/cancel/resume;
- budget and capability attenuation;
- worktree or sandbox isolation for concurrent mutations;
- deterministic child result/patch handoff;
- depth, fan-out, and aggregate spend limits.

Accept with conflicting-edit tests, parent cancellation propagation, child crash recovery, no privilege amplification, and exact aggregate billing.

### Phase 8: hardening and evaluations

Deliver:

- provider-recording/replay harness with redaction;
- fault injection at every durable boundary;
- security regression suite;
- benchmark corpus and release gates;
- migration, rollback, telemetry, and incident runbooks.

Accept when releases publish an evaluation report and failures are attributable from events without reproducing against a live paid model.

## 13. Test and evaluation strategy

### 13.1 Unit and contract tests

Test protocol parsing, state transitions, action digests, permission precedence, path normalization, command parsing, budget arithmetic, FX display conversion, event migration, context selection, compaction boundaries, and provider event normalization.

Use property-based tests for:

- money never becoming negative or NaN;
- path escapes and symlink traversal;
- event replay producing the same projection;
- arbitrary cancellation points preserving a valid state;
- compaction preserving required item relationships.

### 13.2 Transcript and provider tests

Record redacted provider streams at the adapter boundary. Replay cases for malformed tool arguments, duplicate tool IDs, early stop, rate limit, timeout, context overflow, partial stream, cached-token reporting, refusal, and model switch. The kernel tests should not require paid network calls.

### 13.3 Integration tests

Run the same scenarios against local, Docker, and E2B executors:

- read/search/edit/verify a fixture repository;
- approval then reconnect then decide;
- reject and revise a proposed command;
- interrupt a process tree;
- overflow output and context limits;
- restore code only and restore code plus conversation;
- crash between proposed, approved, executing, and completed states;
- exhaust RWF, tool-call, token, and wall-time budgets.

### 13.4 Security tests

Threat model these actors:

- malicious repository content and instruction injection;
- malicious dependency scripts;
- compromised MCP/plugin/skill;
- model generating deceptive approval text;
- another local process tampering with session files;
- symlink/path traversal and workspace escape;
- credential exfiltration over command output or network;
- denial of service through output, subprocesses, files, or tool loops;
- approval replay and confused-deputy attacks;
- currency/price manipulation or stale rate misuse.

Security acceptance must verify enforcement, not only returned errors. For example, a denied network request should be observed failing at the containment layer.

### 13.5 Agent-quality evaluations

Maintain a versioned corpus covering repository navigation, localized fixes, multi-file refactors, test diagnosis, dependency changes, Git conflict handling, plan-only work, human clarification, approval decisions, and concurrent tasks. Score:

- task correctness and tests passed;
- unnecessary edits and regressions;
- tool calls, tokens, elapsed time, and RWF;
- approval precision and user interruptions;
- recovery after injected faults;
- summary/compaction fidelity;
- policy violations and sandbox escapes, which are release blockers.

## 14. Definition of done for the implementation agent

A feature is not complete because a UI control exists or a happy-path demo succeeds. For every roadmap item, the coding agent must:

1. inspect the current worktree and concurrent changes before editing;
2. state the invariant and affected protocol/state transitions;
3. update shared schemas before client-specific representations;
4. add migration or backward compatibility for persisted state;
5. route side effects through policy, approval, budget, and executor layers;
6. include cancellation, timeout, retry, restart, and idempotency behavior;
7. add tests at the lowest useful layer plus one end-to-end path;
8. verify local and hosted behavior separately where both exist;
9. document security and monetary consequences;
10. report exact tests run and any unverified environment boundary;
11. avoid modifying unrelated dirty files owned by another agent;
12. update this guide's current-state table when the contract changes.

The release-level definition of done is:

- one canonical protocol drives CLI, web, and automation;
- pending work survives restarts and reconnects;
- approvals are exact, auditable, expiring, idempotent, and resumable;
- local effects are physically constrained by tested policy;
- all model/tool/compaction/retry spend settles once in the RWF ledger;
- local currency is presentation metadata, never a second source of monetary truth;
- context and instructions are inspectable and reproducible;
- checkpoints and event replay recover from partial failure;
- headless output is stable for machines;
- extensions and child agents cannot amplify authority;
- evaluation and security gates prevent regression.

## 15. Primary source map

### OpenCode

- [Repository and license](https://github.com/anomalyco/opencode/tree/38e10eb1408feb700021b8e8766fb0ab41bf84e2)
- [Session prompt loop](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/prompt.ts)
- [Agent profiles](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/agent/agent.ts)
- [Permission engine](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/permission/index.ts)
- [LLM/provider stream layer](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/llm.ts)
- [Instruction discovery](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/instruction.ts)
- [Compaction](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/session/compaction.ts)
- [Task/subagent tool](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/tool/task.ts)
- [Snapshot implementation](https://github.com/anomalyco/opencode/blob/38e10eb1408feb700021b8e8766fb0ab41bf84e2/packages/opencode/src/snapshot/index.ts)

### Cline

- [Repository and license](https://github.com/cline/cline/tree/45403900964a74aa5ae3683a0e61b535600b97e0)
- [Agent runtime](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/sdk/packages/agents/src/agent-runtime.ts)
- [Session runtime orchestrator](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/sdk/packages/core/src/runtime/orchestration/session-runtime-orchestrator.ts)
- [Runtime tool presets](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/sdk/packages/core/src/extensions/tools/runtime.ts)
- [Tool approval path](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/sdk/packages/core/src/runtime/tools/tool-approval.ts)
- [Plan and Act documentation](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/docs/core-workflows/plan-and-act.mdx)
- [Checkpoint documentation](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/docs/core-workflows/checkpoints.mdx)
- [SDK architecture overview](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/docs/sdk/architecture/overview.mdx)
- [Hub-and-spoke architecture](https://github.com/cline/cline/blob/45403900964a74aa5ae3683a0e61b535600b97e0/docs/sdk/architecture/hub-spoke.mdx)

### OpenAI Codex

- [Repository and license](https://github.com/openai/codex/tree/266c6920d9b82fe4d68959529565256b12a9be99)
- [Turn lifecycle](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/core/src/session/turn.rs)
- [Tool registry](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/core/src/tools/registry.rs)
- [Tool orchestrator](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/core/src/tools/orchestrator.rs)
- [Approval implementation](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/core/src/tools/approvals.rs)
- [Sandbox manager](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/sandboxing/src/manager.rs)
- [AGENTS.md implementation](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/core/src/agents_md.rs)
- [Rollout recorder](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/rollout/src/recorder.rs)
- [App server README](https://github.com/openai/codex/blob/266c6920d9b82fe4d68959529565256b12a9be99/codex-rs/app-server/README.md)
- [Official agent approvals and security guide](https://learn.chatgpt.com/docs/security)
- [Official App Server guide](https://learn.chatgpt.com/docs/app-server)
- [Official AGENTS.md guide](https://learn.chatgpt.com/docs/agent-configuration/agents-md)
- [Official Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli)

## 16. Final recommendation

Do not begin by adding every visible OpenCode, Cline, or Codex feature. First turn Circuit Agent's existing loop, approvals, budgets, checkpoints, and CLI into one durable protocol-driven system. That work unlocks the visible features safely.

The recommended order is:

```text
protocol and invariants
-> approval/accounting/persistence correctness
-> event store and app server
-> context and repository intelligence
-> centralized policy and contained execution
-> measured Rust executor decision
-> extensions and richer clients
-> subagents and worktree concurrency
-> continuous evaluation and hardening
```

Rust should be a scalpel: use it for the local execution boundary if measurements and containment tests justify it. TypeScript should remain the product's orchestration language unless a future bottleneck is demonstrated with profiling. This preserves Circuit Agent's delivery speed while making its most dangerous boundary substantially stronger.
