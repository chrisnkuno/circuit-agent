import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { discoverPlugins, parsePluginManifest } from "./plugins";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-plugins-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("parsePluginManifest", () => {
  it("parses a manifest with no mcpServers as zero servers, not an error", () => {
    const manifest = parsePluginManifest("plugin.json", JSON.stringify({ name: "my-plugin" }));
    expect(manifest).toEqual({ name: "my-plugin", description: undefined, mcpServers: [] });
  });

  it("parses declared MCP servers", () => {
    const manifest = parsePluginManifest(
      "plugin.json",
      JSON.stringify({ name: "my-plugin", mcpServers: [{ id: "server-a", command: "node", args: ["server.js"], env: { FOO: "bar" } }] }),
    );
    expect(manifest.mcpServers).toEqual([{ id: "server-a", command: "node", args: ["server.js"], env: { FOO: "bar" } }]);
  });

  it("rejects duplicate server ids within one manifest", () => {
    const raw = JSON.stringify({ name: "p", mcpServers: [{ id: "a", command: "x" }, { id: "a", command: "y" }] });
    expect(() => parsePluginManifest("plugin.json", raw)).toThrow(/duplicate mcpServers id "a"/);
  });

  it("names the exact bad field for a malformed server entry", () => {
    expect(() => parsePluginManifest("plugin.json", JSON.stringify({ name: "p", mcpServers: [{ command: "x" }] }))).toThrow(/mcpServers\[0\]\.id/);
    expect(() => parsePluginManifest("plugin.json", JSON.stringify({ name: "p", mcpServers: [{ id: "a" }] }))).toThrow(/mcpServers\[0\]\.command/);
    expect(() => parsePluginManifest("plugin.json", JSON.stringify({ name: "p", mcpServers: [{ id: "a", command: "x", args: "not-array" }] }))).toThrow(/mcpServers\[0\]\.args/);
  });

  it("requires a non-empty name", () => {
    expect(() => parsePluginManifest("plugin.json", JSON.stringify({}))).toThrow(/"name"/);
  });
});

describe("discoverPlugins", () => {
  it("finds every plugin.json and pairs it with its own directory, and reports a missing directory as zero plugins", async () => {
    expect(await discoverPlugins(new LocalWorkspace(root))).toEqual([]);

    await fs.mkdir(path.join(root, ".nova/plugins/alpha"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/alpha/plugin.json"), JSON.stringify({ name: "alpha" }));
    await fs.mkdir(path.join(root, ".nova/plugins/beta"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/beta/plugin.json"), JSON.stringify({ name: "beta", mcpServers: [{ id: "s", command: "node" }] }));

    const plugins = await discoverPlugins(new LocalWorkspace(root));
    expect(plugins.map((plugin) => plugin.manifest.name).sort()).toEqual(["alpha", "beta"]);
    const alpha = plugins.find((plugin) => plugin.manifest.name === "alpha")!;
    // Workspace-relative, not absolute: the same value has to address a plugin's directory whether
    // the workspace is this machine or a sandbox where the local path means nothing.
    expect(alpha.directory).toBe(".nova/plugins/alpha");
  });

  it("reports a parse failure for one bad manifest rather than silently skipping it", async () => {
    await fs.mkdir(path.join(root, ".nova/plugins/broken"), { recursive: true });
    await fs.writeFile(path.join(root, ".nova/plugins/broken/plugin.json"), "not json");
    await expect(discoverPlugins(new LocalWorkspace(root))).rejects.toThrow(/broken\/plugin\.json/);
  });
});
