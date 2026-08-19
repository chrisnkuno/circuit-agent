import { describe, expect, it } from "vitest";
import { artifactPathFor, ARTIFACT_DIRECTORY, countLines, WorkspaceArtifactStore } from "./artifacts";
import { evictedToolResult, type StoredToolArtifact } from "../agent-runtime";

function recordingWorkspace() {
  const writes: Array<{ path: string; content: string }> = [];
  return {
    writes,
    async writeFile(path: string, content: string) {
      writes.push({ path, content });
      return { path, bytesWritten: Buffer.byteLength(content, "utf8") };
    },
  };
}

const artifact: StoredToolArtifact = { path: ".nova/artifacts/run_command-abc123def456.txt", bytes: 400_000, lines: 12_000, elided: false };

describe("artifact store", () => {
  it("addresses an artifact by its content, so the same output is one file however often it repeats", async () => {
    const workspace = recordingWorkspace();
    const store = new WorkspaceArtifactStore(workspace);
    const first = await store.put({ toolName: "run_command", toolCallId: "call-1", content: "the same log" });
    const second = await store.put({ toolName: "run_command", toolCallId: "call-2", content: "the same log" });
    const other = await store.put({ toolName: "run_command", toolCallId: "call-3", content: "a different log" });

    expect(second.path).toBe(first.path);
    expect(other.path).not.toBe(first.path);
    expect(workspace.writes).toHaveLength(2);
  });

  it("keeps every artifact path inside the artifact directory whatever a tool is called", () => {
    for (const name of ["run_command", "../../etc/passwd", "mcp:weird/name", "", "..", "a".repeat(200)]) {
      const path = artifactPathFor(name, "content");
      expect(path.startsWith(`${ARTIFACT_DIRECTORY}/`)).toBe(true);
      expect(path.slice(ARTIFACT_DIRECTORY.length + 1)).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{12}\.txt$/);
    }
  });

  it("reports the true size even when the stored copy had to be cut, and never writes past its ceiling", async () => {
    const workspace = recordingWorkspace();
    const store = new WorkspaceArtifactStore(workspace, 1_000);
    const content = "x".repeat(5_000);
    const stored = await store.put({ toolName: "run_command", toolCallId: "call-1", content });

    expect(stored.bytes).toBe(5_000);
    expect(stored.elided).toBe(true);
    expect(workspace.writes[0].content.length).toBeLessThan(1_200);
    expect(workspace.writes[0].content).toContain("5000");
  });

  it("counts lines the way a file does", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("one")).toBe(1);
    expect(countLines("one\ntwo")).toBe(2);
    expect(countLines("one\ntwo\n")).toBe(3);
  });
});

describe("evicted tool result", () => {
  it("never exceeds the budget it was given, for any content and any budget", () => {
    const contents = ["", "short", "line\n".repeat(10_000), "x".repeat(200_000), `${"a".repeat(5_000)}\n${"b".repeat(5_000)}`];
    for (const content of contents) {
      for (const budget of [0, 1, 32, 128, 399, 400, 401, 1_000, 40_000]) {
        expect(evictedToolResult(content, artifact, budget).length).toBeLessThanOrEqual(budget);
      }
    }
  });

  it("keeps the end of the output, which is where a failure says what failed", () => {
    const content = [...Array(5_000).keys()].map((index) => `line ${index}`).join("\n");
    const excerpt = evictedToolResult(`${content}\nFAILED: assertion at the very end`, artifact, 2_000);

    expect(excerpt).toContain("line 0");
    expect(excerpt).toContain("FAILED: assertion at the very end");
    expect(excerpt).toContain(artifact.path);
    expect(excerpt).toMatch(/\.\.\.\[\d+ lines elided/);
  });

  it("accounts for every line exactly once: shown at the head, shown at the tail, or counted as elided", () => {
    const lines = [...Array(400).keys()].map((index) => `line ${index}`);
    const excerpt = evictedToolResult(lines.join("\n"), { ...artifact, lines: 400 }, 1_200);
    const elided = Number(/\.\.\.\[(\d+) lines? elided/.exec(excerpt)?.[1]);
    const shown = lines.filter((line) => new RegExp(`(^|\\n)${line}(\\n|$)`).test(excerpt)).length;

    expect(elided + shown).toBe(400);
  });

  it("falls back to plain truncation when the budget is too small for a useful excerpt", () => {
    const excerpt = evictedToolResult("y".repeat(1_000), artifact, 200);
    expect(excerpt).not.toContain(artifact.path);
    expect(excerpt.length).toBeLessThanOrEqual(200);
  });
});
