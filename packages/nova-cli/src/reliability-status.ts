import bundledEvidence from "../../../reliability/latest.json";

export type ReliabilitySnapshot = {
  score: number;
  grade: string;
  generatedAt: string;
};

export const BUNDLED_RELIABILITY = bundledEvidence as ReliabilitySnapshot;

/** A release-baked trust signal: instant and offline, with a date so it can never pose as live data. */
export function renderReliabilityStatus(
  width: number,
  separator: string,
  snapshot: ReliabilitySnapshot = BUNDLED_RELIABILITY,
): string {
  const date =
    /^\d{4}-\d{2}-\d{2}/.exec(snapshot.generatedAt)?.[0] ?? "unknown date";
  const score = Math.max(0, Math.min(100, Math.round(snapshot.score)));
  if (width < 48)
    return `reliability ${score}/100 ${separator} improving daily`;
  return `reliability ${score}/100 ${separator} ${snapshot.grade} ${separator} measured ${date} ${separator} improving toward best-in-class`;
}
