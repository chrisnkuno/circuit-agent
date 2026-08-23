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
 * Discovery and execution both go through `NovaWorkspace`, so a hook committed to a repository
 * behaves the same on a local, E2B or Docker session — and running one is subject to the same
 * containment and environment sanitization as `run_command`, since it *is* a `runCommand` call.
 */
export type HookEvent =
  | { event: "pre_tool_use"; toolName: string; arguments: Record<string, unknown> }
  | { event: "post_tool_use"; toolName: string; arguments: Record<string, unknown>; result: { content: string; isError: boolean } };

export const HOOKS_DIRECTORY = ".nova/hooks";
const HOOK_TIMEOUT_MS = 5_000;

/** Every script directly under `phaseDirectory`, sorted for a deterministic run order. */
async function scriptsIn(workspace: NovaWorkspace, phaseDirectory: string): Promise<string[]> {
  const files = await workspace.listConfigFiles(phaseDirectory);
  // Directly under, not nested: a hook script's own helper files are not themselves hooks.
  return files.filter((file) => !file.slice(phaseDirectory.length + 1).includes("/")).sort();
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
  return workspace.runCommand(hookCommand(scriptPath, payload, workspace.commandPlatform), HOOK_TIMEOUT_MS);
}

/**
 * The invocation that sets `NOVA_HOOK_EVENT_B64` for one hook script, per shell.
 *
 * `env VAR=value program` is a POSIX idiom and `env` is not a program on Windows at all, so the
 * original spelling did not merely misbehave under cmd.exe — it failed to find anything to run.
 * cmd's own equivalent is `set` followed by the command, which needs `&&` and therefore a real
 * shell; `hasShellSyntax` sees the `&&` and routes it accordingly, which is exactly what is wanted
 * here. A base64 payload never contains a character either shell treats as special, so neither
 * form needs quoting around it.
 */
export function hookCommand(scriptPath: string, payload: string, platform: NodeJS.Platform): string {
  if (platform !== "win32") return `env NOVA_HOOK_EVENT_B64=${payload} ${scriptPath}`;
  return `set "NOVA_HOOK_EVENT_B64=${payload}"&& call "${scriptPath.split("/").join("\\")}"`;
}

export type PreToolUseOutcome = { blocked: false } | { blocked: true; reason: string };

/**
 * One place hooks are discovered from — the top-level `.nova/hooks`, or a specific plugin's own.
 * Workspace-root-relative, which is both how it is displayed and the path `runCommand` executes,
 * since a hook script runs with the workspace root as its cwd.
 */
export type HookSource = string;

async function scriptsFromSources(workspace: NovaWorkspace, sources: readonly HookSource[], phase: "pre-tool-use" | "post-tool-use"): Promise<string[]> {
  const perSource = await Promise.all(sources.map((source) => scriptsIn(workspace, `${source}/${phase}`)));
  return perSource.flat();
}

/** Registry over a workspace's hook scripts, from one or more sources. Re-discovers on each phase call — hooks are cheap to list and a project's own scripts can change between turns without restarting Nova. */
export class HookRegistry {
  constructor(private readonly sources: readonly HookSource[], private readonly workspace: NovaWorkspace) {}

  /** The top-level `.nova/hooks` directory only — the common case. */
  static local(workspace: NovaWorkspace): HookRegistry {
    return new HookRegistry([HOOKS_DIRECTORY], workspace);
  }

  /**
   * Every hook script that would run, by phase, for display.
   *
   * Worth exposing precisely because a hook is otherwise invisible: it is the one mechanism here
   * that can silently block a tool call, and a script nobody remembers adding is indistinguishable
   * from a bug in Nova unless something can show that it exists.
   */
  async list(): Promise<{ preToolUse: string[]; postToolUse: string[] }> {
    const [preToolUse, postToolUse] = await Promise.all([
      scriptsFromSources(this.workspace, this.sources, "pre-tool-use"),
      scriptsFromSources(this.workspace, this.sources, "post-tool-use"),
    ]);
    return { preToolUse, postToolUse };
  }

  async runPreToolUse(toolName: string, argumentsValue: Record<string, unknown>): Promise<PreToolUseOutcome> {
    const scripts = await scriptsFromSources(this.workspace, this.sources, "pre-tool-use");
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
    const scripts = await scriptsFromSources(this.workspace, this.sources, "post-tool-use");
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
