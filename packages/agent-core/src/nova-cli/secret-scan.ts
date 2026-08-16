/**
 * Deterministic, pattern-based secret detection — the one part of DEFENDER mode's secrets
 * playbook that should not depend on the model choosing to grep the right shape. A curated regex
 * beats an LLM's judgement here for the same reason a linter beats code review for a missing
 * semicolon: recall on a known, narrow shape is exactly what deterministic matching is good at.
 *
 * Pure and workspace-free by design — `scan_secrets` in tools.ts is the only caller, and keeping
 * the matching logic here means it can be tested without a fake workspace.
 */

/**
 * How bad it is if this match is real, not whether the match itself is confident.
 *
 * `critical` is a credential that alone grants an attacker something irreversible or broad on
 * first use — cloud account access, arbitrary code execution via a signed commit or release,
 * money movement, or the private half of an asymmetric key. `high` is a credential scoped to one
 * service or one account. `medium` is a shape that is often a real secret but is also the pattern
 * most likely to be a false positive (a generic `token = "..."` assignment, a JWT that may be
 * short-lived or already public). Ranking is about consequence, not about how sure the regex is.
 */
export type SecretSeverity = "critical" | "high" | "medium";

export type SecretPattern = { name: string; regex: RegExp; severity: SecretSeverity };

/**
 * Recognizable secret shapes, roughly ordered by how distinctive their prefix is (least likely to
 * false-positive first). No inline `i` flag: `new RegExp(source)` (how `grepWorkspace` builds its
 * matcher from this) does not carry flags, so a pattern that needs to catch both cases spells both
 * out rather than relying on one this file's own re-matching wouldn't see applied consistently.
 */
export const SECRET_PATTERNS: readonly SecretPattern[] = [
  { name: "AWS access key", regex: /AKIA[0-9A-Z]{16}/, severity: "critical" },
  { name: "GitHub token", regex: /gh[pousr]_[A-Za-z0-9]{36,255}/, severity: "critical" },
  { name: "Google API key", regex: /AIza[0-9A-Za-z_-]{35}/, severity: "high" },
  { name: "Slack token", regex: /xox[baprs]-[0-9A-Za-z-]{10,}/, severity: "high" },
  { name: "Stripe key", regex: /(?:sk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/, severity: "critical" },
  { name: "Anthropic/OpenAI-style API key", regex: /sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/, severity: "high" },
  { name: "Private key block", regex: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/, severity: "critical" },
  { name: "JSON Web Token", regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: "medium" },
  { name: "credential-looking assignment", regex: /(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9\-_.]{16,}['"]/, severity: "medium" },
  { name: "credential-looking assignment", regex: /(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN)\s*[:=]\s*['"][A-Za-z0-9\-_.]{16,}['"]/, severity: "medium" },
];

/** Highest first — the order a findings list and a severity chart should both read in. */
export const SEVERITY_RANK: Readonly<Record<SecretSeverity, number>> = { critical: 0, high: 1, medium: 2 };

/** One pattern covering every rule, so a scan costs one tree walk rather than one per rule. */
export const COMBINED_SECRET_PATTERN = new RegExp(SECRET_PATTERNS.map((pattern) => `(?:${pattern.regex.source})`).join("|"));

/**
 * Never the value itself: first four and last four characters survive (enough to recognize which
 * secret it is, for rotation), the middle does not — the scan's own output must not become a new
 * place the secret it found now lives in cleartext, including in a saved session transcript.
 */
export function maskSecret(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 10) return "[redacted]";
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)} (${trimmed.length} chars)`;
}

export type SecretFinding = { kind: string; masked: string; severity: SecretSeverity };

/** Every distinct secret-shaped match in one line, labelled by which pattern it is, each masked. */
export function findSecretsInLine(line: string): SecretFinding[] {
  const found: SecretFinding[] = [];
  for (const pattern of SECRET_PATTERNS) {
    const match = line.match(pattern.regex);
    if (match) found.push({ kind: pattern.name, masked: maskSecret(match[0]), severity: pattern.severity });
  }
  return found;
}
