# apps

Deployable products built on `packages/`. Members of the root Bun workspace, so they depend on the
shared packages with `workspace:*` and are installed from the repository root.

| App | What it is |
| --- | --- |
| [`web/`](web/) | The hosted control plane: the Next.js site, its Convex backend, and the durable dispatcher that runs budgeted, approval-gated agent work. |

**Nova Desktop is not here.** The Tauri app was split out to
[chrisnkuno/nova-desktop](https://github.com/chrisnkuno/nova-desktop), where it consumes
`@circuit-nova/nova-core` from npm like any other dependency.

An app may depend on `packages/*`; nothing in `packages/*` may depend on an app.
