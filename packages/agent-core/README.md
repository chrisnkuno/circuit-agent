# @circuit-nova/nova-core

The provider-neutral coding-agent core behind [`@circuit-nova/nova-cli`](https://www.npmjs.com/package/@circuit-nova/nova-cli): a bounded tool-use runtime, local and sandboxed workspace backends, model adapters for Anthropic/OpenAI-compatible providers, and multi-currency cost accounting. Use this package directly if you're embedding an agent loop in your own tool rather than running Nova's CLI.

```bash
npm install @circuit-nova/nova-core
```

## What's in it

- **`BoundedAgentRuntime`** — a tool-use loop that turns a list of `AgentTool`s and an `AgentTurnProvider` into a bounded, event-driven run. Emits `assistant_delta` events as the model streams text, so a caller can render output live instead of waiting for a full turn.
- **Model adapters** — `resolveProvider()` / `PROVIDERS` give you Anthropic, OpenAI and arbitrary OpenAI-compatible endpoints, CircuitNotion, and local Ollama behind one interface. CircuitNotion defaults to `circuit-2-turbo`.
- **`NovaAgent`** — the higher-level agent Nova's CLI runs: wires the runtime to a workspace, a permission ledger, checkpoints, and a todo list.
- **Workspace backends** — `LocalWorkspace` runs against a real directory; `E2BWorkspace` and `DockerWorkspace` run the same contracts in remote or local isolation (`e2b` is optional).
- **`PermissionLedger`** — per-tool approval state for `plan`, `build`, `auto`, and `defender`, so callers do not reimplement the safety posture.
- **`CheckpointStore`** — snapshots a workspace into a private git index per turn, so a caller can offer real undo (reverts both edited and agent-created files).
- **`CostLedger`** and `money.ts` — currency-aware token pricing (`priceUsage`, `tokenPrices`, `convertTo`, `formatMoney`) with explicit, dated FX rates rather than implicit conversion. An unpriced model reports "cost unknown" instead of showing zero.
- **Durable state** — integrity-checked JSON snapshots and hash-chained journals remain canonical; the optional `nova-state` sidecar provides rebuildable SQLite/FTS5 recall.
- **`scoreReliability`** — an evaluator for completion, verification, valid tools, token economy, estimate calibration, scope, and resumed state, with hard caps for false success and permission escalation.

## Example

```ts
import { resolveProvider } from "@circuit-nova/nova-core";

const resolved = resolveProvider(process.env, {
  provider: "openai",
  model: "cohere/north-mini-code:free",
});
if ("error" in resolved) throw new Error(resolved.error);

// Supply resolved.provider to BoundedAgentRuntime or NovaAgent. OPENAI_BASE_URL may point at an
// OpenAI-compatible endpoint; provider-reported usage remains the accounting truth.
```

## Upgrading to 0.5.0

Additive except for one resolution-order change. `^0.4.0` does not match `0.5.0`, so nothing picks this up by surprise.

- **`resolveProvider` now honours `NOVA_PROVIDER`.** With no explicit `provider` option, a valid, configured `NOVA_PROVIDER` in the environment wins over the previous "first configured provider in catalog order" rule. If you embed this package in a process where that variable is set for unrelated reasons, resolution changes; pass `provider` explicitly to pin it. An unset, unrecognised, or unconfigured value falls back to the old behaviour rather than erroring, so a stale setting can never stop a session starting.
- **`CostLedger.setDisplay(display, rates?)` is new.** Re-reads a session in another currency, converting spending already recorded rather than leaving it in the old one. Mirrors `setPrices` for the display side.

## Upgrading to 0.4.0

Four changes need an edit if you embed this package. `^0.3.0` deliberately does not match `0.4.0`, so nothing upgrades into these by surprise.

- **`createNovaTools` is now `async`.** It awaits externally-sourced tools (skills, MCP servers, plugins) before returning. `const tools = createNovaTools(…)` becomes `const tools = await createNovaTools(…)`.
- **`NovaWorkspace` gained two required members.** A custom implementation needs `listConfigFiles(prefix)` — files under a prefix, ignoring the ignored-directory list, `[]` when the directory is absent — and `commandPlatform`, the platform whose shell rules apply to commands it runs (`process.platform` for a local workspace, `"linux"` for anything containerised).
- **Discovery takes a workspace, not a root path.** `discoverSkillManifests`, `discoverPlugins`, `discoverMcpServers`, `loadLocalExternalTooling` and `HookRegistry.local` now receive a `NovaWorkspace`, which is what lets a `.nova` directory work in a sandbox rather than only on the host.
- **Stored approvals are void.** `APPROVAL_POLICY_VERSION` moved to `nova-approval-v2` because a tool's provenance now forms part of its action digest — a standing approval for a built-in `run_command` must not silently cover a same-named tool an MCP server starts offering. Persisted `allow_always` decisions from v1 are ignored and will be asked again once.

## Optional peer dependencies

Both are lazy-loaded — importing this package doesn't require either unless you actually use the adapter that needs it:

- `@anthropic-ai/sdk` (`>=0.30.0`) — required only for the Anthropic provider.
- `e2b` (`>=2.0.0`) — required only for `E2BWorkspace`.

## Requirements

Node 22.5 or newer.

MIT licensed.
