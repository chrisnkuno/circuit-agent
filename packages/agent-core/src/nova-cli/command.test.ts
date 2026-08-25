import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NOVA_CREDENTIAL_ENV_NAMES,
  hasShellSyntax,
  resetProcessContainmentProbe,
  runLocalCommand,
  sanitizeCommandEnvironment,
  tokenizeCommand,
} from "./command";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-command-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("local command executor", () => {
  it("uses argv semantics for ordinary commands and preserves quoted arguments", async () => {
    expect(tokenizeCommand('node -e "console.log(123)"')).toEqual(["node", "-e", "console.log(123)"]);
    expect(hasShellSyntax('node -e "console.log(123)"')).toBe(false);
    const result = await runLocalCommand("printf %s direct", { cwd: root, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "direct" });
  });

  it("preserves Windows path separators in direct argv commands", () => {
    expect(tokenizeCommand('node C:\\Users\\Nova\\project\\script.js "C:\\Program Files\\Nova\\config.json"', "win32"))
      .toEqual(["node", "C:\\Users\\Nova\\project\\script.js", "C:\\Program Files\\Nova\\config.json"]);
  });

  it("uses the explicit shell path only when syntax requires it", async () => {
    expect(hasShellSyntax("printf first && printf second")).toBe(true);
    const result = await runLocalCommand("printf first && printf second", { cwd: root, timeoutMs: 5_000 });
    expect(result).toMatchObject({ exitCode: 0, stdout: "firstsecond" });
  });

  it("terminates a timed-out process with a classified exit code", async () => {
    const result = await runLocalCommand('node -e "setTimeout(() => {}, 10000)"', { cwd: root, timeoutMs: 20 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("exceeded 20ms");
  });

  it("terminates the in-flight process tree when the caller cancels", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runLocalCommand('node -e "setTimeout(() => {}, 10000)"', {
      cwd: root,
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 40);
    const result = await pending;
    expect(result.exitCode).toBe(130);
    expect(result.stderr).toContain("cancelled");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("never starts a command whose signal is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await runLocalCommand("touch should-not-exist", { cwd: root, timeoutMs: 5_000, signal: controller.signal });
    expect(result.exitCode).toBe(130);
    await expect(fs.access(path.join(root, "should-not-exist"))).rejects.toThrow();
  });
});

describe("sanitizing a spawned command's environment", () => {
  it("strips every credential Nova itself reads from the environment", () => {
    const source = Object.fromEntries(NOVA_CREDENTIAL_ENV_NAMES.map((name) => [name, "secret-value"]));
    const sanitized = sanitizeCommandEnvironment({ ...source, PATH: "/usr/bin", HOME: "/home/user" });
    for (const name of NOVA_CREDENTIAL_ENV_NAMES) expect(sanitized).not.toHaveProperty(name);
    expect(sanitized.PATH).toBe("/usr/bin");
    expect(sanitized.HOME).toBe("/home/user");
  });

  it("keeps a project's own credential-shaped variables by default", () => {
    // The user exported these into their own shell before Nova ever ran — that is their choice
    // about their own environment, not a leak Nova is responsible for closing unasked.
    const sanitized = sanitizeCommandEnvironment({ GITHUB_TOKEN: "ghp_x", DATABASE_PASSWORD: "hunter2", STRIPE_PUBLISHABLE_KEY: "pk_live_x" });
    expect(sanitized).toMatchObject({ GITHUB_TOKEN: "ghp_x", DATABASE_PASSWORD: "hunter2", STRIPE_PUBLISHABLE_KEY: "pk_live_x" });
  });

  it("strips credential-shaped variables generically when strict mode is requested", () => {
    const sanitized = sanitizeCommandEnvironment(
      { GITHUB_TOKEN: "ghp_x", DATABASE_PASSWORD: "hunter2", MY_APP_SECRET: "s", PATH: "/usr/bin" },
      { strict: true },
    );
    expect(sanitized).not.toHaveProperty("GITHUB_TOKEN");
    expect(sanitized).not.toHaveProperty("DATABASE_PASSWORD");
    expect(sanitized).not.toHaveProperty("MY_APP_SECRET");
    expect(sanitized.PATH).toBe("/usr/bin"); // ordinary variables still pass through untouched
  });

  it("does not throw on an environment missing values entirely", () => {
    expect(() => sanitizeCommandEnvironment({})).not.toThrow();
  });
});

describe("environment sanitization through a real spawned process", () => {
  // Verified live before the fix existed: `runLocalCommand("env", ...)` printed
  // `ANTHROPIC_API_KEY=sk-ant-...` in full, because `child_process.spawn` inherits the entire
  // parent environment by default. These run the real subprocess, not a mock of it — a fix to the
  // options object passed to `spawn` is worth nothing if `spawn` does not actually honour it.
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("keeps a locally spawned command from ever seeing Nova's own API keys", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-live-secret-value";
    process.env.OPENAI_API_KEY = "sk-openai-live-secret-value";
    const result = await runLocalCommand("env", { cwd: root, timeoutMs: 5_000 });
    expect(result.stdout).not.toContain("sk-ant-live-secret-value");
    expect(result.stdout).not.toContain("sk-openai-live-secret-value");
    expect(result.stdout).not.toContain("ANTHROPIC_API_KEY");
  });

  it("still runs normally — PATH and ordinary variables reach the command", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-live-secret-value";
    const result = await runLocalCommand("env", { cwd: root, timeoutMs: 5_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("PATH=");
  });

  it("keeps a project's own env var by default, but strips it when strictEnvironment is set", async () => {
    process.env.MY_PROJECT_TOKEN = "project-owned-secret";
    const relaxed = await runLocalCommand("env", { cwd: root, timeoutMs: 5_000 });
    expect(relaxed.stdout).toContain("project-owned-secret");

    const strict = await runLocalCommand("env", { cwd: root, timeoutMs: 5_000, strictEnvironment: true });
    expect(strict.stdout).not.toContain("project-owned-secret");
  });
});

describe("OS-level process-tree containment", () => {
  // Probed once, synchronously, so every test below can decide up front whether this machine can
  // actually run an unprivileged PID namespace rather than failing confusingly mid-test if not.
  const containmentWorks = (() => {
    const probe = spawnSync("unshare", ["--user", "--pid", "--mount-proc", "--fork", "--", "true"], { stdio: "ignore" });
    return probe.status === 0;
  })();

  beforeEach(() => resetProcessContainmentProbe());
  afterEach(() => resetProcessContainmentProbe());

  it.skipIf(!containmentWorks)(
    "kills a self-detaching grandchild that process-group termination alone cannot reach",
    async () => {
      // Mirrors the standalone probe that found the gap: the spawned command backgrounds its own
      // detached grandchild (exactly what `runLocalCommand` itself does one level up), which puts
      // it in a new process group that a group-kill of the parent never reaches.
      const marker = path.join(root, "grandchild-alive.txt");
      const script = `
        const { spawn } = require('node:child_process');
        spawn('node', ['-e', \`
          const fs = require('node:fs');
          setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 100);
        \`], { detached: true, stdio: 'ignore' }).unref();
        setTimeout(() => {}, 30000);
      `;
      const result = await runLocalCommand(`node -e "${script.replace(/"/g, '\\"')}"`, { cwd: root, timeoutMs: 300 });
      expect(result.exitCode).toBe(124);

      const heartbeatAtTimeout = await fs.readFile(marker, "utf8").catch(() => null);
      expect(heartbeatAtTimeout).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 1_200));
      const heartbeatAfterWait = await fs.readFile(marker, "utf8");
      // A live grandchild would have overwritten this well within the 1.2s wait; a namespace whose
      // PID-1 (the timed-out parent) died takes every process still inside it down at the same time.
      expect(Number(heartbeatAfterWait)).toBe(Number(heartbeatAtTimeout));
    },
  );

  it.skipIf(!containmentWorks)("still reports stdout, stderr, exit code and cwd correctly when contained", async () => {
    const result = await runLocalCommand("node -e \"console.error('to-stderr'); console.log(process.cwd()); process.exit(42)\"", {
      cwd: root,
      timeoutMs: 5_000,
    });
    expect(result.exitCode).toBe(42);
    expect(result.stderr).toContain("to-stderr");
    expect(result.stdout.trim()).toBe(await fs.realpath(root));
  });

  it("bypasses containment entirely when containProcessTree is false", async () => {
    const result = await runLocalCommand("printf %s uncontained", { cwd: root, timeoutMs: 5_000, containProcessTree: false });
    expect(result).toMatchObject({ exitCode: 0, stdout: "uncontained" });
  });

  it("caches the containment probe across calls until reset", async () => {
    resetProcessContainmentProbe();
    const first = await runLocalCommand("printf %s a", { cwd: root, timeoutMs: 5_000 });
    const second = await runLocalCommand("printf %s b", { cwd: root, timeoutMs: 5_000 });
    expect(first).toMatchObject({ exitCode: 0, stdout: "a" });
    expect(second).toMatchObject({ exitCode: 0, stdout: "b" });
  });
});
