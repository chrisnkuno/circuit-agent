/**
 * The checklists behind DEFENDER mode.
 *
 * Each playbook is a curated, actionable list — what to actually look for and why it matters, not
 * a textbook chapter. A defender that recites OWASP categories at a user has produced a table of
 * contents, not a review; these exist so the model has the same concrete triggers a human security
 * reviewer carries in their head, named precisely enough to grep for.
 *
 * Deliberately markdown, not TypeScript-structured data like `guide.ts`'s topics: this content is
 * prose a person should be able to read, diff and extend on its own terms, and nothing here needs
 * the machine-checked cross-referencing `guide.ts` uses to keep a command table honest. One export
 * per category keeps a playbook reviewable and extendable on its own, and `DEFENDER_PLAYBOOKS`
 * below is only their concatenation for the system prompt.
 */

export const INJECTION_PLAYBOOK = `
## Injection

- **SQL/NoSQL**: string-built queries (concatenation, template literals, f-strings) instead of
  parameterized queries or an ORM's bound-parameter API. Grep for query-building near \`req.\`,
  \`params\`, \`query\`, or any user-controlled variable.
- **Command injection**: \`exec\`/\`spawn\`/\`system\`/backticks built from user input without an
  argument array (\`execFile\`, \`spawn(cmd, [args])\`) or without an allowlist of the command itself.
- **Template injection (SSTI)**: user input rendered through a template engine's raw/unescaped mode,
  or user input used to select *which* template to render.
- **Path traversal**: a filename, path segment, or archive-member path taken from user input and
  joined onto a base directory without resolving and checking it stays inside that directory
  (\`../../etc/passwd\`, a zip/tar entry with an absolute or \`../\` path).
- **XXE / unsafe deserialization**: an XML parser with external entities enabled, or a
  deserializer (pickle, YAML \`load\` instead of \`safe_load\`, Java \`ObjectInputStream\`,
  \`unserialize\`) fed data from outside the process.
- **Header/log injection**: user input written into an HTTP response header or a log line without
  stripping CR/LF, letting an attacker split the response or forge log entries.

**How to check it**: grep for the sink (the query call, the shell call, the template render, the
path join) and trace backward to its argument. A sink fed only by a literal or a value the server
itself generated is not a finding; one fed by anything reachable from a request, a file the server
reads, or a queue message is.
`.trim();

export const AUTH_SESSION_PLAYBOOK = `
## Authentication & session management

- **Password storage**: anything but a slow, salted hash (bcrypt, scrypt, argon2). MD5, SHA-1,
  SHA-256 alone, or a fixed/short salt are all findings.
- **Token comparison**: session tokens, API keys, HMAC signatures or password-reset tokens compared
  with \`==\`/\`===\`/\`.equals\` instead of a constant-time comparison — a timing side channel that
  lets an attacker recover the value byte by byte.
- **Session fixation**: a session id issued *before* login is still valid *after* login, instead of
  being rotated on privilege change.
- **Session/cookie flags**: cookies carrying a session or auth token missing \`HttpOnly\`, \`Secure\`,
  or a \`SameSite\` policy appropriate to the app (client-rendered SPA hitting a separate API domain
  is the one case \`SameSite=None\` is actually required, and then \`Secure\` is mandatory).
- **JWT handling**: \`alg: none\` accepted, the algorithm not pinned server-side (letting an RS256
  token be re-signed as HS256 using the public key as the HMAC secret), or the signature never
  actually verified before the claims are trusted.
- **Password reset / MFA**: a reset token that does not expire, is not single-use, or is
  predictable (sequential, timestamp-derived); an MFA flow whose second factor can be skipped by
  calling a later step directly.
- **Credential stuffing / brute force**: no rate limit or lockout on the login endpoint at all.

**How to check it**: find the login, session-creation, and token-verification code paths and read
them end to end — most findings here are "the check exists but a branch skips it," not "the check
is entirely missing."
`.trim();

export const ACCESS_CONTROL_PLAYBOOK = `
## Access control

- **IDOR (insecure direct object reference)**: an endpoint takes an id (\`/orders/:id\`,
  \`?userId=\`) and fetches or mutates the record by that id alone, with no check that the
  authenticated caller actually owns or is permitted to see it.
- **Missing function-level authorization**: an admin or privileged action reachable by any
  authenticated (or unauthenticated) request because the check exists on the UI but not on the
  endpoint itself.
- **Mass assignment**: a create/update endpoint that binds the whole request body onto a model,
  letting a caller set fields it should never control (\`role\`, \`isAdmin\`, \`price\`, \`ownerId\`).
- **Privilege escalation via client-trusted state**: a role, tenant id, or permission read from a
  cookie, header, or request body that the client controls, rather than derived server-side from
  the authenticated session.
- **CORS misconfiguration**: \`Access-Control-Allow-Origin: *\` (or a reflected origin) combined
  with \`Access-Control-Allow-Credentials: true\` — the combination that lets any site read
  authenticated responses on a victim's behalf.
- **Multi-tenancy leaks**: a query missing a \`WHERE tenant_id = ?\`/\`workspace_id = ?\` clause that
  every sibling query includes — the single most common way one customer sees another's data.

**How to check it**: for every endpoint that takes an id or identifier, ask "what stops caller A
from passing caller B's id?" If the answer is "nothing but the UI doesn't offer it," that is a
finding.
`.trim();

export const SECRETS_PLAYBOOK = `
## Secrets & credential hygiene

- **Hardcoded credentials**: API keys, database URLs with embedded passwords, private keys, or
  OAuth client secrets committed as string literals — not just in application code, but in test
  fixtures, seed scripts, CI config, and Dockerfiles (\`ENV\`/\`ARG\` with a real value).
  Recognizable shapes worth grepping for: \`AKIA[0-9A-Z]{16}\` (AWS access key), \`ghp_[A-Za-z0-9]{36}\`
  (GitHub token), \`sk-[A-Za-z0-9]{20,}\` (OpenAI/Anthropic-style key), \`-----BEGIN (RSA|EC|OPENSSH)
  PRIVATE KEY-----\`, \`xox[baprs]-[0-9A-Za-z-]+\` (Slack token), a JWT (\`eyJ...\` — decode it, it may
  itself embed a secret in a claim).
- **Secrets in history, not just HEAD**: a key that was committed and later removed is still live
  in git history and must be rotated, not just deleted from the current tree.
- **Client-exposed secrets**: a server-only secret bundled into frontend JS, a mobile app binary, or
  a public repository's CI logs (printed by an over-verbose build step).
- **.env handling**: a \`.env\` file that is not in \`.gitignore\`, or a \`.env.example\` that contains
  real values instead of placeholders.
- **Secret rotation and scope**: a key with far broader permissions than the one call site that uses
  it needs (an admin database credential used by a read-only reporting job).

**How to check it**: run \`scan_secrets\` first — it matches the shapes above deterministically and
masks whatever it finds, so its own report never puts a live credential in the transcript. It is a
pattern match, not proof: verify every finding by reading the surrounding code before reporting it
as real. Then check \`.gitignore\` actually covers every env/secret file the project uses. A scan
that only checks the current checkout misses history — say so explicitly rather than implying a
clean scan means a clean repo.
`.trim();

export const DEPENDENCIES_PLAYBOOK = `
## Dependencies & supply chain

- **Known-vulnerable versions**: run the ecosystem's own auditor and read its output rather than
  guessing from the manifest — \`npm audit\`/\`pnpm audit\`/\`yarn audit\` for Node, \`pip-audit\` or
  \`safety check\` for Python, \`cargo audit\` for Rust, \`govulncheck\` for Go, \`bundler-audit\` for
  Ruby. Report the actual CVE, the affected version range, and the fixed version — not just "some
  dependencies are outdated."
- **Unpinned/floating versions**: a lockfile that is missing entirely, or a manifest using \`^\`/\`*\`
  ranges for a security-sensitive dependency (an auth library, a crypto library) rather than an
  exact or narrowly-pinned version.
- **Typosquatting / install-time code execution**: a dependency name that is a near-miss of a
  popular package, or a \`postinstall\`/\`preinstall\` script in a dependency that runs arbitrary code
  at install time — worth a second look when it appears in a dependency added recently.
- **Abandoned or unmaintained packages**: a security-relevant dependency with no release in years
  and open, unpatched vulnerability reports.
- **License risk** (report, don't block on it): a copyleft license (GPL/AGPL) pulled into code that
  will be distributed, which is a legal question for the user, not a security one — flag it and
  move on.

**How to check it**: prefer the project's own audit tool output to reading changelogs by hand; it is
faster and it is what the project's own CI (if any) is checking. If no lockfile exists, say that
first — it undermines every other finding in this category, since "the vulnerable version" cannot
be pinned down without one.
`.trim();

export const CRYPTOGRAPHY_PLAYBOOK = `
## Cryptography misuse

- **Weak or broken primitives**: MD5 or SHA-1 used for anything security-relevant (not just
  passwords — also file-integrity checks meant to detect tampering), DES/3DES/RC4 for encryption,
  ECB mode for a block cipher (it leaks plaintext structure).
- **Hardcoded or derived-from-nothing keys/IVs**: an encryption key or initialization vector that is
  a string literal, a hash of a short/predictable value, or reused across every encryption call
  instead of freshly random per operation (a reused IV/nonce is often a complete break, not a
  weakness).
- **Home-grown crypto**: any custom implementation of encryption, signing, or key derivation instead
  of a vetted library — this is close to always a finding on its own, regardless of how it looks.
- **Insecure randomness**: \`Math.random()\`, \`rand()\`, or another non-cryptographic PRNG used to
  generate a token, session id, password-reset code, or key, instead of the platform's CSPRNG
  (\`crypto.randomBytes\`, \`secrets\` module, \`SecureRandom\`).
- **TLS configuration**: certificate validation disabled (\`rejectUnauthorized: false\`,
  \`verify=False\`, a custom trust-everything \`TrustManager\`) — almost always committed as a
  "temporary" fix for a local dev cert problem and then shipped.

**How to check it**: grep for the primitive names above and for \`random\` used near anything named
token/session/key/nonce/salt. A finding here is usually a one-line fix (swap the function), so
propose the exact replacement, not just the diagnosis.
`.trim();

export const IAC_CONTAINERS_PLAYBOOK = `
## Infrastructure-as-code & container hardening

- **Containers running as root**: a Dockerfile with no \`USER\` directive (defaults to root), or one
  that switches to a non-root user and then does something requiring root afterward.
- **Overly permissive base images and layers**: a base image pinned to \`latest\` rather than a
  digest or version tag, or a build that copies the whole build context (\`COPY . .\` before
  \`.dockerignore\` excludes secrets/\`.git\`/\`node_modules\`).
- **Secrets baked into image layers**: a secret passed as a build \`ARG\` or copied in and then
  deleted in a later layer — it is still present in the earlier layer and extractable with
  \`docker history\`/\`docker save\`.
- **Cloud IAM over-permissioning**: a Terraform/CloudFormation/Pulumi resource attached to a policy
  using \`*\` for actions or resources where a scoped policy would do, or a role trusted by too broad
  a principal.
- **Public-by-default storage**: a storage bucket, database security group, or object-storage ACL
  with a public-read or public-write policy that looks unintentional (no obvious CDN/static-site
  purpose).
- **Missing network segmentation**: a database or internal service security group open to
  \`0.0.0.0/0\` rather than scoped to the app tier that actually needs to reach it.
- **Kubernetes**: a pod spec with \`privileged: true\`, \`hostNetwork: true\`, or no
  \`resources.limits\`/\`securityContext\` at all; a \`Secret\` mounted more broadly than the one
  container that needs it.

**How to check it**: read the Dockerfile/compose file/IaC top to bottom once — most of this
category is visible in a single pass, not something that needs deep tracing like the code-level
categories above.
`.trim();

export const INPUT_VALIDATION_FUZZING_PLAYBOOK = `
## Input validation, fuzzing & invariant-based testing

Validation and testing are the same discipline pointed in two directions: one rejects bad input at
the boundary, the other proves the code behaves correctly across the input space rather than on
the one example that was hand-picked for it.

**Boundary validation**:
- Every value crossing a trust boundary (a request body, a query string, a file upload, an
  environment variable, a message off a queue) is checked for type, length, range and shape before
  use — not implicitly coerced and trusted.
- File uploads: content-type and magic bytes checked (not just the filename extension), a size
  cap enforced, and the file never executed or served from a location that lets it be requested as
  a script.
- Numeric input: integer-overflow and negative-value cases considered wherever a quantity feeds a
  loop bound, an allocation size, or a price/balance calculation.

**Invariant-based testing** — assert what must hold for *every* valid input, not one example:
- **Round-trip**: \`decode(encode(x)) == x\` for every serializer/parser pair in the project.
- **Idempotence**: calling the same operation twice with the same input produces the same result
  the second time as the first (critical for retried network calls and queue consumers).
- **Conservation**: a total that must balance before and after an operation (money moved between
  accounts, items moved between inventories) — assert the sum is unchanged, not just that each side
  looks plausible.
- **Ordering/monotonicity**: a value that must never decrease (a version counter, a timestamp used
  for ordering) or a sort that must remain stable under a documented tie-break rule.
- **Error-path invariants**: a malformed, oversized, empty, or wrong-type input must fail the same
  way every time — not sometimes throw, sometimes silently coerce, sometimes hang.

**Fuzzing** — when a function parses, deserializes, or otherwise transforms untrusted bytes/text:
- Identify the parsing/deserialization entry points first; those are where a fuzzer earns its
  keep, not business logic that only ever sees already-validated data.
- Use the ecosystem's property-based/fuzz tooling rather than hand-rolling one: \`fast-check\` or
  \`jsverify\` for JS/TS property tests, Python's \`hypothesis\`, Rust's \`cargo fuzz\`/\`proptest\`, Go's
  built-in \`testing/quick\` and native fuzzing (\`go test -fuzz\`), \`AFL++\`/\`libFuzzer\` for C/C++.
  Wire it into the project's existing test runner rather than adding a second one.
- Seed the corpus from real captured inputs (a saved request body, a real file the app parses) —
  a fuzzer starting from nothing spends most of its budget rediscovering syntax the seed would
  have given it for free.
- A crash, hang, or unbounded-memory input the fuzzer finds is a finding on its own, independent of
  whether it is exploitable yet — an unhandled panic on attacker-controlled input is a denial-of-
  service at minimum.

**How to check it**: for the invariant categories above, look for what tests already exist and
whether they assert a property or just one example value; propose the missing property test with a
concrete counterexample where you can construct one, not just "add more tests."
`.trim();

export const LOGGING_MONITORING_DETERRENCE_PLAYBOOK = `
## Logging, monitoring & deterrence

Detection and deterrence matter as much as prevention: a system that is merely hard to break into
is not the same as one that notices when someone tries, slows them down while they do, and leaves
a record afterward.

- **Security-relevant events actually logged**: authentication success and failure, authorization
  denials, password/email/MFA changes, admin actions, and any input rejected by a validation check
  worth knowing was attempted. If none of these produce a log line, say so — it is the single
  biggest gap in most projects reviewed here.
- **Logs safe to keep**: no password, full token, credit-card number, or other secret ever written
  to a log line (including in a stack trace or an error message that echoes the request body).
- **Rate limiting as deterrence, not just protection**: login, password-reset, and any expensive or
  enumerable endpoint (an endpoint whose response differs for "user exists" vs "user does not")
  should be rate-limited per account and per IP — this is what turns a five-minute brute-force
  attempt into a multi-day one an attacker abandons.
- **Alerting on the events that matter**: a spike in authentication failures, a new admin account
  created, or a privilege escalation should be able to page someone, not just sit in a log nobody
  reads until after an incident.
- **Fail closed, not open**: when an auth check, a rate limiter, or a security-relevant dependency
  (an IAM/policy service, a WAF) is unreachable, the request should be denied, not silently allowed
  through "so the app stays up."
- **Deception as a deterrent** (worth suggesting, rarely worth insisting on): a honeytoken (a
  credential that should never be used, alerting the instant it is) planted where an attacker who
  has already gained some access would find it — cheap to add, and one of the highest-signal alerts
  a system can produce because a legitimate user never triggers it.
- **Response readiness**: is there a documented, current way to revoke a compromised credential,
  roll a leaked secret, or roll back a bad deploy quickly? A defense with no fast undo turns every
  incident into a slow one.

**How to check it**: read the logging/observability setup (or its absence) and the rate-limiting
middleware (or its absence) — this category is usually a smaller code surface than the others, and
often the fastest to give a complete answer on.
`.trim();

/** Every playbook, in the order DEFENDER mode should generally work them. */
export const DEFENDER_PLAYBOOKS = [
  INJECTION_PLAYBOOK,
  AUTH_SESSION_PLAYBOOK,
  ACCESS_CONTROL_PLAYBOOK,
  SECRETS_PLAYBOOK,
  DEPENDENCIES_PLAYBOOK,
  CRYPTOGRAPHY_PLAYBOOK,
  IAC_CONTAINERS_PLAYBOOK,
  INPUT_VALIDATION_FUZZING_PLAYBOOK,
  LOGGING_MONITORING_DETERRENCE_PLAYBOOK,
].join("\n\n");
