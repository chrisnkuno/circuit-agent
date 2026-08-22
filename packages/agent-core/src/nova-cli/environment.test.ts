import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import type { CommandRunner } from "./command";
import { describeEnvironment, probeEnvironment } from "./environment";
import { DEFAULT_WORKSPACE_LIMITS } from "./workspace";

let root: string;

/** Records what was probed and answers from a fixed table of installed programs. */
function fakeRunner(installed: Record<string, string>, log: string[] = []): CommandRunner {
  return async (command) => {
    log.push(command);
    const program = command.split(" ")[0];
    if (program in installed) return { exitCode: 0, stdout: `${installed[program]}\n`, stderr: "" };
    return { exitCode: 127, stdout: "", stderr: `spawn ${program} ENOENT` };
  };
}

function workspaceWith(installed: Record<string, string>, log: string[] = []) {
  return new LocalWorkspace(root, DEFAULT_WORKSPACE_LIMITS, fakeRunner(installed, log));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-env-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("probeEnvironment", () => {
  it("partitions every probe into available or missing, and never both", async () => {
    const report = await probeEnvironment(workspaceWith({ git: "git version 2.43.0", node: "v24.1.0" }));
    const available = report.available.map((tool) => tool.name);
    expect(available).toContain("git");
    expect(report.missing).toContain("npm");
    expect(available.filter((name) => report.missing.includes(name))).toEqual([]);
    expect(new Set([...available, ...report.missing]).size).toBe(available.length + report.missing.length);
  });

  it("reports the version a program printed, not the string it was probed with", async () => {
    const report = await probeEnvironment(workspaceWith({ git: "git version 2.43.0", bun: "1.3.14" }));
    expect(report.available.find((tool) => tool.name === "git")?.version).toBe("2.43.0");
    expect(report.available.find((tool) => tool.name === "bun")?.version).toBe("1.3.14");
  });

  it("identifies the package manager from the committed lockfile", async () => {
    await fs.writeFile(path.join(root, "bun.lock"), "");
    const report = await probeEnvironment(workspaceWith({ bun: "1.3.14" }));
    expect(report.packageManager).toEqual({ name: "bun", lockfile: "bun.lock" });
  });

  it("leaves the package manager null when no lockfile is committed", async () => {
    await fs.writeFile(path.join(root, "package.json"), "{}");
    const report = await probeEnvironment(workspaceWith({ npm: "10.0.0" }));
    expect(report.packageManager).toBeNull();
  });

  it("probes a toolchain only when the project carries its marker file", async () => {
    const withoutMarker: string[] = [];
    await probeEnvironment(workspaceWith({}, withoutMarker));
    expect(withoutMarker.some((command) => command.startsWith("cargo"))).toBe(false);

    await fs.writeFile(path.join(root, "Cargo.toml"), "[package]\n");
    const withMarker: string[] = [];
    const report = await probeEnvironment(workspaceWith({ cargo: "cargo 1.79.0" }, withMarker));
    expect(withMarker.some((command) => command.startsWith("cargo"))).toBe(true);
    expect(report.available.map((tool) => tool.name)).toContain("cargo");
  });

  it("probes each program exactly once, with a version flag and nothing else", async () => {
    await fs.writeFile(path.join(root, "bun.lock"), "");
    const log: string[] = [];
    await probeEnvironment(workspaceWith({ bun: "1.3.14" }, log));
    expect(new Set(log).size).toBe(log.length);
    expect(log.every((command) => /^[a-z0-9][a-z0-9_.+-]* --version$/.test(command))).toBe(true);
  });

  it("treats a backend that throws as 'not available' rather than failing the session", async () => {
    const throwing: CommandRunner = async () => { throw new Error("sandbox refused"); };
    const report = await probeEnvironment(new LocalWorkspace(root, DEFAULT_WORKSPACE_LIMITS, throwing));
    expect(report.available).toEqual([]);
    expect(report.missing).toContain("git");
  });

  it("records the backend's own execution rules so the prompt cannot invent them", async () => {
    const report = await probeEnvironment(workspaceWith({}));
    expect(report.backend).toBe("local");
    expect(report.execution).toContain("real shell");
    expect(report.host).toContain(os.arch());
  });
});

describe("describeEnvironment", () => {
  it("states what is missing as plainly as what is present", async () => {
    await fs.writeFile(path.join(root, "bun.lock"), "");
    const text = describeEnvironment(await probeEnvironment(workspaceWith({ bun: "1.3.14", git: "git version 2.43.0" })));
    expect(text).toContain("bun 1.3.14");
    expect(text).toMatch(/NOT available[^\n]*npm/);
    expect(text).toContain("bun.lock");
  });

  it("omits sections it has no facts for rather than printing empty ones", async () => {
    const throwing: CommandRunner = async () => { throw new Error("no"); };
    const text = describeEnvironment(await probeEnvironment(new LocalWorkspace(root, DEFAULT_WORKSPACE_LIMITS, throwing)));
    expect(text).not.toContain("Available:");
    expect(text).not.toContain("Package manager:");
  });
});
