import { createHash } from "node:crypto";

export type ArtifactKind = "model_plan" | "command_log" | "patch" | "test_log" | "review_summary";

export type ArtifactWrite = {
  taskId: string;
  runId: string;
  stepId: string;
  kind: ArtifactKind;
  mediaType: "application/json" | "text/plain" | "text/x-diff";
  content: string;
};

export type ArtifactReference = {
  reference: string;
  sha256: string;
  byteLength: number;
  kind: ArtifactKind;
};

export interface ArtifactStore {
  put(artifact: ArtifactWrite): Promise<ArtifactReference>;
}

export function describeArtifact(artifact: ArtifactWrite, referencePrefix = "artifact"): ArtifactReference {
  if (!artifact.taskId.trim() || !artifact.runId.trim() || !artifact.stepId.trim()) throw new Error("Artifact ownership is required");
  const byteLength = new TextEncoder().encode(artifact.content).byteLength;
  if (byteLength === 0) throw new Error("Empty artifacts are not accepted");
  if (byteLength > 2_000_000) throw new Error("Artifact exceeds the 2MB worker limit");
  const sha256 = createHash("sha256").update(artifact.content).digest("hex");
  return {
    reference: `${referencePrefix}:${artifact.taskId}:${artifact.stepId}:${artifact.kind}:${sha256}`,
    sha256,
    byteLength,
    kind: artifact.kind,
  };
}

export function truncateEvidence(value: string, maximumBytes = 250_000): string {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) throw new Error("maximumBytes must be a positive integer");
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength <= maximumBytes) return value;
  const suffix = "\n...[evidence truncated by worker]";
  const suffixBytes = new TextEncoder().encode(suffix);
  if (maximumBytes <= suffixBytes.byteLength) return new TextDecoder().decode(suffixBytes.slice(0, maximumBytes));
  let end = maximumBytes - suffixBytes.byteLength;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;
  return new TextDecoder().decode(bytes.slice(0, end)) + suffix;
}
