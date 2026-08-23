import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { hasShellSyntax } from "./command";
import { HookRegistry, hookCommand } from "./hooks";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-hooks-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Writes an executable script that decodes NOVA_HOOK_EVENT_B64 and acts on it — a real script, not a mock. */
async function writeHookScript(scriptPath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  if (process.platform === "win32") {
    const windowsPath = scriptPath.replace(/\.sh$/, ".cmd");
    let windowsBody = body
      .replace(/echo '([^']*)' >&2/g, "echo $1 1>&2")
      .replace(/echo (\w+) >> (.+)/g, 'echo $1>>"$2"')
      .replace(/^exit (\d+)$/gm, "exit /b $1");
    if (body.includes("payload=$(")) {
      windowsBody = `node -e "const p=Buffer.from(process.env.NOVA_HOOK_EVENT_B64,'base64').toString();process.exit(p.includes('\\\"toolName\\\":\\\"run_command\\\"')&&p.includes('\\\"command\\\":\\\"rm -rf /tmp/x\\\"')?0:1)"`;
    }
    await fs.writeFile(windowsPath, `@echo off\r\n${windowsBody.replaceAll("\n", "\r\n")}\r\n`);
    return;
  }
  await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe("hook invocation across shells", () => {
  it("uses env(1) on POSIX, where it is a real program", () => {
    expect(hookCommand(".nova/hooks/pre-tool-use/x.sh", "eyJhIjoxfQ==", "linux"))
      .toBe("env NOVA_HOOK_EVENT_B64=eyJhIjoxfQ== .nova/hooks/pre-tool-use/x.sh");
  });

  it("uses cmd's own `set &&` on Windows, where env(1) does not exist to be found", () => {
    // The POSIX spelling did not merely misbehave under cmd.exe — `env` is not a program there, so
    // there was nothing to run at all.
    const command = hookCommand(".nova/hooks/pre-tool-use/x.cmd", "eyJhIjoxfQ==", "win32");
    expect(command).toBe('set "NOVA_HOOK_EVENT_B64=eyJhIjoxfQ=="&& call ".nova\\hooks\\pre-tool-use\\x.cmd"');
    expect(command).not.toContain("env ");
  });

  it("produces a Windows command the executor will route through a shell, since `set` needs one", () => {
    expect(hasShellSyntax(hookCommand(".nova/hooks/pre-tool-use/x.cmd", "abc==", "win32"))).toBe(true);
  });
});

describe("HookRegistry.local pre-tool-use", () => {
  it("runs with no hooks present — never blocks", async () => {
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPreToolUse("write_file", { path: "a.txt" })).resolves.toEqual({ blocked: false });
  });

  it("lets an allowing hook (exit 0) through", async () => {
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/allow.sh"), "exit 0");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPreToolUse("write_file", { path: "a.txt" })).resolves.toEqual({ blocked: false });
  });

  it("blocks on a non-zero exit and surfaces the hook's own stderr as the reason", async () => {
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/deny.sh"), "echo 'no writes to secrets' >&2\nexit 1");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const outcome = await registry.runPreToolUse("write_file", { path: "secrets.env" });
    expect(outcome).toEqual({ blocked: true, reason: "no writes to secrets" });
  });

  it("actually decodes the real event payload the hook receives on stdin's env var, not a fake one", async () => {
    // Proves the wiring end to end: a script that decodes NOVA_HOOK_EVENT_B64 and checks the real
    // fields sees the real tool name and arguments this call was made with.
    await writeHookScript(
      path.join(root, ".nova/hooks/pre-tool-use/inspect.sh"),
      [
        `payload=$(echo "$NOVA_HOOK_EVENT_B64" | base64 -d)`,
        `case "$payload" in *'"toolName":"run_command"'*'"command":"rm -rf /tmp/x"'*) exit 0 ;; *) echo "unexpected payload: $payload" >&2; exit 1 ;; esac`,
      ].join("\n"),
    );
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const outcome = await registry.runPreToolUse("run_command", { command: "rm -rf /tmp/x" });
    expect(outcome).toEqual({ blocked: false });
  });

  it("runs multiple hooks in a deterministic (sorted) order and stops at the first block", async () => {
    const order = path.join(root, "order.log");
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/1-first.sh"), `echo first >> ${order}\nexit 0`);
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/2-second.sh"), `echo second >> ${order}\nexit 1`);
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/3-third.sh"), `echo third >> ${order}\nexit 0`);
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const outcome = await registry.runPreToolUse("write_file", { path: "a.txt" });
    expect(outcome.blocked).toBe(true);
    const log = await fs.readFile(order, "utf8");
    expect(log.trim().split(/\r?\n/)).toEqual(["first", "second"]); // never reached the third
  });
});

describe("HookRegistry.local post-tool-use", () => {
  it("returns no warnings when nothing is registered", async () => {
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPostToolUse("write_file", { path: "a.txt" }, { content: "ok", isError: false })).resolves.toEqual([]);
  });

  it("collects a warning from a failing post-hook without throwing", async () => {
    await writeHookScript(path.join(root, ".nova/hooks/post-tool-use/audit.sh"), "echo 'file left uncommitted' >&2\nexit 1");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const warnings = await registry.runPostToolUse("write_file", { path: "a.txt" }, { content: "wrote it", isError: false });
    expect(warnings).toEqual(["file left uncommitted"]);
  });
});
