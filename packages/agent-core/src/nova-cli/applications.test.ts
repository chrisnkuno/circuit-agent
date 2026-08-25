import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalApplicationSupervisor } from "./applications";

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

describe("LocalApplicationSupervisor", () => {
  const roots: string[] = [];
  const supervisors: LocalApplicationSupervisor[] = [];

  afterEach(async () => {
    await Promise.all(supervisors.splice(0).map((supervisor) => supervisor.dispose()));
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  async function fixture(source: string): Promise<{ root: string; supervisor: LocalApplicationSupervisor }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-application-"));
    roots.push(root);
    await fs.writeFile(path.join(root, "server.mjs"), source);
    const supervisor = new LocalApplicationSupervisor(root);
    supervisors.push(supervisor);
    return { root, supervisor };
  }

  it("keeps an HTTP application reachable until it is explicitly stopped", async () => {
    const port = await unusedPort();
    const { supervisor } = await fixture(`
      import http from "node:http";
      const server = http.createServer((_request, response) => response.end("nova-preview-ok"));
      server.listen(Number(process.argv[2]), "127.0.0.1", () => console.log("ready"));
    `);

    const started = await supervisor.start({ command: `node server.mjs ${port}`, port, timeoutMs: 5_000 });
    expect(started).toMatchObject({ id: "app-1", state: "running", port, url: `http://127.0.0.1:${port}/` });
    expect(await (await fetch(started.url)).text()).toBe("nova-preview-ok");
    expect(supervisor.get(started.id)[0]).toMatchObject({ state: "running", stdout: expect.stringContaining("ready") });

    const stopped = await supervisor.stop(started.id);
    expect(stopped.state).toBe("exited");
    await expect(fetch(started.url)).rejects.toThrow();
  });

  it("does not mistake startup logs for a reachable application", async () => {
    const port = await unusedPort();
    const { supervisor } = await fixture(`console.log("running at port ${port}"); setTimeout(() => process.exit(3), 50);`);
    await expect(supervisor.start({ command: "node server.mjs", port, timeoutMs: 2_000 }))
      .rejects.toThrow(new RegExp(`exited before port ${port} became ready[\\s\\S]*running at port ${port}`));
    expect(supervisor.list()).toMatchObject([{ state: "exited", exitCode: 3 }]);
  });

  it("stops a process that never serves HTTP when readiness expires", async () => {
    const port = await unusedPort();
    const { supervisor } = await fixture("setInterval(() => console.log('waiting'), 100);");
    await expect(supervisor.start({ command: "node server.mjs", port, timeoutMs: 1_000 }))
      .rejects.toThrow(/did not answer HTTP.*and was stopped/s);
    expect(supervisor.list()[0]?.state).toBe("exited");
  });

  it("refuses occupied ports and directories outside the workspace", async () => {
    const port = await unusedPort();
    const occupied = net.createServer();
    await new Promise<void>((resolve) => occupied.listen(port, "127.0.0.1", resolve));
    const { supervisor } = await fixture("setInterval(() => {}, 1000);");
    try {
      await expect(supervisor.start({ command: "node server.mjs", port })).rejects.toThrow(/already in use/);
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    await expect(supervisor.start({ command: "node server.mjs", port: await unusedPort(), directory: "../" })).rejects.toThrow(/inside the project workspace/);
  });
});
