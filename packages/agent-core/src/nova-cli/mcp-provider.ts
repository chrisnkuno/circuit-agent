import { type ChildProcess, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import type { ExternalTool, ToolProvider } from "./tool-providers";

/**
 * A Model Context Protocol server, reached over stdio — the transport every MCP server supports,
 * unlike the optional HTTP/SSE transport. One JSON-RPC 2.0 object per line on the child's stdin and
 * stdout; no Content-Length framing (that is LSP's convention, not MCP's).
 */
export type McpServerConfig = {
  /** Provenance id — must be unique among configured servers. */
  id: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type JsonRpcResponse = { jsonrpc: "2.0"; id: number; result?: unknown; error?: { code: number; message: string } };

const MCP_PROTOCOL_VERSION = "2024-11-05";
const REQUEST_TIMEOUT_MS = 15_000;
const MCP_CONFIG_PATH = ".nova/mcp.json";

function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  return typeof value === "object" && value !== null && "jsonrpc" in value && "id" in value && typeof (value as { id: unknown }).id === "number";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parses and validates one server entry from a `mcpServers` array — shared by `.nova/mcp.json` and a plugin's own manifest. */
export function parseMcpServerConfig(displayPath: string, index: number, value: unknown): McpServerConfig {
  if (!isPlainObject(value)) throw new Error(`${displayPath}: mcpServers[${index}] must be an object`);
  const { id, command, args, env } = value;
  if (typeof id !== "string" || !id.trim()) throw new Error(`${displayPath}: mcpServers[${index}].id must be a non-empty string`);
  if (typeof command !== "string" || !command.trim()) throw new Error(`${displayPath}: mcpServers[${index}].command must be a non-empty string`);
  if (args !== undefined && (!Array.isArray(args) || args.some((item) => typeof item !== "string"))) {
    throw new Error(`${displayPath}: mcpServers[${index}].args must be an array of strings`);
  }
  if (env !== undefined && (!isPlainObject(env) || Object.values(env).some((item) => typeof item !== "string"))) {
    throw new Error(`${displayPath}: mcpServers[${index}].env must be an object of strings`);
  }
  return { id, command, args: args as string[] | undefined, env: env as Record<string, string> | undefined };
}

/** `.nova/mcp.json`: `{ "servers": [...] }`, for MCP servers wanted every session rather than only inside a plugin. A missing file is zero servers, not an error. */
export async function discoverMcpServers(root: string): Promise<McpServerConfig[]> {
  const raw = await fs.readFile(path.join(root, MCP_CONFIG_PATH), "utf8").catch(() => null);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${MCP_CONFIG_PATH}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  if (!isPlainObject(parsed) || !Array.isArray(parsed.servers)) throw new Error(`${MCP_CONFIG_PATH}: must be an object with a "servers" array`);
  const servers = parsed.servers.map((server, index) => parseMcpServerConfig(MCP_CONFIG_PATH, index, server));
  const ids = new Set<string>();
  for (const server of servers) {
    if (ids.has(server.id)) throw new Error(`${MCP_CONFIG_PATH}: duplicate mcpServers id "${server.id}"`);
    ids.add(server.id);
  }
  return servers;
}

/**
 * A live connection to one MCP server's stdio process — the JSON-RPC plumbing only. `McpToolProvider`
 * below is what turns its tools into something `createNovaTools` can merge in.
 */
export class McpConnection {
  private readonly child: ChildProcess;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private initializePromise: Promise<void> | null = null;

  /** `requestTimeoutMs` is a constructor option (not only the default) so a test can prove the timeout fires without waiting 15s for it. */
  constructor(private readonly config: McpServerConfig, private readonly requestTimeoutMs = REQUEST_TIMEOUT_MS) {
    this.child = spawn(config.command, config.args ?? [], {
      env: { ...process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.on("error", (error) => this.rejectAllPending(error));
    this.child.on("exit", (code) => this.rejectAllPending(new Error(`MCP server '${config.id}' exited (code ${code})`)));
    const lines = createInterface({ input: this.child.stdout! });
    lines.on("line", (line) => this.handleLine(line));
  }

  private rejectAllPending(error: Error): void {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // A malformed line from a misbehaving server is not this client's failure to surface mid-stream.
    }
    if (!isJsonRpcResponse(parsed)) return;
    const waiting = this.pending.get(parsed.id);
    if (!waiting) return;
    this.pending.delete(parsed.id);
    if (parsed.error) waiting.reject(new Error(`MCP server '${this.config.id}': ${parsed.error.message} (code ${parsed.error.code})`));
    else waiting.resolve(parsed.result);
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const line = `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server '${this.config.id}' did not respond to '${method}' within ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      if (!this.child.stdin!.write(line)) { /* backpressure is fine — Node queues it. */ }
    });
  }

  private notify(method: string, params: unknown): void {
    this.child.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  /** Idempotent — every caller awaits the same handshake rather than repeating it. */
  private initialize(): Promise<void> {
    this.initializePromise ??= (async () => {
      await this.request("initialize", {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "nova-cli", version: "1" },
      });
      this.notify("notifications/initialized", {});
    })();
    return this.initializePromise;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>> {
    await this.initialize();
    const result = await this.request("tools/list", {}) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }> };
    return (result.tools ?? []).map((tool) => ({
      name: tool.name,
      description: tool.description ?? "",
      inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: false },
    }));
  }

  async callTool(name: string, argumentsValue: Record<string, unknown>): Promise<{ content: string; isError?: boolean }> {
    await this.initialize();
    const result = await this.request("tools/call", { name, arguments: argumentsValue }) as {
      content?: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    return { content: text || "(no output)", isError: result.isError };
  }

  close(): void {
    this.rejectAllPending(new Error(`MCP server '${this.config.id}' connection closed`));
    this.child.kill();
  }
}

/** Exposes one MCP server's tools as a `ToolProvider`. Schemas outside Nova's supported subset (see tool-schema.ts) fail loudly at registration rather than reaching the model unvalidated. */
export class McpToolProvider implements ToolProvider {
  readonly kind = "mcp" as const;
  readonly id: string;

  constructor(private readonly connection: McpConnection, id: string) {
    this.id = id;
  }

  async listTools(): Promise<ExternalTool[]> {
    const tools = await this.connection.listTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      invoke: (argumentsValue) => this.connection.callTool(tool.name, argumentsValue),
    }));
  }
}
