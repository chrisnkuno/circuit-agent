import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { loadLocalExternalTooling } from "./external-tools";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-external-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const schema = { type: "object", properties: {}, additionalProperties: false };

async function writeSkill(directory: string, name: string, command: string): Promise<void> {
  await fs.mkdir(path.join(directory, name), { recursive: true });
  await fs.writeFile(path.join(directory, name, "skill.json"), JSON.stringify({ name, description: `The ${name} skill.`, command, inputSchema: schema }));
}

async function writeHook(directory: string, fileName: string, body: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, fileName), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

describe("loadLocalExternalTooling", () => {
  it("returns a working, empty assembly for a project with no .nova directory at all", async () => {
    const tooling = await loadLocalExternalTooling(new LocalWorkspace(root));
    try {
      // The top-level skill provider is always present; it simply finds nothing.
      expect(await tooling.providers[0].listTools()).toEqual([]);
      await expect(tooling.hooks.runPreToolUse("write_file", { path: "a.txt" })).resolves.toEqual({ blocked: false });
    } finally {
      await tooling.dispose();
    }
  });

  it("discovers top-level skills and a plugin's bundled skills as separately-identified providers", async () => {
    await writeSkill(path.join(root, ".nova/skills"), "top", "printf top");
    await fs.mkdir(path.join(root, ".nova/plugins/demo"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/demo/plugin.json"), JSON.stringify({ name: "demo" }));
    await writeSkill(path.join(root, ".nova/plugins/demo/skills"), "bundled", "printf bundled");

    const tooling = await loadLocalExternalTooling(new LocalWorkspace(root));
    try {
      expect(tooling.providers.map((provider) => provider.id).sort()).toEqual(["local-skills", "plugin:demo"]);
      // Distinct provider ids are what keeps their approval digests distinct — a bundled skill and a
      // top-level one of the same name must never share a standing approval.
      const byId = Object.fromEntries(tooling.providers.map((provider) => [provider.id, provider]));
      expect((await byId["local-skills"].listTools()).map((tool) => tool.name)).toEqual(["top"]);
      expect((await byId["plugin:demo"].listTools()).map((tool) => tool.name)).toEqual(["bundled"]);
    } finally {
      await tooling.dispose();
    }
  });

  it("runs both a top-level hook and a plugin's own hook for the same call", async () => {
    const log = path.join(root, "hooks.log");
    await writeHook(path.join(root, ".nova/hooks/pre-tool-use"), "top.sh", `echo top >> ${log}\nexit 0`);
    await fs.mkdir(path.join(root, ".nova/plugins/demo"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/demo/plugin.json"), JSON.stringify({ name: "demo" }));
    await writeHook(path.join(root, ".nova/plugins/demo/hooks/pre-tool-use"), "bundled.sh", `echo bundled >> ${log}\nexit 0`);

    const tooling = await loadLocalExternalTooling(new LocalWorkspace(root));
    try {
      await expect(tooling.hooks.runPreToolUse("write_file", { path: "a.txt" })).resolves.toEqual({ blocked: false });
      const lines = (await fs.readFile(log, "utf8")).trim().split("\n").sort();
      expect(lines).toEqual(["bundled", "top"]); // a plugin's hook is not skipped in favour of the top-level one
    } finally {
      await tooling.dispose();
    }
  });

  it("lets a plugin's own hook block a call, exactly as a top-level hook can", async () => {
    await fs.mkdir(path.join(root, ".nova/plugins/demo"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/demo/plugin.json"), JSON.stringify({ name: "demo" }));
    await writeHook(path.join(root, ".nova/plugins/demo/hooks/pre-tool-use"), "deny.sh", "echo 'plugin says no' >&2\nexit 1");

    const tooling = await loadLocalExternalTooling(new LocalWorkspace(root));
    try {
      await expect(tooling.hooks.runPreToolUse("write_file", { path: "a.txt" })).resolves.toEqual({ blocked: true, reason: "plugin says no" });
    } finally {
      await tooling.dispose();
    }
  });

  it("surfaces a malformed plugin manifest rather than loading the rest and staying silent", async () => {
    await fs.mkdir(path.join(root, ".nova/plugins/broken"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/broken/plugin.json"), "not json");
    await expect(loadLocalExternalTooling(new LocalWorkspace(root))).rejects.toThrow(/broken\/plugin\.json/);
  });

  it("is safe to dispose when no MCP server was ever started", async () => {
    const tooling = await loadLocalExternalTooling(new LocalWorkspace(root));
    await expect(tooling.dispose()).resolves.toBeUndefined();
    await expect(tooling.dispose()).resolves.toBeUndefined(); // and idempotent
  });
});
