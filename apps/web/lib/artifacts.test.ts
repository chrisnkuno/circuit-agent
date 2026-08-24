import { describe, expect, it } from "vitest";
import { describeArtifact, truncateEvidence } from "./artifacts";

describe("artifact manifests", () => {
  it("creates content-addressed tenant-scoped references", () => {
    const artifact = describeArtifact({
      taskId: "task_1", runId: "run_1", stepId: "step_1",
      kind: "patch", mediaType: "text/x-diff", content: "diff --git a/a b/a",
    });
    expect(artifact.reference).toContain(`artifact:task_1:step_1:patch:${artifact.sha256}`);
    expect(artifact.byteLength).toBeGreaterThan(0);
  });

  it("truncates oversized UTF-8 evidence without splitting characters", () => {
    const output = truncateEvidence("🙂".repeat(100), 80);
    expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(80);
    expect(output).toContain("truncated");
    expect(output).not.toContain("�");
    expect(new TextEncoder().encode(truncateEvidence("long output", 5)).byteLength).toBe(5);
  });
});
