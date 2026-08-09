import { describe, expect, it, vi } from "vitest";
import type { SpawnSyncOptions } from "node:child_process";
import {
  compareVersions,
  detectPackageManager,
  fetchLatestVersion,
  NOVA_CLI_PACKAGE,
  parseSemver,
  runSelfUpdate,
  updateCommand,
} from "./update";

function registryResponse(version: string, name = NOVA_CLI_PACKAGE): Response {
  return new Response(JSON.stringify({ name, version }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("self-update version invariants", () => {
  it("accepts release and prerelease SemVer but rejects ambiguous or injectable values", () => {
    expect(parseSemver("1.2.3")).not.toBeNull();
    expect(parseSemver("1.2.3-rc.1+build.9")).not.toBeNull();
    expect(parseSemver("01.2.3")).toBeNull();
    expect(parseSemver("1.2.3;touch /tmp/nope")).toBeNull();
  });

  it("compares releases and prereleases by SemVer precedence", () => {
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("2.0.0", "1.99.99")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0+one", "1.0.0+two")).toBe(0);
  });

  it("builds argv arrays rather than shell commands and pins the checked version", () => {
    expect(updateCommand("npm", "1.2.3")).toEqual({
      command: "npm",
      args: ["install", "--global", "@circuit-nova/nova-cli@1.2.3"],
    });
    expect(updateCommand("pnpm", "1.2.3").args).toEqual(["add", "--global", "@circuit-nova/nova-cli@1.2.3"]);
    expect(updateCommand("yarn", "1.2.3").args).toEqual(["global", "add", "@circuit-nova/nova-cli@1.2.3"]);
    expect(updateCommand("bun", "1.2.3").args).toEqual(["add", "--global", "@circuit-nova/nova-cli@1.2.3"]);
    expect(() => updateCommand("npm", "latest; echo unsafe")).toThrow("invalid version");
  });
});

describe("package-manager detection", () => {
  it("honours an explicit override before every heuristic", () => {
    expect(detectPackageManager({ override: "pnpm", execPath: "/home/me/.bun/bin/bun" })).toBe("pnpm");
  });

  it("reads package-manager launch metadata and installed paths", () => {
    expect(detectPackageManager({ environment: { npm_config_user_agent: "yarn/4.9.1 npm/? node/v22" } })).toBe("yarn");
    expect(detectPackageManager({ environment: {}, modulePath: "file:///home/me/.bun/install/global/node_modules/@circuit-nova/nova-cli/dist/nova.js" })).toBe("bun");
    expect(detectPackageManager({ environment: {}, modulePath: "file:///opt/pnpm/global/5/node_modules/@circuit-nova/nova-cli/dist/nova.js" })).toBe("pnpm");
    expect(detectPackageManager({ environment: {}, execPath: "/usr/bin/node" })).toBe("npm");
  });

  it("rejects unsupported overrides instead of guessing a command", () => {
    expect(() => detectPackageManager({ override: "npx" })).toThrow("Unsupported package manager");
  });
});

describe("registry checks", () => {
  it("reads the exact package's latest valid version", async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => registryResponse("0.2.0"));
    await expect(fetchLatestVersion({ fetchImpl })).resolves.toBe("0.2.0");
    expect(String(fetchImpl.mock.calls[0][0])).toContain("%40circuit-nova%2Fnova-cli/latest");
  });

  it("rejects package substitution, invalid versions, insecure registries, and HTTP failures", async () => {
    await expect(fetchLatestVersion({ fetchImpl: async () => registryResponse("0.2.0", "other") })).rejects.toThrow("invalid Nova package record");
    await expect(fetchLatestVersion({ fetchImpl: async () => registryResponse("latest") })).rejects.toThrow("invalid Nova package record");
    await expect(fetchLatestVersion({ environment: { NOVA_UPDATE_REGISTRY: "http://registry.example" } })).rejects.toThrow("must use HTTPS");
    await expect(fetchLatestVersion({ fetchImpl: async () => new Response("no", { status: 503 }) })).rejects.toThrow("HTTP 503");
  });
});

describe("self-update workflow", () => {
  function harness(version: string, extras: Parameters<typeof runSelfUpdate>[0] = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const spawnImpl = vi.fn((_command: string, _args: readonly string[], _options: SpawnSyncOptions) => ({ status: 0, signal: null }));
    return {
      stdout,
      stderr,
      spawnImpl,
      options: {
        currentVersion: "0.1.1",
        fetchImpl: async () => registryResponse(version),
        environment: {},
        stdout: (text: string) => stdout.push(text),
        stderr: (text: string) => stderr.push(text),
        spawnImpl,
        ...extras,
      },
    };
  }

  it("does nothing when already current", async () => {
    const test = harness("0.1.1", { yes: true });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "up_to_date", code: 0 });
    expect(test.spawnImpl).not.toHaveBeenCalled();
    expect(test.stdout.join("")).toContain("already up to date");
  });

  it("checks without installing and prints the explicit next action", async () => {
    const test = harness("0.2.0", { checkOnly: true });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "available", latestVersion: "0.2.0", code: 0 });
    expect(test.spawnImpl).not.toHaveBeenCalled();
    expect(test.stdout.join("")).toContain("nova update");
  });

  it("refuses silent mutation without --yes when no terminal can confirm it", async () => {
    const test = harness("0.2.0", { interactive: false });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "failed", code: 1 });
    expect(test.spawnImpl).not.toHaveBeenCalled();
    expect(test.stderr.join("")).toContain("needs --yes");
  });

  it("respects a declined interactive confirmation", async () => {
    const confirm = vi.fn(async () => false);
    const test = harness("0.2.0", { interactive: true, confirm });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "declined", code: 0 });
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("0.1.1 → 0.2.0"));
    expect(test.spawnImpl).not.toHaveBeenCalled();
  });

  it("installs the exact checked version outside the caller's workspace without a shell", async () => {
    const test = harness("0.2.0", { yes: true, packageManager: "pnpm" });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "updated", code: 0 });
    expect(test.spawnImpl).toHaveBeenCalledOnce();
    const [command, args, options] = test.spawnImpl.mock.calls[0];
    expect(command).toBe("pnpm");
    expect(args).toEqual(["add", "--global", "@circuit-nova/nova-cli@0.2.0"]);
    expect(options).toMatchObject({ shell: false, stdio: "inherit" });
    expect(options.cwd).not.toBe(process.cwd());
    expect(test.stdout.join("")).toContain("Restart Nova");
  });

  it("propagates installer failure and provides a safe manual retry", async () => {
    const test = harness("0.2.0", {
      yes: true,
      spawnImpl: () => ({ status: 17, signal: null }),
    });
    await expect(runSelfUpdate(test.options)).resolves.toMatchObject({ status: "failed", code: 1 });
    expect(test.stderr.join("")).toContain("installer exited 17");
    expect(test.stderr.join("")).toContain("npm install --global @circuit-nova/nova-cli@0.2.0");
  });
});
