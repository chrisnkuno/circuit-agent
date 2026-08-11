import { promises as fs } from "node:fs";
import path from "node:path";
import type { NovaWorkspace } from "./backends";

/**
 * Pre/post tool-call interception — scripts a project can drop in to observe or block what an
 * agent's own tools do, independent of any particular tool's own logic.
 *
 * Convention: `.nova/hooks/pre-tool-use/*` and `.nova/hooks/post-tool-use/*`, one executable script
 * per file, run in listing order. Each receives one JSON object on stdin —
 * `{ event, toolName, arguments, result? }` — and communicates back through its exit code, the same
 * contract Claude Code's own hooks use: a pre-hook exiting non-zero blocks the call, its stderr
 * becoming the reason shown to the model in place of a result. A post-hook's exit code cannot undo
 * a side effect that already happened, so a non-zero post-hook only appends a warning rather than
 * turning an already-completed call into an error.
 *
 * Discovery reads through `node:fs` directly against the workspace root, local sessions only — the
 * same scope `skills.ts` documents for the same reasons (`.nova` sits in every backend's
 * `ignoredDirectories`, and a remote session's local root is not a mirror of the sandbox). Running a
 * hook script itself goes through `NovaWorkspace.runCommand`, so it is subject to the same
 * containment and environment sanitization as `run_command`.
 */
export type HookEvent =
  | { event: "pre_tool_use"; toolName: string; arguments: Record<string, unknown> }
  | { event: "post_tool_use"; toolName: string; arguments: Record<string, unknown>; result: { content: string; isError: boolean } };

export const HOOKS_DIRECTORY = ".nova/hooks";
const HOOK_TIMEOUT_MS = 5_000;

/** Every executable file directly under `phaseDirectory` (an absolute path), sorted for a deterministic run order. */
async function scriptsIn(phaseDirectory: string, displayPrefix: string): Promise<string[]> {
  const entries = await fs.readdir(phaseDirectory, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isFile()).map((entry) => `${displayPrefix}/${entry.name}`).sort();
}

function runHookScript(workspace: NovaWorkspace, scriptPath: string, event: HookEvent): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // The event payload travels as a base64-encoded environment variable rather than templated into
  // the command string — the same reasoning as skill argument substitution in skills.ts: a tool
  // call's `arguments` are model-controlled, and command-string interpolation of untrusted JSON is
  // an injection path a fixed, quoting-free invocation avoids entirely. `NOVA_HOOK_EVENT_B64` is
  // read back out by the hook script itself; how it decodes it is the script author's business.
  //
  // `VAR=value command` (no `env`) is shell-only syntax — `command.ts`'s direct-argv fast path
  // exec()s the first whitespace-delimited token as the program name outright, which turned
  // `NOVA_HOOK_EVENT_B64=...` itself into the (nonexistent) program being run. `env` is a real
  // program that sets an environment variable for its child argv, so this works on both the direct
  // path and the shell path identically. A base64 payload's alphabet (`A-Za-z0-9+/=`) never collides
  // with a shell metacharacter or whitespace, so it needs no quoting either.
  const payload = Buffer.from(JSON.stringify(event), "utf8").toString("base64");
  const command = `env NOVA_HOOK_EVENT_B64=${payload} ${scriptPath}`;
  return workspace.runCommand(command, HOOK_TIMEOUT_MS);
}

export type PreToolUseOutcome = { blocked: false } | { blocked: true; reason: string };

/**
 * One place hooks are discovered from — the top-level `.nova/hooks`, or a specific plugin's.
 * `hooksDirectory` is absolute (used for `fs.readdir`); `displayPrefix` is workspace-root-relative
 * (used both for error messages and as the actual path `runCommand` executes, since a hook script
 * runs with the workspace root as its cwd).
 */
export type HookSource = { hooksDirectory: string; displayPrefix: string };

async function scriptsFromSources(sources: readonly HookSource[], phase: "pre-tool-use" | "post-tool-use"): Promise<string[]> {
  const perSource = await Promise.all(sources.map((source) => scriptsIn(path.join(source.hooksDirectory, phase), `${source.displayPrefix}/${phase}`)));
  return perSource.flat();
}

/** Registry over a workspace's hook scripts, from one or more sources. Re-discovers on each phase call — hooks are cheap to list and a project's own scripts can change between turns without restarting Nova. */
export class HookRegistry {
  constructor(private readonly sources: readonly HookSource[], private readonly workspace: NovaWorkspace) {}

  /** The top-level `.nova/hooks` directory only — the common case. */
  static local(root: string, workspace: NovaWorkspace): HookRegistry {
    return new HookRegistry([{ hooksDirectory: path.join(root, HOOKS_DIRECTORY), displayPrefix: HOOKS_DIRECTORY }], workspace);
  }

  async runPreToolUse(toolName: string, argumentsValue: Record<string, unknown>): Promise<PreToolUseOutcome> {
    const scripts = await scriptsFromSources(this.sources, "pre-tool-use");
    for (const script of scripts) {
      const result = await runHookScript(this.workspace, script, { event: "pre_tool_use", toolName, arguments: argumentsValue });
      if (result.exitCode !== 0) {
        return { blocked: true, reason: result.stderr.trim() || `Blocked by ${script} (exit ${result.exitCode})` };
      }
    }
    return { blocked: false };
  }

  /** Never throws — a broken or hanging post-hook must not turn an already-completed tool call into an error. */
  async runPostToolUse(toolName: string, argumentsValue: Record<string, unknown>, result: { content: string; isError: boolean }): Promise<string[]> {
    const scripts = await scriptsFromSources(this.sources, "post-tool-use");
    const warnings: string[] = [];
    for (const script of scripts) {
      try {
        const hookResult = await runHookScript(this.workspace, script, { event: "post_tool_use", toolName, arguments: argumentsValue, result });
        if (hookResult.exitCode !== 0) warnings.push(hookResult.stderr.trim() || `${script} exited ${hookResult.exitCode}`);
      } catch (error) {
        warnings.push(error instanceof Error ? error.message : String(error));
      }
    }
    return warnings;
  }
}
