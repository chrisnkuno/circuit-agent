import path from "node:path";
import type { NovaWorkspace } from "./backends";
import { HOOKS_DIRECTORY, HookRegistry, type HookSource } from "./hooks";
import { discoverMcpServers, McpConnection, McpToolProvider } from "./mcp-provider";
import { discoverPlugins } from "./plugins";
import { SkillToolProvider, SKILLS_DIRECTORY } from "./skills";
import type { ToolProvider } from "./tool-providers";

/**
 * Assembles every skill, hook and MCP source — top-level and plugin-bundled — for one local
 * session, so `NovaAgent` has one call to make rather than reimplementing plugin unbundling itself.
 *
 * Local workspaces only, for the reason `skills.ts`/`hooks.ts` each document: discovery reads
 * through `node:fs` against `root`, which is only a real mirror of the files in play when the
 * session's workspace actually is that local directory.
 *
 * MCP connections are genuinely live processes — `dispose()` on the returned handle kills every one
 * of them, and must be called when the session ends, the same lifecycle `E2BWorkspace.dispose()`
 * already has for its own held resource.
 */
export type LocalExternalTooling = {
  providers: ToolProvider[];
  hooks: HookRegistry;
  dispose(): Promise<void>;
};

export async function loadLocalExternalTooling(root: string, workspace: NovaWorkspace): Promise<LocalExternalTooling> {
  const providers: ToolProvider[] = [new SkillToolProvider("local-skills", path.join(root, SKILLS_DIRECTORY), workspace)];
  const hookSources: HookSource[] = [{ hooksDirectory: path.join(root, HOOKS_DIRECTORY), displayPrefix: HOOKS_DIRECTORY }];
  const connections: McpConnection[] = [];

  for (const serverConfig of await discoverMcpServers(root)) {
    const connection = new McpConnection(serverConfig);
    connections.push(connection);
    providers.push(new McpToolProvider(connection, serverConfig.id));
  }

  for (const { manifest, directory } of await discoverPlugins(root)) {
    providers.push(new SkillToolProvider(`plugin:${manifest.name}`, path.join(directory, "skills"), workspace));
    hookSources.push({ hooksDirectory: path.join(directory, "hooks"), displayPrefix: `${path.relative(root, directory).split(path.sep).join("/")}/hooks` });
    for (const serverConfig of manifest.mcpServers) {
      const connection = new McpConnection(serverConfig);
      connections.push(connection);
      providers.push(new McpToolProvider(connection, `plugin:${manifest.name}:${serverConfig.id}`));
    }
  }

  return {
    providers,
    hooks: new HookRegistry(hookSources, workspace),
    dispose: async () => {
      for (const connection of connections) connection.close();
    },
  };
}
