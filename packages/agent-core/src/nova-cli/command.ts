import { spawn } from "node:child_process";

export type CommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/** Minimal shell-compatible tokenization for the direct-exec fast path. */
export function tokenizeCommand(command: string, platform: NodeJS.Platform = process.platform): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  let hasToken = false;

  for (const character of command) {
    if (escaped) { current += character; escaped = false; hasToken = true; continue; }
    // A Windows backslash is normally a path separator, not a Unix escape. Shell syntax takes the
    // platform shell path below; direct argv execution must preserve `C:\\Users\\...` exactly.
    if (character === "\\" && quote !== "'" && platform !== "win32") { escaped = true; hasToken = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      else current += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; hasToken = true; continue; }
    if (/\s/.test(character)) {
      if (hasToken) { tokens.push(current); current = ""; hasToken = false; }
      continue;
    }
    current += character;
    hasToken = true;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unbalanced quote in command");
  if (hasToken) tokens.push(current);
  if (tokens.length === 0) throw new Error("Command is empty");
  return tokens;
}

const SHELL_METACHARACTERS = /[|&;><`$()]|\|\||&&/;

export function hasShellSyntax(command: string): boolean {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) {
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (SHELL_METACHARACTERS.test(character)) return true;
  }
  return false;
}

function terminateProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else {
      // Windows has no Unix process groups. taskkill /T is the native equivalent and prevents a
      // timed-out test runner from leaving compilers or dev servers behind.
      spawn("taskkill", ["/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])], {
        detached: false,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    }
  } catch {
    // The process may have exited between the event and the signal.
  }
}

/**
 * Direct argv execution is the common, faster path. Shell mode exists only when the exact approved
 * action contains shell syntax. Both paths have bounded output and process-tree cancellation.
 */
export const runLocalCommand: CommandRunner = (command, options) =>
  new Promise((resolve) => {
    const throughShell = hasShellSyntax(command);
    let program: string;
    let argv: string[];
    try {
      [program, ...argv] = throughShell ? [command] : tokenizeCommand(command);
    } catch (error) {
      resolve({ exitCode: 2, stdout: "", stderr: error instanceof Error ? error.message : "Invalid command" });
      return;
    }

    const child = spawn(program, argv, {
      cwd: options.cwd,
      shell: throughShell,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maximumOutputBytes = 2 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forcedExitCode: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout>;
    let closedCode: number | null | undefined;
    let stdoutEnded = false;
    let stderrEnded = false;

    const terminate = () => {
      terminateProcessTree(child.pid, "SIGTERM");
      killTimer ??= setTimeout(() => {
        if (!settled) terminateProcessTree(child.pid, "SIGKILL");
      }, 500);
    };

    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      resolve({ exitCode: forcedExitCode ?? exitCode, stdout, stderr });
    };
    const append = (target: "stdout" | "stderr", chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = maximumOutputBytes - outputBytes;
      if (remaining > 0) {
        const text = buffer.subarray(0, remaining).toString("utf8");
        if (target === "stdout") stdout += text;
        else stderr += text;
        outputBytes += Math.min(buffer.length, remaining);
      }
      if (buffer.length > remaining && forcedExitCode === null) {
        forcedExitCode = 125;
        stderr += `\nCommand exceeded the ${maximumOutputBytes}-byte output limit and was killed.`;
        terminate();
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));
    const finishWhenDrained = () => {
      if (closedCode !== undefined && stdoutEnded && stderrEnded) finish(closedCode ?? 0);
    };
    child.stdout.on("end", () => { stdoutEnded = true; finishWhenDrained(); });
    child.stderr.on("end", () => { stderrEnded = true; finishWhenDrained(); });
    child.on("error", (error) => {
      if (settled) return;
      stderr += error.message;
      finish(127);
    });
    child.on("close", (code) => { closedCode = code; finishWhenDrained(); });

    timeout = setTimeout(() => {
      if (settled) return;
      forcedExitCode = 124;
      stderr += `\nCommand exceeded ${options.timeoutMs}ms and was killed.`;
      terminate();
    }, options.timeoutMs);
  });

/** Backward-compatible name while callers move to the executor terminology. */
export const runShellCommand = runLocalCommand;
