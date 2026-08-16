import type { PlacedSecretFinding } from "@circuit-nova/nova-core/nova-cli/tools";
import type { SecretSeverity } from "@circuit-nova/nova-core/nova-cli/secret-scan";

/**
 * How a scan's findings are ordered and summarised for the panel that shows them.
 *
 * Types come from agent-core rather than being restated here, for the reason `NovaMode` now does:
 * a second copy of a union is a copy that drifts, and this one carries a severity ranking that has
 * to agree with the engine's or the panel sorts by a scale the scanner does not use.
 */

export type { PlacedSecretFinding, SecretSeverity };

/** Worst first. Ties keep file order, so re-running a scan does not reshuffle equal findings. */
const RANK: Record<SecretSeverity, number> = { critical: 0, high: 1, medium: 2 };

export function sortFindings(findings: readonly PlacedSecretFinding[]): PlacedSecretFinding[] {
  return [...findings].sort((left, right) => {
    const bySeverity = RANK[left.severity] - RANK[right.severity];
    if (bySeverity !== 0) return bySeverity;
    // Stable within a severity: by path, then by line — the order you would read the code in.
    if (left.path !== right.path) return left.path.localeCompare(right.path);
    return left.line - right.line;
  });
}

export type SeverityCount = { severity: SecretSeverity; count: number };

/**
 * Counts per severity, highest first, omitting the ones with nothing in them.
 *
 * Empty buckets are dropped rather than shown as zero because this is a summary line, not a chart:
 * "2 critical, 5 medium" is read at a glance, where "2 critical, 0 high, 5 medium" makes the reader
 * check each number to find the ones that matter.
 */
export function countBySeverity(findings: readonly PlacedSecretFinding[]): SeverityCount[] {
  const counts = new Map<SecretSeverity, number>();
  for (const finding of findings) counts.set(finding.severity, (counts.get(finding.severity) ?? 0) + 1);
  return (["critical", "high", "medium"] as const)
    .filter((severity) => counts.has(severity))
    .map((severity) => ({ severity, count: counts.get(severity) ?? 0 }));
}

/**
 * The one-line verdict above the list.
 *
 * Says "possible" and "verify" on purpose. Every one of these is a regex match, and a scanner that
 * announces certainties it does not have trains people to ignore it the first time it is wrong.
 */
export function summarize(findings: readonly PlacedSecretFinding[]): string {
  if (findings.length === 0) return "No likely secrets found by pattern.";
  const parts = countBySeverity(findings).map(({ severity, count }) => `${count} ${severity}`);
  const noun = findings.length === 1 ? "possible secret" : "possible secrets";
  return `${findings.length} ${noun} — ${parts.join(", ")}. Verify each; a pattern match is a lead, not proof.`;
}
