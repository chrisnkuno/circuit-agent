import { describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider, type ProcessRunner } from "./docker";

function fakeRunner(byArgv: (argv: string[]) => { exitCode: number; stdout: string; stderr: string } | undefined) {
  const calls: string[][] = [];
  const run: ProcessRunner = async (argv) => {
    calls.push(argv);
    return byArgv(argv) ?? { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("Docker sandbox provider", () => {
  it("requires a coding image", () => {
    expect(() => new DockerSandboxProvider({ image: "" })).toThrow("Docker coding image is required");
  });

  it("creates a network-isolated, resource-bounded container by default", async () => {
    const fake = fakeRunner(() => undefined);
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    const session = await provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 120 });
    expect(session.status).toBe("created");
    expect(session.sandboxId).toMatch(/^circuit-nova-task_1-/);
    const argv = fake.calls[0];
    expect(argv[0]).toBe("run");
    expect(argv).toContain("--network");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv).toContain("--workdir");
    expect(argv.at(-2)).toBe("sleep");
  });

  it("switches to bridge networking only when internet access is explicitly allowed", async () => {
    const fake = fakeRunner(() => undefined);
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest", allowInternetAccess: true }, fake.run);
    await provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 60 });
    const argv = fake.calls[0];
    expect(argv[argv.indexOf("--network") + 1]).toBe("bridge");
  });

  it("rejects an out-of-range runtime before ever shelling out", async () => {
    const fake = fakeRunner(() => undefined);
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 0 })).rejects.toThrow("maxRuntimeSeconds");
    expect(fake.calls).toHaveLength(0);
  });

  it("throws when the docker run invocation fails", async () => {
    const fake = fakeRunner(() => ({ exitCode: 1, stdout: "", stderr: "no such image" }));
    const provider = new DockerSandboxProvider({ image: "missing:latest" }, fake.run);
    await expect(provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 60 })).rejects.toThrow("no such image");
  });

  it("runs commands through docker exec after the shared sandbox policy", async () => {
    const fake = fakeRunner(() => ({ exitCode: 0, stdout: "ok", stderr: "" }));
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await provider.runCommand("sandbox_1", { program: "rg", args: ["hello", "src"], cwd: "/workspace/repo", timeoutMs: 5_000 });
    expect(fake.calls[0]).toEqual(["exec", "-w", "/workspace/repo", "sandbox_1", "rg", "hello", "src"]);
  });

  it("rejects a disallowed command via the same policy E2B uses", async () => {
    const fake = fakeRunner(() => undefined);
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.runCommand("sandbox_1", { program: "python3", args: ["-c", "print(1)"], timeoutMs: 5_000 })).rejects.toThrow("blocked");
    expect(fake.calls).toHaveLength(0);
  });

  it("writes a file via a temp file and docker cp, creating the parent directory first", async () => {
    const fake = fakeRunner((argv) => {
      if (argv[0] === "exec" && argv.includes("mkdir")) return { exitCode: 0, stdout: "", stderr: "" };
      if (argv[0] === "cp") return { exitCode: 0, stdout: "", stderr: "" };
      return undefined;
    });
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await provider.writeFile("sandbox_1", "/workspace/repo/src/math.js", "module.exports = {};\n");
    const mkdirCall = fake.calls.find((argv) => argv.includes("mkdir"));
    expect(mkdirCall).toEqual(["exec", "sandbox_1", "mkdir", "-p", "/workspace/repo/src"]);
    const cpCall = fake.calls.find((argv) => argv[0] === "cp");
    expect(cpCall?.[2]).toBe("sandbox_1:/workspace/repo/src/math.js");
  });

  it("throws when the docker cp write fails", async () => {
    const fake = fakeRunner((argv) => {
      if (argv[0] === "exec") return { exitCode: 0, stdout: "", stderr: "" };
      if (argv[0] === "cp") return { exitCode: 1, stdout: "", stderr: "no such container" };
      return undefined;
    });
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.writeFile("sandbox_1", "/workspace/repo/math.js", "x")).rejects.toThrow("no such container");
  });

  it("reads a file via docker exec cat", async () => {
    const fake = fakeRunner(() => ({ exitCode: 0, stdout: "hello world", stderr: "" }));
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.readFile("sandbox_1", "/workspace/repo/hello.txt")).resolves.toBe("hello world");
    expect(fake.calls[0]).toEqual(["exec", "sandbox_1", "cat", "/workspace/repo/hello.txt"]);
  });

  it("throws a not-found error when reading a missing file", async () => {
    const fake = fakeRunner(() => ({ exitCode: 1, stdout: "", stderr: "No such file" }));
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.readFile("sandbox_1", "/workspace/repo/missing.txt")).rejects.toThrow("does not exist");
  });

  it("force-removes the container on stop", async () => {
    const fake = fakeRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await provider.stopSandbox("sandbox_1");
    expect(fake.calls[0]).toEqual(["rm", "-f", "sandbox_1"]);
  });

  it("throws when creating the parent directory fails, before ever attempting docker cp", async () => {
    const fake = fakeRunner((argv) => {
      if (argv.includes("mkdir")) return { exitCode: 1, stdout: "", stderr: "permission denied" };
      return undefined;
    });
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.writeFile("sandbox_1", "/workspace/repo/src/math.js", "x")).rejects.toThrow("permission denied");
    expect(fake.calls.some((argv) => argv[0] === "cp")).toBe(false);
  });

  it("leaves an already-running container alone between steps, since it survives on its own", async () => {
    // Unlike E2B's pause/resume, a container needs nothing done to it between commands — the
    // no-op itself is the behaviour under test, not a placeholder for one.
    const fake = fakeRunner(() => ({ exitCode: 0, stdout: "", stderr: "" }));
    const provider = new DockerSandboxProvider({ image: "circuit-nova-coding:latest" }, fake.run);
    await expect(provider.suspendSandbox()).resolves.toBeUndefined();
    expect(fake.calls).toHaveLength(0);
  });
});
