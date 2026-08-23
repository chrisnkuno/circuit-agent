import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as pty from "node-pty";

/**
 * Drives the real Nova CLI binary under a pseudo-terminal.
 *
 * `child_process.spawn` with piped stdio is not a substitute: `nova.ts` refuses to run
 * interactively without `process.stdin.isTTY`, and readline's line editing, history and the
 * approval prompt all depend on real terminal semantics (echo, Ctrl+C as a signal, SIGWINCH on
 * resize) that a pipe does not have.
 */

const NOVA_ENTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../nova.ts");

/** node-pty's macOS posix_spawnp binding does not reliably search PATH. */
export function bunExecutable(environment = process.env): string {
  const names = process.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
  for (const directory of (environment.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return "bun";
}

export type SpawnNovaOptions = {
  args?: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  cols?: number;
  rows?: number;
};

export type WaitOptions = {
  timeoutMs?: number;
  /** Only match text written from this point on — a fresh occurrence, not one already on screen. */
  since?: number;
};

export type NovaProcess = {
  write(data: string): void;
  /** Enter, as a real terminal sends it — readline treats bare "\n" as a paste, not a submit. */
  writeLine(data: string): void;
  resize(cols: number, rows: number): void;
  output(): string;
  /** Resolves with the buffer once `pattern` appears, so a caller can slice from this length with `since`. */
  waitFor(pattern: string | RegExp, options?: WaitOptions): Promise<string>;
  waitForExit(timeoutMs?: number): Promise<{ exitCode: number; signal?: number }>;
  kill(signal?: string): void;
};

const DEFAULT_TIMEOUT_MS = 20_000;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function spawnNova(options: SpawnNovaOptions): NovaProcess {
  const proc = pty.spawn(bunExecutable(), ["run", NOVA_ENTRY, ...(options.args ?? [])], {
    name: "xterm-color",
    cols: options.cols ?? 100,
    rows: options.rows ?? 30,
    cwd: options.cwd,
    // Trimmed of undefined values: node-pty's types accept them, but some platforms' underlying
    // spawn rejects an environment record containing them outright.
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        // PTY feature tests own their model endpoint but not the public package registry. A fresh
        // config directory otherwise makes every boot eligible for a real daily update check,
        // adding nondeterministic network latency to tests that are about tabs, guides, or layout.
        // An update-specific test can still opt back in explicitly through options.env.
        NOVA_AUTO_UPDATE: "off",
        ...options.env,
      }).filter(([, value]) => value !== undefined),
    ) as Record<string, string>,
  });

  let buffer = "";
  const waiters: Array<{ pattern: RegExp; since: number; settle: (value: string) => void }> = [];
  proc.onData((chunk) => {
    buffer += chunk;
    // Copied before iterating: a waiter's settle can synchronously queue a new waitFor call (the
    // common "wait, act, wait again" shape), and mutating `waiters` mid-iteration would either
    // skip or double-serve the new entry.
    for (const waiter of [...waiters]) {
      if (waiter.pattern.test(buffer.slice(waiter.since))) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.settle(buffer);
      }
    }
  });

  let settleExit!: (value: { exitCode: number; signal?: number }) => void;
  const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => { settleExit = resolve; });
  proc.onExit(({ exitCode, signal }) => settleExit({ exitCode, signal }));

  return {
    write: (data) => proc.write(data),
    writeLine: (data) => proc.write(`${data}\r`),
    resize: (cols, rows) => proc.resize(cols, rows),
    output: () => buffer,
    waitFor: (pattern, waitOptions = {}) => {
      const regex = typeof pattern === "string" ? new RegExp(escapeRegExp(pattern)) : pattern;
      const since = waitOptions.since ?? 0;
      if (regex.test(buffer.slice(since))) return Promise.resolve(buffer);
      const timeoutMs = waitOptions.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      return new Promise((resolve, reject) => {
        const waiter = {
          pattern: regex,
          since,
          settle: (value: string) => { clearTimeout(timer); resolve(value); },
        };
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${regex} in pty output:\n${buffer.slice(since)}`));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    waitForExit: (timeoutMs = DEFAULT_TIMEOUT_MS) => new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Process did not exit within ${timeoutMs}ms; output so far:\n${buffer}`)),
        timeoutMs,
      );
      exited.then((result) => {
        clearTimeout(timeout);
        resolve(result);
      });
    }),
    kill: (signal) => proc.kill(signal),
  };
}
