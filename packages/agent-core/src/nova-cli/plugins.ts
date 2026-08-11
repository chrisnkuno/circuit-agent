import { promises as fs } from "node:fs";
import path from "node:path";
import { parseMcpServerConfig, type McpServerConfig } from "./mcp-provider";

/**
 * A plugin bundles the other three mechanisms under one name and one provenance: a
 * `.nova/plugins/<name>/plugin.json` manifest naming the MCP servers it wants connected, plus
 * whichever of `.nova/plugins/<name>/skills/<skill>/skill.json` and
 * `.nova/plugins/<name>/hooks/{pre,post}-tool-use/*` it happens to include — the same manifest
 * formats `skills.ts`/`hooks.ts` already define, reused rather than duplicated, so a skill or hook
 * behaves identically whether it ships loose at the top level or bundled inside a plugin.
 *
 * `mcpServers` lives in the manifest (not auto-discovered) because starting a server is starting a
 * process — that should be an explicit, readable declaration, not something that happens because a
 * file with the right name exists in the right directory.
 */
export type PluginManifest = {
  name: string;
  description?: string;
  mcpServers: McpServerConfig[];
};

export const PLUGINS_DIRECTORY = ".nova/plugins";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates one `plugin.json`. Throws with the manifest's path in the message on any defect. */
export function parsePluginManifest(displayPath: string, raw: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${displayPath}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${displayPath}: must be a JSON object`);
  const { name, description, mcpServers } = parsed;
  if (typeof name !== "string" || !name.trim()) throw new Error(`${displayPath}: "name" must be a non-empty string`);
  if (description !== undefined && typeof description !== "string") throw new Error(`${displayPath}: "description" must be a string`);
  if (mcpServers !== undefined && !Array.isArray(mcpServers)) throw new Error(`${displayPath}: "mcpServers" must be an array`);
  const servers = ((mcpServers as unknown[] | undefined) ?? []).map((server, index) => parseMcpServerConfig(displayPath, index, server));
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`${displayPath}: duplicate mcpServers id "${server.id}"`);
    ids.add(server.id);
  }
  return { name, description: description as string | undefined, mcpServers: servers };
}

/**
 * Every `.nova/plugins/<name>/plugin.json` under `root`, plus the absolute path to that plugin's own
 * directory — the caller needs it to find the plugin's `skills/` and `hooks/` subdirectories, which
 * this function deliberately does not reach into itself (that is `skills.ts`/`hooks.ts`'s job, kept
 * one function per concern rather than one function that knows about all three).
 */
export async function discoverPlugins(root: string): Promise<Array<{ manifest: PluginManifest; directory: string }>> {
  const pluginsRoot = path.join(root, PLUGINS_DIRECTORY);
  const entries = await fs.readdir(pluginsRoot, { withFileTypes: true }).catch(() => []);
  const plugins: Array<{ manifest: PluginManifest; directory: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(pluginsRoot, entry.name);
    const raw = await fs.readFile(path.join(directory, "plugin.json"), "utf8").catch(() => null);
    if (raw === null) continue;
    plugins.push({ manifest: parsePluginManifest(`${PLUGINS_DIRECTORY}/${entry.name}/plugin.json`, raw), directory });
  }
  return plugins;
}
