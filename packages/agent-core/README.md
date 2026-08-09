# @circuit-nova/nova-core

The provider-neutral coding-agent core behind [`@circuit-nova/nova-cli`](https://www.npmjs.com/package/@circuit-nova/nova-cli): a bounded tool-use runtime, local and sandboxed workspace backends, model adapters for Anthropic/OpenAI-compatible providers, and multi-currency cost accounting. Use this package directly if you're embedding an agent loop in your own tool rather than running Nova's CLI.

```bash
npm install @circuit-nova/nova-core
```

## What's in it

- **`BoundedAgentRuntime`** — a tool-use loop that turns a list of `AgentTool`s and an `AgentTurnProvider` into a bounded, event-driven run. Emits `assistant_delta` events as the model streams text, so a caller can render output live instead of waiting for a full turn.
- **Model adapters** — `resolveProvider()` / `PROVIDERS` give you Anthropic, OpenAI, and OpenAI-compatible (CircuitNotion) turn providers behind one interface, each streaming natively rather than buffering.
- **`NovaAgent`** — the higher-level agent Nova's CLI runs: wires the runtime to a workspace, a permission ledger, checkpoints, and a todo list.
- **Workspace backends** — `LocalWorkspace` runs tools against a real directory on disk; `E2BWorkspace` runs the same tool set inside an isolated [E2B](https://e2b.dev) sandbox (`e2b` is an optional peer dependency — only required if you use it).
- **`PermissionLedger`** — per-tool approval state (`plan` / `build` / `auto` modes), so effectful calls can require confirmation without the caller re-implementing that policy.
- **`CheckpointStore`** — snapshots a workspace into a private git index per turn, so a caller can offer real undo (reverts both edited and agent-created files).
- **`CostLedger`** and `money.ts` — currency-aware token pricing (`priceUsage`, `tokenPrices`, `convertTo`, `formatMoney`) with explicit, dated FX rates rather than implicit conversion. An unpriced model reports "cost unknown" instead of showing zero.

## Example

```ts
import { BoundedAgentRuntime, resolveProvider, type AgentTool } from "@circuit-nova/nova-core";

const provider = resolveProvider("anthropic", { apiKey: process.env.ANTHROPIC_API_KEY! });
const runtime = new BoundedAgentRuntime({ provider, tools: myTools /* AgentTool[] */ });

for await (const event of runtime.execute({ messages: [{ role: "user", content: "list the files here" }] })) {
  if (event.type === "assistant_delta") process.stdout.write(event.text);
}
```

## Optional peer dependencies

Both are lazy-loaded — importing this package doesn't require either unless you actually use the adapter that needs it:

- `@anthropic-ai/sdk` (`>=0.30.0`) — required only for the Anthropic provider.
- `e2b` (`>=2.0.0`) — required only for `E2BWorkspace`.

## Requirements

Node 20 or newer.

MIT licensed.
