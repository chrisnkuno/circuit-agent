# tooling

Everything that builds, releases, measures or maintains this repository. None of it ships: no
package here is published, and nothing in `packages/`, `apps/` or `services/` may import from it.

Scripts are grouped by **why you would run one**, not by what they touch. Each is exposed as a root
`package.json` script so nobody has to remember a path.

| Bucket | What it is for | Entry points |
| --- | --- | --- |
| `build/` | Turning source into the artifacts consumers get | `bun run build:packages`, `build:cli`, `build:templates`, `verify:templates` |
| `release/` | Packaging and publishing the native state binaries | driven by `.github/workflows/native-state-release.yml` |
| `bench/` | Measuring performance against a committed baseline | `bun run bench`, `bun run optimize:map` |
| `reliability/` | The scheduled evidence pipeline: run, score, promote, publish | `bun run reliability:*`, and `.github/workflows/nova-reliability.yml` |
| `defender/` | Researching, signing and distributing the Defensive Brain feed | `bun run defender:refresh`, `defender:feed-key`, `bench:defender-feed` |

## Rules

- **A script resolves the repository root explicitly**, from `import.meta.dirname`, never from
  `process.cwd()` and never by assuming it was launched from the root. Regrouping these files into
  buckets broke every script that computed the root as `dirname/..`; that is exactly the failure
  the rule prevents.
- **A script with real logic has a test next to it.** `defender-refresh-policy.test.ts` and
  `reliability-record-error.test.ts` are the pattern — the policy decision is a pure function, and
  the function is what gets tested.
- **Shared code is imported by package name** (`@circuit-nova/nova-core/...`). Bun resolves it to
  source through the root `tsconfig.json` paths, so a tooling script never needs a build first.
- **A new script gets a root `package.json` alias.** An undiscoverable script is one that stops
  being run, and a pipeline step nobody runs is a pipeline step that quietly rots.
