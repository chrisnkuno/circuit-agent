import { describe, expect, it } from "vitest";
import { E2BSandboxProvider } from "./e2b";

function fakeClient() {
  const calls: Array<{ method: string; value: unknown }> = [];
  const handle = {
    sandboxId: "sandbox_1",
    commands: { run: async (command: string, options: unknown) => {
      calls.push({ method: "run", value: { command, options } });
      return { exitCode: 0, stdout: "ok", stderr: "" };
    } },
    files: { write: async (path: string, content: string) => { calls.push({ method: "write", value: { path, content } }); } },
  };
  return {
    calls,
    client: {
      create: async (template: string, options: unknown) => { calls.push({ method: "create", value: { template, options } }); return handle; },
      connect: async (sandboxId: string, options: unknown) => { calls.push({ method: "connect", value: { sandboxId, options } }); return handle; },
      kill: async (sandboxId: string, options: unknown) => { calls.push({ method: "kill", value: { sandboxId, options } }); return true; },
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

  it("writes bounded files only inside the workspace", async () => {
    const fake = fakeClient();
    const provider = new E2BSandboxProvider({ apiKey: "e2b_test" }, fake.client);
    await provider.writeFile("sandbox_1", "/workspace/repo/src/index.ts", "export const ready = true;");
    expect(fake.calls.at(-1)).toMatchObject({ method: "write", value: { path: "/workspace/repo/src/index.ts" } });
    await expect(provider.writeFile("sandbox_1", "/tmp/escape", "no")).rejects.toThrow("/workspace");
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
