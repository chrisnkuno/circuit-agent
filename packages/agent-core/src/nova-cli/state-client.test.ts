import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { NovaStateClient, resolveNovaStateBinary, type StateProcess } from "./state-client";

const clients: NovaStateClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map((client) => client.close())); });
function fakeProcess(respond: (request: Record<string, unknown>) => Record<string, unknown> | null): StateProcess {
  const emitter = new EventEmitter() as StateProcess;
  emitter.stdin = new PassThrough();
  const stdout = new PassThrough();
  emitter.stdout = stdout;
  emitter.stderr = new PassThrough();
  emitter.exitCode = null;
  emitter.signalCode = null;
  emitter.killed = false;
  let buffer = "";
  emitter.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const response = respond(JSON.parse(line) as Record<string, unknown>);
      if (response) stdout.write(`${JSON.stringify(response)}\n`);
    }
  });
  emitter.stdin.on("finish", () => {
    emitter.exitCode = 0;
    emitter.emit("exit", 0, null);
  });
  emitter.kill = () => {
    emitter.killed = true;
    emitter.signalCode = "SIGTERM";
    emitter.emit("exit", null, "SIGTERM");
    return true;
  };
  return emitter;
}

function successProcess(): StateProcess {
  return fakeProcess((request) => ({
    id: request.id,
    protocolVersion: 1,
    ok: true,
    result: request.method === "ping" ? { pong: true } : request.params,
  }));
}

describe("NovaStateClient", () => {
  it("multiplexes versioned JSONL requests over one shell-free child", async () => {
    const client = await NovaStateClient.connect({ binary: "fake-state", processFactory: successProcess });
    clients.push(client);
    await expect(client.sessions("/workspace", 7)).resolves.toEqual({ root: "/workspace", limit: 7 });
    await expect(client.search("/repo", "PaymentIntent", { window: 4 })).resolves.toEqual({ root: "/repo", query: "PaymentIntent", window: 4 });
    await expect(client.rebuildDefenderBrain("/knowledge", "/data")).resolves.toEqual({ sourceRoot: "/knowledge", dataRoot: "/data" });
    await expect(client.searchDefenderBrain("/knowledge", "/data", "PQC migration", 3, "2026-08-24")).resolves.toEqual({
      sourceRoot: "/knowledge", dataRoot: "/data", query: "PQC migration", limit: 3, now: "2026-08-24",
    });
  });

  it("surfaces protocol errors as typed failures", async () => {
    const processFactory = () => fakeProcess((request) => ({ id: request.id, protocolVersion: 1, ok: false, error: { code: "broken", message: "bad source" } }));
    await expect(NovaStateClient.connect({ binary: "fake-state", processFactory })).rejects.toMatchObject({ code: "broken", message: "bad source" });
  });

  it("times out a wedged sidecar instead of hanging Nova", async () => {
    await expect(NovaStateClient.connect({ binary: "fake-state", processFactory: () => fakeProcess(() => null), requestTimeoutMs: 30 })).rejects.toMatchObject({ code: "timeout" });
  });

  it("terminates a sidecar that emits a malformed protocol response", async () => {
    let child: StateProcess | undefined;
    const processFactory = () => {
      child = fakeProcess(() => ({ unexpected: true }));
      return child;
    };
    await expect(NovaStateClient.connect({ binary: "fake-state", processFactory })).rejects.toThrow(/malformed protocol response/);
    expect(child?.killed).toBe(true);
  });
});

describe("native binary resolution", () => {
  it("honours an explicit executable without modifying it", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "nova-state-resolve-"));
    const binary = path.join(directory, process.platform === "win32" ? "state.cmd" : "state");
    await fs.writeFile(binary, process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n");
    await fs.chmod(binary, 0o700);
    await expect(resolveNovaStateBinary({ ...process.env, NOVA_STATE_BINARY: binary })).resolves.toBe(path.resolve(binary));
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("fails clearly when an explicit override is unusable", async () => {
    await expect(resolveNovaStateBinary({ ...process.env, NOVA_STATE_BINARY: path.join(os.tmpdir(), "missing-nova-state") })).rejects.toThrow(/not executable/);
  });
});
