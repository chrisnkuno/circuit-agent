import { describe, expect, it } from "vitest";
import { CommandExitError } from "e2b";
import { E2BSandboxProvider } from "./e2b";

const listResult: Array<{ sandboxId: string; startedAt?: string; metadata?: Record<string, unknown> }> = [];

function fakeClient() {
  const calls: Array<{ method: string; value: unknown }> = [];
  const handle = {
    sandboxId: "sandbox_1",
    commands: { run: async (command: string, options: unknown) => {
      calls.push({ method: "run", value: { command, options } });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    } },
    files: {
      write: async (path: string, content: string) => { calls.push({ method: "write", value: { path, content } }); },
      read: async (path: string) => { calls.push({ method: "read", value: { path } }); return "file content"; },
    },
  };
  return {
    calls,
    client: {
      create: async (template: string, options: unknown) => { calls.push({ method: "create", value: { template, options } }); return handle; },
      connect: async (sandboxId: string, options: unknown) => { calls.push({ method: "connect", value: { sandboxId, options } }); return handle; },
      kill: async (sandboxId: string, options: unknown) => { calls.push({ method: "kill", value: { sandboxId, options } }); return true; },
      pause: async (sandboxId: string, options: unknown) => { calls.push({ method: "pause", value: { sandboxId, options } }); return true; },
      list: async (options: unknown) => { calls.push({ method: "list", value: { options } }); return listResult; },
    },
  };
}

describe("E2B sandbox provider", () => {
  it("creates secure, bounded, network-disabled sandboxes by default", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test", templates: { coding: "circuit-coding" } }, fake.client);
    await expect(provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 120 })).resolves.toEqual({ sandboxId: "sandbox_1", status: "created" });
    expect(fake.calls[0]).toMatchObject({ method: "create", value: { template: "circuit-coding", options: { timeoutMs: 120_000, secure: true, allowInternetAccess: false } } });
  });

  it("serializes argv without allowing shell control operators", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.runCommand("sandbox_1", { program: "rg", args: ["hello; rm -rf /", "src"], timeoutMs: 5_000 });
    expect(fake.calls.find((call) => call.method === "run")?.value).toMatchObject({ command: "rg 'hello; rm -rf /' 'src'" });
    await expect(provider.runCommand("sandbox_1", { program: "bash", args: ["-lc", "danger"], timeoutMs: 5_000 })).rejects.toThrow("not allowed");
  });

  it("normalizes non-zero process exits into command results", async () => {
    const fake = fakeClient();
    fake.client.connect = async () => ({
      sandboxId: "sandbox_1",
      commands: { run: async () => { throw new CommandExitError({ exitCode: 2, stdout: "partial", stderr: "failed" }); } },
      files: { write: async () => undefined, read: async () => "" },
    });
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await expect(provider.runCommand("sandbox_1", { program: "ls", args: ["/workspace/missing"], timeoutMs: 5_000 })).resolves.toEqual({
      exitCode: 2,
      stdout: "partial",
      stderr: "failed",
    });
  });

  it("writes bounded files only inside the workspace", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.writeFile("sandbox_1", "/workspace/repo/src/index.ts", "export const ready = true;");
    expect(fake.calls.at(-1)).toMatchObject({ method: "write", value: { path: "/workspace/repo/src/index.ts" } });
    await expect(provider.writeFile("sandbox_1", "/tmp/escape", "no")).rejects.toThrow("/workspace");
  });

  it("reads files only inside the workspace", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await expect(provider.readFile("sandbox_1", "/workspace/repo/src/index.ts")).resolves.toBe("file content");
    expect(fake.calls.at(-1)).toMatchObject({ method: "read", value: { path: "/workspace/repo/src/index.ts" } });
    await expect(provider.readFile("sandbox_1", "/etc/passwd")).rejects.toThrow("/workspace");
  });

  it("requires credentials and rejects unbounded lifetimes", async () => {
    expect(() => new E2BSandboxProvider({ apiKey: "" })).toThrow("E2B_API_KEY");
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fakeClient().client);
    await expect(provider.createSandbox({ taskId: "task_1", template: "coding", maxRuntimeSeconds: 3601 })).rejects.toThrow("between 1 and 3600");
  });

  it("kills the sandbox through the authenticated API", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.stopSandbox("sandbox_1");
    expect(fake.calls[0]).toMatchObject({ method: "kill", value: { sandboxId: "sandbox_1", options: { apiKey: "e2b_test" } } });
  });
});

describe("suspending a sandbox between steps", () => {
  it("pauses without a memory snapshot, so the next step inherits the files and nothing else", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.suspendSandbox("sandbox-1");
    const paused = fake.calls.find((call) => call.method === "pause");
    expect(paused?.value).toMatchObject({ sandboxId: "sandbox-1" });
    // keepMemory defaults to true and would snapshot the process tree at roughly four seconds per
    // gigabyte — paid for on every step boundary, to restore state the next step never inherits.
    expect((paused?.value as { options: Record<string, unknown> }).options).toMatchObject({ keepMemory: false });
  });

  it("is a different operation from destroying it", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.suspendSandbox("sandbox-1");
    expect(fake.calls.some((call) => call.method === "kill")).toBe(false);
  });
});

describe("reaping ownership", () => {
  it("only ever lists sandboxes this system created", async () => {
    listResult.length = 0;
    listResult.push(
      { sandboxId: "ours", startedAt: "2026-08-06T20:00:00Z", metadata: { purpose: "coding", taskId: "t1" } },
      // Accounts are shared with other projects; destroying their work would be unrecoverable.
      { sandboxId: "someone-elses", startedAt: "2026-08-06T20:00:00Z", metadata: { product: "alive-translate" } },
      { sandboxId: "unlabelled", startedAt: "2026-08-06T20:00:00Z" },
    );
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    const owned = await provider.listOwnedSandboxes();
    expect(owned.map((item) => item.sandboxId)).toEqual(["ours"]);
    expect(owned[0].startedAtMs).toBe(Date.parse("2026-08-06T20:00:00Z"));
  });

  it("reuses one connection across operations instead of reconnecting per call", async () => {
    // Measured at ~380ms per connect against a live sandbox, paid on every read, write and command:
    // a thirteen-tool step spent about five seconds doing nothing but reconnecting.
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);

    await provider.runCommand("sandbox_1", { program: "ls", args: [], cwd: "/workspace", timeoutMs: 5_000 });
    await provider.readFile("sandbox_1", "/workspace/a.txt");
    await provider.writeFile("sandbox_1", "/workspace/b.txt", "hi");

    expect(fake.calls.filter((call) => call.method === "connect")).toHaveLength(1);
  });

  it("reconnects once when the cached connection has died", async () => {
    let connects = 0;
    let failNext = true;
    const handle = {
      sandboxId: "sandbox_1",
      commands: { run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }) },
      files: {
        write: async () => {},
        read: async () => {
          if (failNext) { failNext = false; throw new Error("connection terminated"); }
          return "recovered";
        },
      },
    };
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, {
      create: async () => handle,
      connect: async () => { connects += 1; return handle; },
      kill: async () => true,
      pause: async () => true,
      list: async () => listResult,
    } as never);

    // Reuse must never turn a transient disconnect into a failed step.
    await expect(provider.readFile("sandbox_1", "/workspace/a.txt")).resolves.toBe("recovered");
    expect(connects).toBe(2);
  });

  it("drops the connection when the sandbox is paused, so no stale handle is reused", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);

    await provider.readFile("sandbox_1", "/workspace/a.txt");
    await provider.suspendSandbox("sandbox_1");
    await provider.readFile("sandbox_1", "/workspace/a.txt");

    expect(fake.calls.filter((call) => call.method === "connect")).toHaveLength(2);
  });
});
