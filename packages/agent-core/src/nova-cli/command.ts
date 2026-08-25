import { spawn } from "node:child_process";

export type CommandRunner = (
  command: string,
  options: { cwd: string; timeoutMs: number; strictEnvironment?: boolean; containProcessTree?: boolean; signal?: AbortSignal },
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

/**
 * Nova's own provider credentials, read directly from the code that reads them — not a second,
 * hand-maintained list. Every one of these is something Nova holds on the user's behalf and a
 * spawned command has no legitimate reason to see: unlike a project's own `.env`-loaded secrets
 * (the user's own choice, made before Nova ever ran), these are Nova's, and leaking them is a
 * defect regardless of what the command was asked to do with them.
 *
 * Verified live before this existed: `runCommand({ command: "env" })` printed
 * `ANTHROPIC_API_KEY=sk-ant-...` in full, because `child_process.spawn` inherits the entire
 * parent environment by default and nothing here overrode that.
 */
export const NOVA_CREDENTIAL_ENV_NAMES = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "CIRCUITNOTION_API_KEY",
  "CIRCUITNOTION_RELAY_SECRET",
  "E2B_API_KEY",
  // The billing key can move money. A spawned build script has even less business seeing it than
  // a model key, and it arrived in the environment the same way every other one did.
  "NOVA_BILLING_KEY",
  "EXA_API_KEY",
] as const;

/**
 * Credential-shaped variable names generically — `*_TOKEN`, `*_SECRET`, and so on — for a caller
 * that wants more than "not Nova's own keys." Off by default: a project's own `GITHUB_TOKEN` or
 * `DATABASE_PASSWORD`, exported into the shell before Nova ever started, is the user's own choice
 * about their own environment, not a leak Nova is responsible for. Stripping it by default would
 * silently break whatever legitimate local command the user actually wanted `run_command` to run.
 */
const SENSITIVE_SHAPED_ENV_PATTERN = /(API[_-]?KEY|ACCESS[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE[_-]?KEY)/i;

export type SanitizeEnvironmentOptions = {
  /** Also strips anything shaped like a credential, not only Nova's own known names. Default false. */
  strict?: boolean;
};

/**
 * The environment a locally spawned command actually receives: the parent's own environment, with
 * Nova's credentials removed. `PATH`, `HOME`, `LANG` and everything else a command needs to run
 * normally are untouched — none of them are shaped like a secret.
 */
// A plain string dict rather than `NodeJS.ProcessEnv` — this repo's Next.js types augment
// `ProcessEnv` to require `NODE_ENV`, which every caller of a `NodeJS.ProcessEnv`-typed function
// would then also have to satisfy for no reason connected to what this function actually does
// (filter key/value pairs). The one place the distinction matters, handing the result to
// `child_process.spawn`, casts at that boundary instead of infecting every caller.
export type EnvironmentDict = Record<string, string | undefined>;

export function sanitizeCommandEnvironment(
  env: EnvironmentDict = process.env,
  options: SanitizeEnvironmentOptions = {},
): EnvironmentDict {
  const sanitized: EnvironmentDict = { ...env };
  const blocked = new Set<string>(NOVA_CREDENTIAL_ENV_NAMES);
  for (const key of Object.keys(sanitized)) {
    if (blocked.has(key) || (options.strict && SENSITIVE_SHAPED_ENV_PATTERN.test(key))) delete sanitized[key];
  }
  return sanitized;
}

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

/**
 * Whether a token, appearing after the program name, sets a given flag — short form combined with
 * others (`-rf`, `-fr`, `-Rf`) or long form (`--recursive`).
 *
 * A regex checking for `-rf` as a literal substring misses `-fr` (same flags, opposite order) and
 * every long-form GNU spelling — three ways to ask for the same thing, and a denylist that only
 * recognizes one of them protects against nothing but the laziest attempt. Tokenizing first and
 * checking flag membership catches all of them the same way, because it is checking what the flag
 * *means* rather than which of its several spellings appears in the string.
 */
function hasFlag(tokens: readonly string[], shortLetter: string, long: string): boolean {
  return tokens.some((token) => {
    if (token === long) return true;
    if (token.startsWith("--") || !/^-[a-zA-Z]+$/.test(token)) return false;
    return token.slice(1).includes(shortLetter);
  });
}

/** Wrappers common enough to be worth seeing through: `sudo rm -rf /` is still `rm -rf /`. */
const COMMAND_WRAPPERS = new Set(["sudo"]);

/**
 * The index of `program` as the actual command being run, or -1.
 *
 * Deliberately only position 0 (or position 1 behind a bare wrapper), never "anywhere in the
 * token list" — the first version of this scanned every token for a match, which flagged
 * `git rm -rf some-directory` as the destructive filesystem `rm`. It is not: `rm` there is a git
 * subcommand for removing a *tracked* file, fully recoverable from history, and refusing it
 * outright would be refusing an ordinary, safe operation because a substring happened to match.
 * The command actually being executed is what its first token names, not any token that appears
 * to resemble it.
 */
function programIndex(tokens: readonly string[], program: string): number {
  if (tokens[0]?.toLowerCase() === program) return 0;
  if (tokens[0] && COMMAND_WRAPPERS.has(tokens[0].toLowerCase()) && tokens[1]?.toLowerCase() === program) return 1;
  return -1;
}

/**
 * `rm` with both recursive and force in force, in any order and any spelling.
 *
 * Falls back to "not a match" on anything `tokenizeCommand` cannot parse (an unbalanced quote)
 * rather than throwing — a malformed command is the caller's problem to report, not this check's
 * to crash on, and a regex-based caller upstream of this one still gets a chance to catch it.
 */
export function isRecursiveForceRemoval(command: string): boolean {
  let tokens: string[];
  try { tokens = tokenizeCommand(command); } catch { return false; }
  const rmIndex = programIndex(tokens, "rm");
  if (rmIndex === -1) return false;
  const flags = tokens.slice(rmIndex + 1);
  const recursive = hasFlag(flags, "r", "--recursive") || hasFlag(flags, "R", "--recursive");
  const force = hasFlag(flags, "f", "--force");
  return recursive && force;
}

/** `find ... -delete` — as thorough a tree wipe as `rm -rf`, and unrelated to it by name alone. */
export function isFindDelete(command: string): boolean {
  let tokens: string[];
  try { tokens = tokenizeCommand(command); } catch { return false; }
  const findIndex = programIndex(tokens, "find");
  if (findIndex === -1) return false;
  return tokens.slice(findIndex + 1).includes("-delete");
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
 * What OS-level containment for a locally spawned command does and does not cover.
 *
 * It is not a sandbox, and nothing here should be read as one. What it covers is the process
 * *tree*: a PID namespace no child can escape by detaching, so a timeout or a cancel reaches
 * everything the command started. That is lifecycle hygiene, not a security boundary.
 *
 * A command run through `run_command` has the full authority of the user who started Nova. It can
 * read and write any file that user can, inside the workspace or far outside it, and reach the
 * network. Verified by probing it, not assumed: with containment active, `cat ../secrets`,
 * `echo > ~/anything` and a DNS lookup all succeed. The `resolveInWorkspace` path confinement in
 * `workspace.ts` constrains the *file tools* — `read_file`, `write_file`, `edit_file`, whose
 * arguments it resolves — and a shell command's arguments never pass through it. An earlier version
 * of this comment claimed the filesystem was covered by citing that code, which conflated the two
 * and would have told a reader the opposite of the truth.
 *
 * What actually stands between a destructive command and the disk is therefore the layer above:
 * `isRefusedCommand` for the handful that are never worth running, `assessToolSafety` for the ones
 * auto mode must not wave through, and a human reading the approval prompt for everything else in
 * build mode. Real isolation means the E2B or Docker backend, where the boundary is the container.
 *
 * Does not cover network egress either, and cannot from here. Blocking it requires either a privileged
 * kernel feature this process does not have (a network namespace, iptables rules) or an unprivileged
 * one that does not exist as a per-process knob on Linux — there is no equivalent of `unshare --pid`
 * for "this process tree gets no sockets." When network containment actually matters, the existing
 * E2B and Docker workspace backends are the correct place to enforce it: both already run the
 * command in a real container, where `allowInternetAccess: false` / `--network=none` is the
 * environment's own guarantee rather than something this process could fake from inside itself. A
 * local command that needs network isolation should run through one of those backends, not through
 * `LocalWorkspace` with an assurance this file cannot actually make good on.
 */
const CONTAINMENT_ARGS = ["--user", "--pid", "--mount-proc", "--fork", "--"] as const;

let containmentAvailability: Promise<boolean> | null = null;

/**
 * Whether this machine can run a command inside a PID namespace Nova fully controls.
 *
 * `terminateProcessTree` kills a process *group* — every process that shares the group id it was
 * spawned with. That misses a real case, found by actually spawning one and checking: a command
 * that spawns its own detached grandchild (a dev server backgrounding a file watcher, or nothing
 * more adversarial than a script calling `spawn(..., { detached: true })` the same way this
 * codebase's own `runLocalCommand` does) puts that grandchild into a *new* process group, which a
 * group-kill of the parent's group never reaches. It survives Nova's cancel or timeout indefinitely.
 *
 * `unshare --user --pid` costs nothing in privilege — no root, no capability, just an unprivileged
 * Linux user+PID namespace — and the kernel's own PID-namespace teardown rule closes the gap
 * completely: when a namespace's PID-1 process dies for any reason, every other process still in
 * that namespace is killed with it, however many times it detached from whatever it started as.
 * Confirmed against a real self-detaching grandchild before this was wired in: without this, it
 * kept writing a heartbeat file 1.5 seconds after the parent was killed; with it, no heartbeat
 * after the kill at all.
 *
 * Checked once per process and cached — the answer cannot change while Nova is running, and
 * spawning `unshare` to find out is not free. Unavailable everywhere without a working `unshare`
 * (non-Linux, or a kernel/policy that has disabled unprivileged user namespaces): the command still
 * runs, with the same process-*group* containment this codebase already had.
 */
function isProcessContainmentAvailable(): Promise<boolean> {
  containmentAvailability ??= new Promise((resolve) => {
    // Namespaces are a Linux kernel feature; nothing else can have them however the probe behaves.
    // Spawning `unshare` on Windows or macOS to be told so costs a process launch on the first
    // command of every session, and on Windows would surface as a spurious ENOENT for a program the
    // user never asked for. `terminateProcessTree` already has its own win32 path (taskkill /T).
    if (process.platform !== "linux") {
      resolve(false);
      return;
    }
    let probe: ReturnType<typeof spawn>;
    try {
      probe = spawn("unshare", [...CONTAINMENT_ARGS, "true"], { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => { probe.kill("SIGKILL"); resolve(false); }, 2_000);
    probe.on("error", () => { clearTimeout(timer); resolve(false); });
    probe.on("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
  return containmentAvailability;
}

/** Exposed for tests only — a fresh process should re-probe rather than trust a stale answer. */
export function resetProcessContainmentProbe(): void {
  containmentAvailability = null;
}

/**
 * Direct argv execution is the common, faster path. Shell mode exists only when the exact approved
 * action contains shell syntax. Both paths have bounded output and process-tree cancellation.
 */
export const runLocalCommand: CommandRunner = async (command, options) => {
  if (options.signal?.aborted) return { exitCode: 130, stdout: "", stderr: "Command cancelled before start." };
  let throughShell = hasShellSyntax(command);
  let program: string;
  let argv: string[];
  try {
    [program, ...argv] = throughShell ? [command] : tokenizeCommand(command);
  } catch (error) {
    return { exitCode: 2, stdout: "", stderr: error instanceof Error ? error.message : "Invalid command" };
  }

  if (options.containProcessTree !== false && await isProcessContainmentAvailable()) {
    // unshare needs its own argv, not a shell string — a command that needed a shell still gets
    // one, just as `sh -c` explicitly inside the namespace rather than via spawn's own shell mode.
    const inner = throughShell ? ["sh", "-c", command] : [program, ...argv];
    program = "unshare";
    argv = [...CONTAINMENT_ARGS, ...inner];
    throughShell = false;
  }

  return new Promise((resolve) => {
    const child = spawn(program, argv, {
      cwd: options.cwd,
      shell: throughShell,
      detached: process.platform !== "win32",
      // Every locally spawned command gets Nova's own environment minus Nova's own credentials —
      // node:child_process inherits the full parent environment by default, and nothing else in
      // this function was ever going to stop that.
      env: sanitizeCommandEnvironment(process.env, { strict: options.strictEnvironment }) as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const maximumOutputBytes = 2 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let forcedExitCode: number | null = null;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abort = () => {};
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
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", abort);
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

    abort = () => {
      if (settled || forcedExitCode === 130) return;
      forcedExitCode = 130;
      stderr += "\nCommand cancelled and its process tree was terminated.";
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();

    timeout = setTimeout(() => {
      if (settled) return;
      forcedExitCode = 124;
      stderr += `\nCommand exceeded ${options.timeoutMs}ms and was killed.`;
      terminate();
    }, options.timeoutMs);
  });
};

/** Backward-compatible name while callers move to the executor terminology. */
export const runShellCommand = runLocalCommand;
