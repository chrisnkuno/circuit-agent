import { createHash } from "node:crypto";
import type { StoredToolArtifact, ToolResultArtifactStore } from "../agent-runtime";
import type { NovaWorkspace } from "./backends";

/**
 * Where an oversized tool result goes instead of into the conversation.
 *
 * The old rule was that a tool result larger than the per-call budget was cut off mid-line and the
 * rest thrown away. That is the worst of both worlds: the model pays for thousands of characters
 * it mostly cannot use, and the part it actually needed — the failing assertion at the end of a
 * 12,000-line test log — is the part that was discarded, with no way to ask for it back.
 *
 * So the full result is written to a file in the workspace and the conversation gets a bounded
 * excerpt plus the path. The model already has `read_file` with an offset and a limit and
 * `run_command` with `grep`, so no new tool is needed to reach it: the handle is a real path in
 * the same tree the agent is already working in, which is why this writes through `NovaWorkspace`
 * rather than `node:fs`. In a sandboxed session the artifact lands in the sandbox, next to the
 * files the agent can actually read, instead of on a host it cannot see.
 *
 * Content-addressed on purpose. A run that executes the same failing test three times produces one
 * artifact, not three, and the model can tell it is the same output because it is the same path.
 */

/** Root-relative, forward-slashed: the same shape every workspace path in Nova has. */
export const ARTIFACT_DIRECTORY = ".nova/artifacts";

/**
 * Ceiling on one stored artifact.
 *
 * `LocalWorkspace` enforces `maxWriteBytes` (512 KB by default) on every write, and an artifact is
 * still a write. Staying under it keeps eviction from failing on exactly the enormous results it
 * exists for; anything past it is dropped from the *file* and said so, which is still strictly
 * more than the old truncation preserved.
 */
export const MAX_ARTIFACT_BYTES = 480_000;

/** `run_command` is a name; `../../etc/passwd` is not. Only the former reaches a filename. */
function safeToolName(toolName: string): string {
  const cleaned = toolName.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return cleaned || "tool";
}

export function artifactPathFor(toolName: string, content: string): string {
  const digest = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `${ARTIFACT_DIRECTORY}/${safeToolName(toolName)}-${digest}.txt`;
}

export class WorkspaceArtifactStore implements ToolResultArtifactStore {
  /** Paths written during this process, so the same output is not rewritten on every repeat. */
  private readonly written = new Set<string>();

  constructor(private readonly workspace: Pick<NovaWorkspace, "writeFile">, private readonly maxBytes = MAX_ARTIFACT_BYTES) {}

  async put(input: { toolName: string; toolCallId: string; content: string }): Promise<StoredToolArtifact> {
    const path = artifactPathFor(input.toolName, input.content);
    const full = Buffer.byteLength(input.content, "utf8");
    const elided = full > this.maxBytes;
    const body = elided
      ? `${input.content.slice(0, this.maxBytes)}\n...[artifact truncated at ${this.maxBytes} bytes; the tool produced ${full}]`
      : input.content;
    if (!this.written.has(path)) {
      await this.workspace.writeFile(path, body);
      this.written.add(path);
    }
    return { path, bytes: full, lines: countLines(input.content), elided };
  }
}

export function countLines(content: string): number {
  if (content === "") return 0;
  let lines = 1;
  for (let index = 0; index < content.length; index += 1) if (content.charCodeAt(index) === 10) lines += 1;
  return lines;
}
