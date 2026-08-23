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

export const SECURITY_MISCONFIGURATION_PLAYBOOK = `
## Security misconfiguration

OWASP's 2025 Top Ten moved this to #2 — misconfiguration now shows up in application testing more
often than any category except broken access control, and unlike a code-level bug it is often a
single wrong setting away from being fixed.

- **Debug/dev features left on in production**: a framework's debug mode (Django \`DEBUG=True\`,
  Flask \`debug=True\`, Rails \`config.consider_all_requests_local\`, a stack-trace-on-error page),
  an admin/debug endpoint with no auth (\`/actuator\`, \`/debug\`, \`/_profiler\`, a GraphQL
  introspection endpoint or playground exposed publicly), or verbose error responses that echo a
  stack trace, a query, or an internal path back to the caller.
- **Default and sample content**: default admin credentials never changed, sample apps or install
  scripts (\`install.php\`, \`setup.jsp\`) still deployed, a default TLS certificate, or a database
  left on its default port with its default account.
- **Missing security headers**: no \`Content-Security-Policy\`, \`X-Content-Type-Options: nosniff\`,
  \`X-Frame-Options\`/\`frame-ancestors\` (clickjacking), or \`Strict-Transport-Security\` on an
  HTTPS-only service. Absence is the common case worth naming, not a hypothetical.
- **Overly permissive CORS**: covered in depth under access control (SSRF/CORS with credentials),
  but also check for CORS enabled globally "to make the errors go away" rather than scoped to the
  origins that actually need it.
- **Directory listing and unintended exposure**: a web server serving directory indexes, a
  \`.git\`/\`.svn\` directory reachable over HTTP, a \`.env\`, backup file (\`*.bak\`, \`*~\`,
  \`*.sql\`), or editor swap file left inside the web root.
- **Unnecessary features and services enabled**: unused ports, sample plugins, verbose HTTP
  methods (\`TRACE\`, \`OPTIONS\` disclosing more than intended), or a dependency's optional
  features (an XML parser's external-entity support, a template engine's raw-eval mode) turned on
  without being used.
- **Cloud and platform defaults**: a storage bucket, queue, or managed database created with the
  provider's permissive default (public-read, no encryption at rest, no network restriction) and
  never tightened for what it actually holds.

**How to check it**: this is usually visible in one pass over config files, deployment manifests,
and framework settings, rather than something that needs deep call-graph tracing — read
\`settings.py\`/\`.env.example\`/\`docker-compose.yml\`/framework config top to bottom once.
`.trim();

export const SSRF_PLAYBOOK = `
## Server-side request forgery (SSRF)

Consolidated into OWASP's Broken Access Control category for 2025, but worth its own checklist:
the trigger shape is distinct from a normal access-control bug, and it is the one that turns "the
server can reach a URL" into "the server can be made to reach a URL an attacker chose."

- **Any server-side fetch driven by user input**: a webhook URL, an "import from URL" feature, an
  avatar/image fetched by URL, a PDF/document converter that follows links, an RSS/feed reader, or
  a URL passed to an internal HTTP client, all count. Grep for \`fetch(\`, \`axios.get(\`,
  \`requests.get(\`, \`urlopen(\`, \`http.Get(\` fed by a request parameter rather than a constant.
- **The cloud metadata pivot**: an SSRF that can reach \`169.254.169.254\` (AWS/GCP/Azure instance
  metadata) can often retrieve the instance's own IAM credentials — this is the single highest-
  impact SSRF outcome and worth calling out by name whenever a fetchable-URL feature exists on a
  cloud-hosted service.
- **Internal network reach**: whether the vulnerable fetch can reach \`localhost\`, RFC1918 ranges,
  or internal-only services (an admin panel, a database's HTTP API, an internal microservice with
  no auth of its own because "only internal services call it").
- **Weak allowlisting**: a URL validator that checks the hostname string but not the resolved IP
  (DNS rebinding — the hostname resolves somewhere allowed at check time and somewhere internal at
  fetch time), or one that blocks by string match (\`!url.includes("localhost")\`) rather than
  parsing and checking the actual host/scheme/port.
- **Redirects**: whether the HTTP client used follows redirects by default — a URL that passes an
  allowlist check can still redirect to an internal address if the client follows the 3xx.

**How to check it**: find every place the server itself makes an outbound request whose target
came from a request, then check whether the target is validated against a real allowlist (parsed
host, not string match) with redirects disabled or re-validated per hop.
`.trim();

export const CLIENT_SIDE_SECURITY_PLAYBOOK = `
## Client-side & browser security

The injection playbook above is server-side; this is what runs in the browser, where the attacker
is often another user's malicious input rendered back to a victim, not a request straight from the
attacker to the server.

- **Cross-site scripting (XSS)**: raw HTML insertion from anything user-controlled —
  \`innerHTML\`/\`outerHTML\`/\`document.write\` fed by a variable, React's \`dangerouslySetInnerHTML\`,
  Vue's \`v-html\`, a template engine's "raw"/"safe"/unescaped-output marker, or a URL/redirect
  target built from user input and inserted into an \`href\`/\`src\` (\`javascript:\` scheme abuse).
  A framework's default auto-escaping is a real mitigation — the finding is specifically where
  something opts out of it.
- **Stored vs. reflected vs. DOM-based**: stored (saved to a database and rendered to other users
  later — the highest-impact kind) is worth distinguishing from reflected (echoed straight back in
  the same response) and DOM-based (a client-side script reads something like \`location.hash\` and
  writes it into the page without ever touching the server) — the fix differs by kind.
- **CSRF**: a state-changing endpoint (anything that writes) with no CSRF token, no
  \`SameSite=Lax/Strict\` cookie, and no check of the \`Origin\`/\`Referer\` header — reachable by a
  form or fetch from any other site the victim happens to have open, riding their existing session
  cookie.
- **Clickjacking**: no \`X-Frame-Options\`/\`frame-ancestors\` (already listed under security
  misconfiguration, repeated here because it is specifically what stops a sensitive action page
  from being framed invisibly under a decoy UI).
- **Open redirect**: a redirect target taken from a request parameter with no allowlist, useful to
  an attacker as a trusted-looking link in a phishing email that starts on the real domain before
  bouncing.
- **Prototype pollution** (JavaScript/TypeScript specifically): a deep-merge, deep-clone, or
  object-assignment utility (hand-rolled, or an unpatched old version of \`lodash\`/similar) that
  does not guard against a key named \`__proto__\`, \`constructor\`, or \`prototype\` — can escalate
  from a data-only bug into arbitrary property injection across the whole process.
- **postMessage handling**: a \`window.addEventListener("message", ...)\` handler that does not
  check \`event.origin\` before trusting \`event.data\` — accepts instructions from any embedded or
  embedding frame, not just the one the app intended to talk to.

**How to check it**: find every place user-influenced data reaches the DOM without going through
the framework's default escaping, and every state-changing endpoint, then check each against the
specific gap above rather than a generic "sanitize input" pass.
`.trim();

export const API_SECURITY_PLAYBOOK = `
## API security

Aligned to the OWASP API Security Top 10 — worth its own pass on any service with a JSON/REST/
GraphQL/RPC API, because these risks are ranked differently than the general web list: authorization
failures dominate over injection here.

- **Broken object-level authorization (BOLA)**: the single most common API finding — an endpoint
  that takes an id (\`/api/orders/:id\`, a GraphQL field argument) and returns or mutates the
  record for *whatever id was passed*, checking only that the caller is authenticated, not that
  they own or are permitted to touch that specific object. Already covered under access control;
  named again here because on an API it is the default failure mode, not an edge case.
- **Broken function-level authorization (BFLA)**: an admin-only or elevated operation reachable by
  calling its endpoint directly with a non-admin token, because the check exists in the admin UI's
  routing but not in the API handler itself.
- **Broken object *property*-level authorization**: an endpoint that returns or accepts more
  fields than the caller should see or set — a user object response including a password hash or
  internal flag, or an update endpoint that accepts \`role\`/\`isAdmin\`/\`balance\` in the body
  because it binds the whole request onto the model (mass assignment).
- **Unrestricted resource consumption**: no limit on page size, no cap on a batch operation's
  array length, no request size limit, no timeout on an expensive query — any of which turns a
  single request into a denial-of-service, sometimes billed directly to the account (metered cloud
  resources, LLM token spend).
- **Unrestricted access to sensitive business flows**: an endpoint that is individually authorized
  correctly but has no rate limit or abuse detection on a flow worth protecting at the *business*
  level regardless — bulk account creation, a coupon-redemption endpoint, a "check if this email
  is registered" endpoint usable to enumerate users at scale.
- **Improper inventory management**: an old API version left reachable after a newer one shipped,
  a staging/internal endpoint reachable from the public internet, or an endpoint that exists only
  in the mobile app's compiled code with no corresponding entry in the documented API surface —
  "shadow" endpoints nobody is actively watching.
- **Unsafe consumption of third-party APIs**: a response from an external API trusted without
  validation — its data inserted into a database query, rendered as HTML, or used as a redirect
  target as if it had already been sanitized, when it is just as untrusted as any other input.

**How to check it**: enumerate every route/resolver, and for each one ask "what stops a caller
from acting on an id, field, or volume of requests they should not have"; a route with no such
check anywhere in its handler is the finding, not a hypothetical.
`.trim();

export const SUPPLY_CHAIN_INTEGRITY_PLAYBOOK = `
## Software supply chain & CI/CD integrity

The dependencies playbook above is about *what versions are in the manifest*; this is about the
*pipeline that builds, tests and ships them* — its own OWASP Top Ten category for 2025, expanded
from "vulnerable and outdated components" specifically because the pipeline itself is now a
common attack target, not just what it happens to pull in.

- **Unpinned CI actions/steps**: a GitHub Actions workflow referencing a third-party action by a
  mutable tag (\`uses: some/action@v3\`) rather than a pinned commit SHA — the action's maintainer
  (or anyone who compromises their account) can change what that tag points to and it runs with
  whatever permissions the workflow has, silently, on the next build.
- **Overly broad CI permissions and secrets**: a workflow with \`permissions: write-all\` (or the
  implicit broad default) when it only needs read access, a publish token (npm, PyPI, container
  registry) with no scoping to the one package it needs to publish, or a secret exposed to a step
  that does not need it (a test job with deploy credentials in its environment).
- **Untrusted code running with trusted permissions**: a workflow triggered by
  \`pull_request_target\` (which runs with the base repo's secrets and permissions) that checks out
  and executes the PR's own code — lets an external contributor's PR exfiltrate secrets or push
  with the workflow's authority.
- **Missing build provenance**: no way to verify a published artifact was actually built by the
  claimed CI pipeline from the claimed source commit (no SLSA/provenance attestation, no signed
  release) — makes a compromised publish step or a stolen token indistinguishable from a real
  release after the fact.
- **Install-time code execution**: already covered under dependencies (a package's
  \`postinstall\` script), repeated here because CI is exactly where that script runs with the most
  ambient authority (registry tokens, deploy keys) and the least human observation.
- **Unreviewed auto-merge/auto-update**: a bot that auto-merges dependency-bump PRs with no
  human review and no CI gate that would actually catch a malicious version bump, versus one that
  merges only after tests *and* a diff review pass.

**How to check it**: read the CI/CD workflow files themselves (\`.github/workflows/*.yml\`,
\`.gitlab-ci.yml\`, etc.) for the permission and pinning gaps above — this is a small, finite set of
files on most projects and usually faster to fully cover than the application code itself.
`.trim();

export const ERROR_HANDLING_PLAYBOOK = `
## Mishandling of exceptional conditions

OWASP's newest 2025 category — the pattern underneath it is code that behaves correctly on the
happy path and then does something unsafe specifically *because* something else already went
wrong, which is why it survives so much testing: the tests that would catch it are the ones
nobody wrote.

- **Fail open on a security check**: an authorization, rate-limit, or validation check wrapped in
  a try/catch that, on any exception (a timeout calling an auth service, a malformed input the
  parser did not expect), falls through to *allowing* the action rather than denying it. Grep for
  a catch block near an auth/permission check and read what it does on failure.
  "\`catch { return true; }\`" next to a permission check is close to always a finding on its own.
- **Swallowed exceptions**: an empty catch block, or one that only logs, around code whose failure
  should have stopped the operation — the caller proceeds believing something succeeded (a payment
  was recorded, a file was written, a webhook was verified) when it did not.
- **Inconsistent error responses leaking information**: a login or lookup endpoint that returns a
  different error for "user does not exist" versus "wrong password" (or a different status code,
  or a different response time) — lets an attacker enumerate valid accounts one probe at a time
  even though each individual response looks like a refusal.
- **Retry and fallback logic bypassing a check**: a retry wrapper, a circuit breaker, or a
  fallback path that re-executes an operation without re-running the validation/authorization the
  first attempt had already passed through once — the retry path is the one nobody re-reviewed.
- **Partial failure left uncommitted or half-applied**: a multi-step operation (charge a card,
  then provision a resource) where a failure partway through leaves state inconsistent with no
  compensation or rollback, and the exceptional path was never exercised by a test.

**How to check it**: search for catch/except/rescue blocks near anything security-relevant —
authorization, payment, file/command execution — and read what each one does on failure, not just
whether one exists.
`.trim();

export const BUSINESS_LOGIC_PLAYBOOK = `
## Business logic & race conditions

Not a single OWASP category by name — the risks here are specific to what *this* application is
for, which is exactly why a generic scanner misses them and a careful read of the actual workflow
does not.

- **Time-of-check to time-of-use (TOCTOU) races**: a balance check followed by a deduction, a
  stock-quantity check followed by a decrement, or an "already used" check on a coupon/invite
  code — each as two separate steps with no lock, transaction, or atomic
  compare-and-set between them. Two concurrent requests can both pass the check before either
  applies its effect, doubling what should have been a single use. Grep for a read followed later
  by a write to the same record with no transaction/lock spanning both.
- **Workflow step skipping**: a multi-step process (checkout → payment → fulfillment,
  or signup → email verification → account active) where a later step's endpoint can be called
  directly without the earlier steps having actually completed, because the server trusts a client-
  supplied "step complete" flag instead of its own record of what happened.
- **Price, quantity or parameter manipulation**: a price, discount, or quantity value taken from
  the client and trusted rather than recomputed server-side from the actual catalog/rules — a
  request body edited to change \`price\` or \`quantity\` before submission.
- **Negative or overflow quantities**: a quantity or amount field with no lower bound (a negative
  purchase quantity that becomes a refund) or no upper bound (an integer overflow that wraps a
  huge number into a small or negative one).
- **Idempotency gaps on retried requests**: a payment, order-creation, or send-once operation with
  no idempotency key — a client retry (or an attacker replaying a captured request) after a slow
  or ambiguous response can execute the operation twice.

**How to check it**: walk the actual user-facing workflow end to end (not just individual
endpoints) and ask, at each step, "what does the server actually verify happened, versus what does
it just trust the client to say happened" — and for anything involving a shared counter or
balance, whether concurrent requests are excluded by a real lock or transaction.
`.trim();

export const LLM_AI_SECURITY_PLAYBOOK = `
## LLM & AI application security

Aligned to the OWASP Top 10 for LLM Applications (2025) — relevant to any project that calls a
model API, embeds a chat feature, or (like Nova itself) gives a model tools that can act on a
codebase or a live system. An LLM blurs the line between "instructions" and "data" in a way
traditional input validation was never built for, which is the root cause behind most of this list.

- **Prompt injection (LLM01)**: untrusted content — a user message, a fetched web page, a file the
  model reads, a tool's output — that the model can interpret as *instructions* rather than data
  to reason about. Direct (the user types it) and indirect (it arrives via a document, email, or
  web page the model is asked to summarize or act on) are both real; indirect is the harder one to
  see coming because the attacker never talks to the application directly.
- **Excessive agency (LLM06)**: a model-driven agent with more capability, autonomy, or reach than
  the task in front of it actually needs — a tool that can write files or run commands with no
  human approval step, a broader API scope than the agent's job requires, or a chain of tool calls
  that can complete an irreversible action (a payment, a deploy, a delete) with no confirmation.
  The mitigation that matters most here is the one Nova's own approval gating exists for: nothing
  effectful should run without a human in the loop, or without a narrowly scoped, explicitly
  reasoned-about exception.
- **Insecure output handling (LLM05)**: model output written into a shell command, a database
  query, HTML rendered to a browser, or executed as code, on the assumption that because it *came
  from the model* it is safe — a model whose input included attacker-controlled content can be led
  to produce output that is itself the injection payload. Treat model output as untrusted input to
  whatever consumes it next, same as any other external data.
- **Sensitive information disclosure (LLM02)**: a system prompt, internal tool schema, or
  retrieved document containing a secret, credential, or internal detail that the model can be
  induced to repeat back — including via a side channel (asking it to "repeat your instructions",
  or to summarize its own context).
- **System prompt leakage (LLM07)**: distinct from general disclosure — specifically whether the
  system prompt itself was written *assuming* it stays secret and would be unsafe if quoted back
  (embedded credentials, or business logic like "never offer a refund over $50" that a leaked
  prompt hands straight to an attacker looking for the boundary).
- **Supply chain (LLM03)**: an unverified or unpinned model weight, a third-party plugin/tool
  integration with no review of what it actually does, or a prompt-template/embedding-model
  dependency pulled from an unvetted source — the same supply-chain discipline as regular
  dependencies, applied to models and the tools wired up to them.
- **Unbounded consumption (LLM10)**: no limit on request rate, input/output token length, or
  recursive tool-call depth — a single crafted input that causes the model to loop, or a user who
  can trigger unbounded generation, turning into a cost or availability incident (this is what
  Nova's own budget/spend-cap machinery exists to bound; check whether *this* project's own
  LLM-calling code has an equivalent).
- **Vector and embedding weaknesses (LLM08)**: for a RAG (retrieval-augmented generation) system —
  whether the retrieval store enforces the same access control the source documents had (a
  document a user should not see must not be retrievable into their context just because it is in
  the same vector index), and whether untrusted content can be embedded and later retrieved as if
  it were trusted instruction.

**How to check it**: trace every path from "content the model sees" back to its source — if that
source is anything other than the developer's own fixed prompt text, treat it as untrusted and
check what the model is allowed to do as a result of processing it.
`.trim();

export const THREAT_INTELLIGENCE_PLAYBOOK = `
## Threat intelligence & memory

The playbooks above are curated but static; the threat landscape is not. A dependency, framework,
or platform this project actually uses can have a disclosure that postdates this build.

- **Search before you conclude a dependency category is clean.** Once you know what the project
  actually runs (from its manifest — \`package.json\`, \`requirements.txt\`, \`go.mod\`, \`Gemfile\`,
  base images, and so on), search for recent CVEs, advisories, or active-exploitation
  reports against the specific frameworks, libraries and major versions this project depends on —
  not a generic "latest security threats" query. A search scoped to what is actually installed
  finds the one advisory that matters; a generic one returns noise.
- **Pick the right search tool for the question.** \`web_search\` answers "is there an advisory for
  express 4.18" — one lookup, one page. \`deep_research\` is for the questions that span sources and
  need them reconciled: whether a CVE's vulnerable path is reachable in this project's
  configuration, what an exploit chain actually requires, how a fix in one library interacts with a
  pinned transitive dependency. Those answers live spread across an advisory database, a changelog
  and an issue tracker, and \`deep_research\` plans the sub-searches, reads across them and returns
  a cited answer instead of ten pages for you to reconcile yourself.
- **Scope and freshen deliberately — a stale advisory answer is a wrong one.** Pass
  \`includeDomains\` to pin a query to authoritative sources
  (\`nvd.nist.gov\`, \`github.com/advisories\`, \`cve.org\`, the project's own security page) rather
  than hoping ranking finds them. Pass \`fresh: true\` when the answer turns on what is true today —
  an active exploitation campaign, a fix released this week — because the default serves a cached
  copy, which is exactly wrong for a disclosure published after that cache was written. Pass
  \`startPublishedDate\` to exclude advisories already superseded.
- **Distinguish a real finding from a search result.** A CVE only becomes a finding once you have
  confirmed the vulnerable code path is actually reachable here — the same standard as every other
  playbook. Cite the advisory (id and source) alongside the file/line that makes it apply.
- **Use exploit and tool intelligence defensively.** Look for common exploit prerequisites,
  proof-of-concept availability, CISA KEV status, observed campaigns, scanners, hardening tools,
  and incident-response utilities only to determine exposure, detection, containment, and repair.
  Prefer maintained defensive tools and their official repositories. Never turn search results into
  autonomous exploitation, credential collection, persistence, evasion, or instructions for
  targeting a person or third-party system.
- **Discover GitHub security tools for the exact defensive need.** Search for the affected
  platform and capability (scanner, SBOM, secret detection, incident response, OSINT validation),
  then compare the official repository, recent releases and commits, issue responsiveness,
  security policy, documentation, license, archive status, and operating-system fit. Stars and
  trending activity are adoption signals, not proof of safety or suitability. Explain why each
  candidate fits the finding and its trade-offs; never install or execute a discovered tool
  without the user's approval.
- **Keep OSINT and OPSEC scoped to the system under review.** Public metadata can confirm an exposed
  asset, leaked secret, typosquatted package, malicious domain, or compromised dependency, but the
  review must minimize personal data, avoid deanonymization, and record only evidence needed to
  defend the user's own assets. Explain safe evidence handling and disclosure boundaries when a
  finding could expose an operator, researcher, or victim.
- **Persist what you learn, so the next review does not start from zero.** When a search turns up
  something durable and specific to this project — a CVE affecting a pinned version, a technique
  actively being used against this project's exact stack, a hardening step this project has not
  taken — write it to project memory at \`.nova/memory.md\` using the existing bullet format
  (\`- [lesson] <durable, specific fact>\`), the same file and tools you would use for any other
  edit. Keep each entry self-contained and dated in its own text (advisory ids age; "current" does
  not), and keep it to the conclusion, not the search transcript — the next defender run recalls it
  automatically when its terms overlap with what that run is looking at.
- **Do not duplicate what is already remembered.** Check the memory block already given to you
  before adding a near-identical entry; extend or supersede an existing line rather than repeating
  it.
`.trim();

export const HARDENING_RESOURCES_PLAYBOOK = `
## Hardening resources, cost & hosting guidance

A finding without a realistic path to fixing it is a report nobody acts on. Once you have real
findings, close the review by telling the user *what it actually takes to fix them* — grounded in
this project, not a generic checklist.

- **Read what this project actually runs on before recommending anything.** A Dockerfile, compose
  file, Terraform/CloudFormation/Pulumi source, \`vercel.json\`, \`fly.toml\`, a Kubernetes manifest,
  or a CI workflow all say where this project is actually deployed. Recommend the tool or practice
  that fits that target — a managed secret manager for a project already on the cloud provider that
  offers one, a \`.env\` + \`git-crypt\`/\`sops\` pattern for one that deploys from a single box, a
  reverse-proxy rate limit for one fronted by nginx/Caddy already. A recommendation that assumes
  infrastructure the project does not have is not actionable.
- **Name specific resources, not categories.** "Add a WAF" is a category; "Cloudflare's free tier
  covers basic WAF rules for this domain, or \`fail2ban\` if this stays on a single VPS" is a
  resource the user can actually go get. Prefer free or already-configured-provider options first —
  the cheapest real fix beats an expensive ideal one nobody will buy.
- **Calculate cost when it is knowable.** For anything with a real price (a managed service, a
  paid scanning tool, additional compute for a hardened build step), give a concrete estimate — use
  \`web_search\` for current pricing rather than guessing, and show the arithmetic (unit price ×
  the project's actual scale) rather than a bare number so the user can sanity-check it against
  their own traffic or usage.
- **Call out the local-vs-cloud tradeoff explicitly when it is live.** If the project could harden
  the same gap either by self-hosting (more control, more operational burden, no recurring fee) or
  by adopting a managed/cloud service (less to run, a bill, a new trust boundary), say so as a real
  choice with its actual tradeoff for this project's size and team — not as a rule of thumb that
  applies to every project the same way.
- **Rank resourcing suggestions by the findings they close.** A recommendation that fixes the
  highest-severity finding on the list belongs first; do not let a cheap, easy suggestion crowd out
  the one that actually matters.
`.trim();

/** Every playbook, in the order DEFENDER mode should generally work them. */
export const DEFENDER_PLAYBOOKS = [
  // Ordered by real-world prevalence per OWASP's 2025 Top Ten dataset (175,000+ CVEs, practitioner
  // surveys): broken access control and security misconfiguration are #1 and #2, supply chain is
  // the newest and fastest-growing category (#3), and the rest follow from there.
  ACCESS_CONTROL_PLAYBOOK,
  SECURITY_MISCONFIGURATION_PLAYBOOK,
  SUPPLY_CHAIN_INTEGRITY_PLAYBOOK,
  INJECTION_PLAYBOOK,
  CLIENT_SIDE_SECURITY_PLAYBOOK,
  AUTH_SESSION_PLAYBOOK,
  API_SECURITY_PLAYBOOK,
  SSRF_PLAYBOOK,
  SECRETS_PLAYBOOK,
  DEPENDENCIES_PLAYBOOK,
  CRYPTOGRAPHY_PLAYBOOK,
  IAC_CONTAINERS_PLAYBOOK,
  ERROR_HANDLING_PLAYBOOK,
  BUSINESS_LOGIC_PLAYBOOK,
  INPUT_VALIDATION_FUZZING_PLAYBOOK,
  LOGGING_MONITORING_DETERRENCE_PLAYBOOK,
  LLM_AI_SECURITY_PLAYBOOK,
  // Not OWASP categories at all — these close the loop the categories above open: stay current
  // past this build's knowledge cutoff, remember what was learned, and turn findings into
  // resourced, costed, actionable next steps rather than leaving the user with a list.
  THREAT_INTELLIGENCE_PLAYBOOK,
  HARDENING_RESOURCES_PLAYBOOK,
].join("\n\n");

/**
 * The same playbooks, addressable one at a time.
 *
 * `DEFENDER_PLAYBOOKS` above is ~44,000 characters — around 14,300 tokens — and it was sent whole
 * on every request of every iteration in defender mode, which is 80% of that mode's fixed prompt
 * cost and by far the largest single line item in the whole system. Most of it is inapplicable to
 * any given project: there is no SQL injection surface in a repository with no database, and no
 * LLM playbook worth reading against one that calls no model.
 *
 * So the prompt now carries the *index* — every category, named — and the model pulls the two or
 * three that actually apply. Nothing is lost: the full text of every playbook is one tool call
 * away, and the prompt still tells the model to work them in order of what the project is.
 */
export const DEFENDER_PLAYBOOK_CATALOG: ReadonlyArray<{
  id: string;
  title: string;
  text: string;
}> = [
  ACCESS_CONTROL_PLAYBOOK,
  SECURITY_MISCONFIGURATION_PLAYBOOK,
  SUPPLY_CHAIN_INTEGRITY_PLAYBOOK,
  INJECTION_PLAYBOOK,
  CLIENT_SIDE_SECURITY_PLAYBOOK,
  AUTH_SESSION_PLAYBOOK,
  API_SECURITY_PLAYBOOK,
  SSRF_PLAYBOOK,
  SECRETS_PLAYBOOK,
  DEPENDENCIES_PLAYBOOK,
  CRYPTOGRAPHY_PLAYBOOK,
  IAC_CONTAINERS_PLAYBOOK,
  ERROR_HANDLING_PLAYBOOK,
  BUSINESS_LOGIC_PLAYBOOK,
  INPUT_VALIDATION_FUZZING_PLAYBOOK,
  LOGGING_MONITORING_DETERRENCE_PLAYBOOK,
  LLM_AI_SECURITY_PLAYBOOK,
  THREAT_INTELLIGENCE_PLAYBOOK,
  HARDENING_RESOURCES_PLAYBOOK,
].map((text) => {
  // The `## Heading` each playbook already starts with is its title — derived rather than
  // restated, so a renamed playbook cannot disagree with the index that lists it.
  const title = text
    .trim()
    .split("\n")[0]
    .replace(/^#+\s*/, "")
    .trim();
  return {
    id: title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
    title,
    text: text.trim(),
  };
});

/** The compact list that goes in the prompt: ids the model can actually pass to `read_playbook`. */
export function defenderPlaybookIndex(): string {
  return DEFENDER_PLAYBOOK_CATALOG.map(
    (entry) => `- ${entry.id} — ${entry.title}`,
  ).join("\n");
}

/** One playbook by id, or undefined. Ids come from the index, so an unknown one is a model mistake worth reporting. */
export function playbookFor(
  id: string,
): { id: string; title: string; text: string } | undefined {
  const wanted = id.trim().toLowerCase();
  return DEFENDER_PLAYBOOK_CATALOG.find(
    (entry) => entry.id === wanted || entry.title.toLowerCase() === wanted,
  );
}
