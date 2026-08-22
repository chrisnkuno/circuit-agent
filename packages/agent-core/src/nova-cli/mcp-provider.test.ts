import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpConnection, McpToolProvider } from "./mcp-provider";

let root: string;
let serverPath: string;

/**
 * A tiny, real MCP server over stdio — newline-delimited JSON-RPC 2.0, exactly what `McpConnection`
 * speaks. Not a mock of the protocol: this is the actual message shape a real MCP server sends, run
 * as a real subprocess, so a bug in framing or field names shows up the same way it would against a
 * genuine server.
 */
const FAKE_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } } });
    return;
  }
  if (request.method === "notifications/initialized") return; // no response — it's a notification
  if (request.method === "tools/list") {
    send({
      jsonrpc: "2.0", id: request.id,
      result: { tools: [{ name: "add", description: "Adds two integers.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } }] },
    });
    return;
  }
  if (request.method === "tools/call") {
    const { name, arguments: args } = request.params;
    if (name === "add") {
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: String(args.a + args.b) }] } });
      return;
    }
    send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown tool: " + name } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method: " + request.method } });
});
`;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-mcp-"));
  serverPath = path.join(root, "fake-server.js");
  await fs.writeFile(serverPath, FAKE_SERVER_SCRIPT);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("McpConnection", () => {
  it("lists tools from the real server", async () => {
    const connection = new McpConnection({ id: "fake", command: "node", args: [serverPath] });
    try {
      const tools = await connection.listTools();
      expect(tools).toEqual([
        { name: "add", description: "Adds two integers.", inputSchema: { type: "object", properties: { a: { type: "integer" }, b: { type: "integer" } }, required: ["a", "b"], additionalProperties: false } },
      ]);
    } finally {
      connection.close();
    }
  });

  it("calls a real tool and gets back the text content it computed", async () => {
    const connection = new McpConnection({ id: "fake", command: "node", args: [serverPath] });
    try {
      const result = await connection.callTool("add", { a: 2, b: 3 });
      expect(result).toEqual({ content: "5", isError: undefined });
    } finally {
      connection.close();
    }
  });

  it("surfaces a JSON-RPC error from the server as a rejected promise naming the server", async () => {
    const connection = new McpConnection({ id: "fake", command: "node", args: [serverPath] });
    try {
      await expect(connection.callTool("nonexistent", {})).rejects.toThrow(/fake.*Unknown tool: nonexistent/s);
    } finally {
      connection.close();
    }
  });

  it("rejects every pending request when the server process exits", async () => {
    const connection = new McpConnection({ id: "fake", command: "node", args: ["-e", "process.exit(1)"] });
    await expect(connection.listTools()).rejects.toThrow(/exited/);
  });

  it("rejects a request that never gets a response within the timeout", async () => {
    const silentServerPath = path.join(root, "silent-server.js");
    await fs.writeFile(silentServerPath, "setInterval(() => {}, 1000);"); // never reads stdin, never replies
    const connection = new McpConnection({ id: "silent", command: "node", args: [silentServerPath] }, 100);
    try {
      await expect(connection.listTools()).rejects.toThrow(/did not respond/);
    } finally {
      connection.close();
    }
  });
});

describe("an MCP server's environment", () => {
  // Found by probing the running code, not by reading it: `run_command` already had Nova's own
  // provider keys stripped, while an MCP server — third-party code Nova spawns, with strictly less
  // reason to see them — was started with the full parent environment. Same defect, newer path.
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; });

  /** Writes a server that records what it can see in its own environment, then answers normally. */
  async function envReportingServer(outputPath: string): Promise<string> {
    const scriptPath = path.join(root, "env-server.js");
    await fs.writeFile(scriptPath, `
      require("node:fs").writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify({
        anthropic: process.env.ANTHROPIC_API_KEY ?? null,
        ownCredential: process.env.MY_SERVER_TOKEN ?? null,
        path: Boolean(process.env.PATH),
      }));
      ${FAKE_SERVER_SCRIPT}
    `);
    return scriptPath;
  }

  it("never sees Nova's own provider keys, matching what run_command already guaranteed", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-live-secret-value";
    const reportPath = path.join(root, "seen.json");
    const connection = new McpConnection({ id: "probe", command: "node", args: [await envReportingServer(reportPath)] });
    try {
      await connection.listTools();
      const seen = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(seen.anthropic).toBeNull();
      expect(seen.path).toBe(true); // still a working environment, not an empty one
    } finally {
      connection.close();
    }
  });

  it("still receives its own declared credentials, which sanitizing must not strip", async () => {
    // The server's own token is exactly what `env` in its config is for, and it is applied after
    // sanitizing precisely so a credential-shaped name of its own survives.
    process.env.ANTHROPIC_API_KEY = "sk-ant-live-secret-value";
    const reportPath = path.join(root, "seen-own.json");
    const connection = new McpConnection({
      id: "probe",
      command: "node",
      args: [await envReportingServer(reportPath)],
      env: { MY_SERVER_TOKEN: "the-server-own-token" },
    });
    try {
      await connection.listTools();
      const seen = JSON.parse(await fs.readFile(reportPath, "utf8"));
      expect(seen.ownCredential).toBe("the-server-own-token");
      expect(seen.anthropic).toBeNull();
    } finally {
      connection.close();
    }
  });
});

describe("McpToolProvider", () => {
  it("exposes the connection's tools as invokable ExternalTools", async () => {
    const connection = new McpConnection({ id: "fake", command: "node", args: [serverPath] });
    try {
      const provider = new McpToolProvider(connection, "fake-server");
      const tools = await provider.listTools();
      expect(tools).toHaveLength(1);
      const result = await tools[0].invoke({ a: 10, b: 32 });
      expect(result).toEqual({ content: "42", isError: undefined });
    } finally {
      connection.close();
    }
  });
});

/**
 * The same server, but it counts `tools/list` calls and announces a change when asked.
 *
 * Counting is the point: `createNovaTools` runs on every turn, so an uncached `tools/list` is a
 * network round trip per turn per server, on the critical path between Enter and the model.
 */
const COUNTING_SERVER_SCRIPT = `
const readline = require("node:readline");
const rl = readline.createInterface({ input: process.stdin });
let listCalls = 0;
let toolName = "add";
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
rl.on("line", (line) => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "counting", version: "1" } } });
    return;
  }
  if (request.method === "notifications/initialized") return;
  if (request.method === "tools/list") {
    listCalls += 1;
    send({ jsonrpc: "2.0", id: request.id, result: { tools: [{ name: toolName, description: "call " + listCalls, inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    return;
  }
  if (request.method === "tools/call" && request.params && request.params.name === "swap") {
    toolName = "subtract";
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "swapped" }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "Unknown method" } });
});
`;

describe("an MCP server's tool list", () => {
  async function countingConnection() {
    const file = path.join(root, "counting-server.js");
    await fs.writeFile(file, COUNTING_SERVER_SCRIPT);
    return new McpConnection({ id: "counting", command: "node", args: [file] });
  }

  it("is fetched once, not once per turn", async () => {
    const connection = await countingConnection();
    try {
      const first = await connection.listTools();
      const second = await connection.listTools();
      const third = await connection.listTools();
      // "call 1" in the description proves all three answers came from the same round trip.
      expect(first[0].description).toBe("call 1");
      expect(second).toEqual(first);
      expect(third).toEqual(first);
    } finally {
      connection.close();
    }
  });

  it("is fetched again when the server says its tools changed", async () => {
    // Caching is only correct because servers announce changes. This is that announcement.
    const connection = await countingConnection();
    try {
      expect((await connection.listTools())[0].name).toBe("add");
      await connection.callTool("swap", {}).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 50));
      const refreshed = await connection.listTools();
      expect(refreshed[0].name).toBe("subtract");
      expect(refreshed[0].description).toBe("call 2");
    } finally {
      connection.close();
    }
  });
});
