import type { NovaWorkspace } from "./backends";
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
 * Every `.nova/plugins/<name>/plugin.json` in the workspace, plus that plugin's own directory as a
 * workspace-relative path — the caller needs it to find the plugin's `skills/` and `hooks/`
 * subdirectories, which this function deliberately does not reach into itself (that is
 * `skills.ts`/`hooks.ts`'s job, kept one function per concern rather than one that knows all three).
 */
export async function discoverPlugins(workspace: NovaWorkspace): Promise<Array<{ manifest: PluginManifest; directory: string }>> {
  const files = await workspace.listConfigFiles(PLUGINS_DIRECTORY);
  // Exactly one level deep, mirroring skills: `.nova/plugins/<name>/plugin.json`.
  const manifestPaths = files.filter((file) => {
    const rest = file.slice(PLUGINS_DIRECTORY.length + 1).split("/");
    return rest.length === 2 && rest[1] === "plugin.json";
  });
  const plugins: Array<{ manifest: PluginManifest; directory: string }> = [];
  for (const manifestPath of manifestPaths) {
    const file = await workspace.readFile(manifestPath).catch(() => null);
    if (!file) continue;
    plugins.push({
      manifest: parsePluginManifest(manifestPath, file.content),
      directory: manifestPath.slice(0, manifestPath.length - "/plugin.json".length),
    });
  }
  return plugins;
}
