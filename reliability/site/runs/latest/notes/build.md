# Build run

All 6 tests pass. Done.

**`slugger/slug.mjs`** — exports `slugify(text)`, implemented as the contract in order:
- `String(text)` coerces input
- `.normalize('NFKD')` + stripping `[\u0300-\u036f]` combining marks (so `Café déjà vu` → `cafe-deja-vu`)
- `.toLowerCase()`
- `.replace(/[^a-z0-9]+/g, '-')` collapses every run of non-ASCII-alphanumeric characters into one hyphen
- `.replace(/^-+|-+$/g, '')` trims edge hyphens (and guarantees the empty input returns `''`)

**`slugger/slug.test.mjs`** — `node:test` with exactly the six requested cases: `'Hello, World!'` → `'hello-world'`, `'Café déjà vu'` → `'cafe-deja-vu'`, `'Version 2.0'` → `'version-2-0'`, repeated separators, empty input, and idempotence.

Result: `node --test` in `slugger/` → **6/6 pass, 0 fail**. The project contains only those two files (verified against the empty workspace).
