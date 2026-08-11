import type { NovaWorkspace } from "./backends";
import { HOOKS_DIRECTORY, HookRegistry, type HookSource } from "./hooks";
import { discoverMcpServers, McpConnection, McpToolProvider } from "./mcp-provider";
import { discoverPlugins } from "./plugins";
import { SkillToolProvider, SKILLS_DIRECTORY } from "./skills";
import type { ToolProvider } from "./tool-providers";

/**
 * Assembles every skill, hook and MCP source — top-level and plugin-bundled — for one session, so
 * `NovaAgent` has one call to make rather than reimplementing plugin unbundling itself.
 *
 * Everything is discovered and executed through `NovaWorkspace`, so a `.nova` directory committed to
 * a repository behaves identically whether the session runs locally, in E2B, or in Docker. The one
 * thing that is not workspace-relative is an MCP server *process*: `.nova/mcp.json` says which
 * servers to start, but Nova spawns them on the machine Nova itself runs on, which is the same
 * machine either way.
 *
 * MCP connections are live processes — `dispose()` kills every one of them and must be called when
 * the session ends, the same lifecycle `E2BWorkspace.dispose()` already has for its own resource.
 */
export type LocalExternalTooling = {
  providers: ToolProvider[];
  hooks: HookRegistry;
  dispose(): Promise<void>;
};

/**
 * The one provider that is always present rather than configured: the top-level `.nova/skills`
 * reader, which exists whether or not the directory does.
 *
 * Named here so a caller can tell it apart from a source the user actually declared. Reporting
 * "loaded but offering no tools" is useful for an MCP server or plugin someone put in a manifest —
 * that usually means a wrong path — but for this one it is just the ordinary state of a project
 * with no skills, and saying it to every such user is noise dressed as a warning.
 */
export const IMPLICIT_SKILL_PROVIDER_ID = "local-skills";

export async function loadLocalExternalTooling(workspace: NovaWorkspace): Promise<LocalExternalTooling> {
  const providers: ToolProvider[] = [new SkillToolProvider(IMPLICIT_SKILL_PROVIDER_ID, SKILLS_DIRECTORY, workspace)];
  const hookSources: HookSource[] = [HOOKS_DIRECTORY];
  const connections: McpConnection[] = [];

  for (const serverConfig of await discoverMcpServers(workspace)) {
    const connection = new McpConnection(serverConfig);
    connections.push(connection);
    providers.push(new McpToolProvider(connection, serverConfig.id));
  }

  for (const { manifest, directory } of await discoverPlugins(workspace)) {
    providers.push(new SkillToolProvider(`plugin:${manifest.name}`, `${directory}/skills`, workspace));
    hookSources.push(`${directory}/hooks`);
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
