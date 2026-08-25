import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "./backends";
import { createNovaTools, TodoList } from "./tools";
import { ToolArgumentError, assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "./tool-schema";

const schema: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    depth: { type: "integer" },
    force: { type: "boolean" },
    ids: { type: "array", items: { type: "integer" } },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("tool argument validation", () => {
  it("accepts exactly what the schema declares", () => {
    expect(validateToolArguments("t", schema, { path: "a.ts", depth: 2, force: true, ids: [1, 2] }))
      .toEqual({ path: "a.ts", depth: 2, force: true, ids: [1, 2] });
    expect(validateToolArguments("t", schema, { path: "a.ts" })).toEqual({ path: "a.ts" });
  });

  it("refuses a parameter the tool does not have, and says what it does have", () => {
    // The message is the model's only way to recover, so it names the alternatives rather than
    // just reporting a violation.
    expect(() => validateToolArguments("t", schema, { path: "a", recursive: true }))
      .toThrow(/no parameter "recursive".*accepts: path, depth, force, ids/s);
  });

  it("enforces every declared type", () => {
    expect(() => validateToolArguments("t", schema, { path: 42 })).toThrow(/must be a string/);
    expect(() => validateToolArguments("t", schema, { path: "a", depth: 1.5 })).toThrow(/must be an integer/);
    expect(() => validateToolArguments("t", schema, { path: "a", force: "yes" })).toThrow(/must be true or false/);
    expect(() => validateToolArguments("t", schema, { path: "a", ids: ["x"] })).toThrow(/ids\[0\] must be an integer/);
  });

  it("rejects non-finite numbers, which an integer check must not let through", () => {
    // NaN and Infinity reaching a timeout or a byte offset is a hang or a crash, not a near miss.
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => validateToolArguments("t", schema, { path: "a", depth: value })).toThrow(/must be an integer/);
    }
  });

  it("requires what the schema marks required, including when sent as null", () => {
    expect(() => validateToolArguments("t", schema, {})).toThrow(/requires path/);
    expect(() => validateToolArguments("t", schema, { path: null })).toThrow(/requires path/);
  });

  it("treats an explicit null for an optional parameter as absent", () => {
    // Models routinely send nulls for parameters they are not using; a round trip spent relearning
    // that buys nothing.
    expect(validateToolArguments("t", schema, { path: "a", depth: null })).toEqual({ path: "a" });
  });

  it("accepts a lone item where an array is declared, and nothing else", () => {
    // The single documented coercion — `complete: 2` for `complete: [2]`.
    expect(validateToolArguments("t", schema, { path: "a", ids: 2 })).toEqual({ path: "a", ids: [2] });
    expect(() => validateToolArguments("t", schema, { path: "a", ids: "2" })).toThrow(/ids\[0\] must be an integer/);
  });

  it("rejects arguments that are not an object at all", () => {
    for (const value of [null, undefined, "path=a", 5, [1, 2]]) {
      expect(() => validateToolArguments("t", schema, value)).toThrow(/must be a JSON object/);
    }
  });
});

describe("schema support is asserted, not assumed", () => {
  it("rejects a schema this validator cannot honour rather than passing everything", () => {
    // A schema that silently validates nothing is worse than no validation, because it reads as
    // protection in review.
    expect(() => assertSupportedSchema("t", { type: "object", additionalProperties: false, properties: { a: { type: "object" } } }))
      .toThrow(/unsupported type object/);
    expect(() => assertSupportedSchema("t", { type: "object" })).toThrow(/additionalProperties: false/);
    expect(() => assertSupportedSchema("t", { type: "string", additionalProperties: false })).toThrow(/must be an object schema/);
    expect(() => assertSupportedSchema("t", undefined)).toThrow(/no input schema/);
  });

  it("rejects a required property the schema never declares", () => {
    expect(() => assertSupportedSchema("t", { type: "object", additionalProperties: false, properties: {}, required: ["path"] }))
      .toThrow(/requires path, which it does not declare/);
  });
});

describe("every real Nova tool", () => {
  let root: string;
  const tools = () => createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), fetchImpl: (async () => new Response("ok")) as typeof fetch });

  it("declares a schema this validator supports", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-schema-"));
    try {
      for (const tool of await tools()) expect(() => assertSupportedSchema(tool.name, tool.inputSchema)).not.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("holds the structural invariants the runtime relies on", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-schema-"));
    try {
      const names = new Set<string>();
      for (const tool of await tools()) {
        expect(names.has(tool.name)).toBe(false); // duplicate names would shadow each other
        names.add(tool.name);
        expect(tool.description.trim().length).toBeGreaterThan(0);
        expect(Object.values(NOVA_CAPABILITY_IDS)).toContain(tool.capabilityId);
        // An effectful tool must never run concurrently, and an external one must always be gated.
        if (tool.effect !== "none") expect(tool.parallelSafe).toBe(false);
        if (tool.effect === "external") expect(tool.requiresApproval).toBe(true);
        // Anything that changes the world needs approval; a pure read never should.
        if (tool.effect === "none") expect(tool.requiresApproval).toBe(false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("validates arguments before the tool body ever sees them", async () => {
    // The workspace backends each guard their own types, so a bad `content` was already caught —
    // but only after the call reached a backend, and only in backends that remembered to check.
    // The unknown-parameter case below was not caught anywhere: the extra argument was dropped and
    // the write reported success for something other than what was asked.
    root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-schema-"));
    try {
      const write = (await tools()).find((tool) => tool.name === "write_file")!;
      const context = { taskId: "t", runId: "r", stepId: "s" };
      await expect(write.execute({ path: "a.txt", content: 42 as never }, context)).rejects.toThrow(ToolArgumentError);
      await expect(write.execute({ path: "a.txt" }, context)).rejects.toThrow(/requires content/);
      await expect(write.execute({ path: "a.txt", content: "ok", mode: "append" as never }, context)).rejects.toThrow(/no parameter "mode"/);
      // The file was never created by any of the rejected calls.
      await expect(fs.readFile(path.join(root, "a.txt"), "utf8")).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * The tool contract, pinned.
 *
 * Descriptions are prose and change often; this is everything else — the surface a model can
 * actually call and the authority each call carries. A change here is a change to what the agent
 * is permitted to do, so it should cost a deliberate edit to this table rather than slipping
 * through as a diff nobody read.
 */
const GOLDEN_CONTRACT = [
  { name: "read_file", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: ["path"], properties: ["path", "offset", "limit"] },
  { name: "list_files", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: [], properties: ["path", "depth"] },
  { name: "glob_files", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: ["pattern"], properties: ["pattern"] },
  { name: "grep_files", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: ["query"], properties: ["query", "include", "regex"] },
  { name: "scan_secrets", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: [], properties: ["include"] },
  { name: "write_file", effect: "workspace", capabilityId: "workspace.files", requiresApproval: true, parallelSafe: false, required: ["path", "content"], properties: ["path", "content"] },
  { name: "edit_file", effect: "workspace", capabilityId: "workspace.files", requiresApproval: true, parallelSafe: false, required: ["path", "oldText", "newText"], properties: ["path", "oldText", "newText", "replaceAll"] },
  { name: "run_command", effect: "workspace", capabilityId: "workspace.terminal", requiresApproval: true, parallelSafe: false, required: ["command"], properties: ["command", "timeoutMs"] },
  { name: "start_application", effect: "workspace", capabilityId: "workspace.terminal", requiresApproval: true, parallelSafe: false, required: ["command", "port"], properties: ["command", "port", "directory", "path", "timeoutMs"] },
  { name: "application_status", effect: "none", capabilityId: "workspace.files.read", requiresApproval: false, parallelSafe: true, required: [], properties: ["id"] },
  { name: "stop_application", effect: "workspace", capabilityId: "workspace.terminal", requiresApproval: true, parallelSafe: false, required: ["id"], properties: ["id"] },
  // Defender-only by capability: current native knowledge and the broad fallback playbooks are
  // retrieved only when needed instead of consuming every request.
  { name: "query_defensive_brain", effect: "none", capabilityId: "security.playbooks", requiresApproval: false, parallelSafe: true, required: ["query"], properties: ["query", "limit"] },
  { name: "read_playbook", effect: "none", capabilityId: "security.playbooks", requiresApproval: false, parallelSafe: true, required: ["id"], properties: ["id"] },
  { name: "todo_write", effect: "none", capabilityId: "reasoning.plan", requiresApproval: false, parallelSafe: false, required: [], properties: ["items", "complete", "start"] },
  { name: "todo_read", effect: "none", capabilityId: "reasoning.plan", requiresApproval: false, parallelSafe: true, required: [], properties: [] },
  { name: "web_fetch", effect: "none", capabilityId: "web.research", requiresApproval: false, parallelSafe: true, required: ["url"], properties: ["url"] },
  // `external` is the strongest effect in the vocabulary and the runtime refuses to construct an
  // external tool that does not require approval — which is what makes a deploy physically unable
  // to run without a human answering. Publishing to the internet under someone's account is not
  // undone by a checkpoint, so this row existing with these exact values is the safety property.
  { name: "deploy_app", effect: "external", capabilityId: "workspace.terminal", requiresApproval: true, parallelSafe: false, required: ["action"], properties: ["action", "target", "production", "directory"] },
  // Writing to a file the user carries between sessions is a change to their environment, so it
  // goes through the same approval gate as any other edit rather than being silently free.
  { name: "remember", effect: "workspace", capabilityId: "workspace.files", requiresApproval: true, parallelSafe: false, required: ["text", "scope"], properties: ["text", "scope", "kind"] },
] as const;

describe("the tool contract is pinned", () => {
  it("matches the golden surface, exactly and in order", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-golden-"));
    try {
      // No `search` configured, so web_search is absent — that conditional registration is itself
      // part of the contract, and the golden list reflects the default surface.
      const actual = (await createNovaTools({
        workspace: new LocalWorkspace(root),
        todos: new TodoList(),
        fetchImpl: (async () => new Response("ok")) as typeof fetch,
      })).map((tool) => {
        const schema = tool.inputSchema as ToolInputSchema;
        return {
          name: tool.name,
          effect: tool.effect,
          capabilityId: tool.capabilityId,
          requiresApproval: tool.requiresApproval,
          parallelSafe: tool.parallelSafe,
          required: [...(schema.required ?? [])],
          properties: Object.keys(schema.properties ?? {}),
        };
      });
      expect(actual).toEqual(GOLDEN_CONTRACT.map((entry) => ({ ...entry, required: [...entry.required], properties: [...entry.properties] })));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("adds web_search only when a search client is configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-golden-"));
    try {
      const withSearch = await createNovaTools({
        workspace: new LocalWorkspace(root),
        todos: new TodoList(),
        search: { search: async () => ({ results: [] }) } as never,
      });
      const search = withSearch.find((tool) => tool.name === "web_search");
      expect(search).toMatchObject({ effect: "none", capabilityId: "web.research", requiresApproval: false, parallelSafe: true });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

const NOVA_CAPABILITY_IDS = {
  read: "workspace.files.read",
  write: "workspace.files",
  terminal: "workspace.terminal",
  research: "web.research",
  planning: "reasoning.plan",
  playbooks: "security.playbooks",
} as const;
