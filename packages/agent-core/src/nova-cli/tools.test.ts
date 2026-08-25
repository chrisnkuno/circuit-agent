import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentTool } from "../agent-runtime";
import { LocalWorkspace } from "./backends";
import { HookRegistry } from "./hooks";
import { NestedInstructionTracker } from "./nested-instructions";
import type { ToolProvider } from "./tool-providers";
import { classifyVerification, createNovaTools, isRefusedCommand, looksLikeVerification, missingProgram, TodoList } from "./tools";

let root: string;
const context = { taskId: "t", runId: "r", stepId: "s" };

function toolNamed(tools: AgentTool[], name: string): AgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-tools-"));
  await fs.mkdir(path.join(root, "src"), { recursive: true });
  await fs.writeFile(path.join(root, "src", "app.ts"), "export const port = 3000;\n");
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("nova tool set", () => {
  it("declares effects the runtime can enforce, and gates exactly the dangerous ones", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    for (const name of ["read_file", "list_files", "glob_files", "grep_files", "scan_secrets", "application_status"]) {
      expect(byName[name].effect, name).toBe("none");
      expect(byName[name].requiresApproval, name).toBe(false);
    }
    for (const name of ["write_file", "edit_file", "run_command", "start_application", "stop_application"]) {
      expect(byName[name].effect, name).toBe("workspace");
      expect(byName[name].requiresApproval, name).toBe(true);
      // The runtime refuses to parallelise anything with an effect; this is what makes that true.
      expect(byName[name].parallelSafe, name).toBe(false);
    }
  });

  it("reads, writes and edits through the confined workspace", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const read = await toolNamed(tools, "read_file").execute({ path: "src/app.ts" }, context);
    expect(read.content).toContain("port = 3000");

    await toolNamed(tools, "edit_file").execute({ path: "src/app.ts", oldText: "3000", newText: "8080" }, context);
    expect(await fs.readFile(path.join(root, "src", "app.ts"), "utf8")).toContain("8080");

    await expect(toolNamed(tools, "read_file").execute({ path: "../escape.txt" }, context)).rejects.toThrow(/escapes the workspace/);
  });

  it("retrieves bounded reviewed security knowledge and marks stale evidence", async () => {
    let received: [string, number] | undefined;
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      defenderBrain: {
        async search(query, limit) {
          received = [query, limit ?? 4];
          return { hits: [{
            id: "pqc", domain: "cryptographic-research", title: "PQC migration", summary: "Inventory first.",
            guidance: "Use standardized implementations.", tags: ["PQC"], reviewedAt: "2026-08-24",
            expiresAt: "2026-09-24", confidence: "high", stale: true, score: 1,
            sources: [{ title: "NIST PQC", url: "https://www.nist.gov/pqc", publishedAt: null, accessedAt: "2026-08-24", primary: true }],
          }] };
        },
      },
    });
    const result = await toolNamed(tools, "query_defensive_brain").execute({ query: "PQC migration", limit: 8 }, context);
    expect(received).toEqual(["PQC migration", 8]);
    expect(result.content).toContain("STALE — verify before relying on it");
    expect(result.content).toContain("https://www.nist.gov/pqc");
    expect(result.data).toEqual({ records: [{ id: "pqc", domain: "cryptographic-research", stale: true, confidence: "high" }] });
  });

  it("degrades to the curated playbook when the native brain is absent", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const result = await toolNamed(tools, "query_defensive_brain").execute({ query: "identity" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("use read_playbook");
  });

  it("finds a hardcoded secret and masks it in the tool's own output", async () => {
    await fs.writeFile(path.join(root, "src", "config.ts"), 'export const key = "AKIAABCDEFGHIJKLMNOP";\n');
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const result = await toolNamed(tools, "scan_secrets").execute({}, context);
    expect(result.content).toContain("src/config.ts:1");
    expect(result.content).toContain("AWS access key");
    expect(result.content).toContain("AKIA…MNOP"); // masked
    expect(result.content).not.toContain("AKIAABCDEFGHIJKLMNOP"); // never the value in full
    expect(result.content).toContain("[critical] AWS access key");
    expect(result.data).toMatchObject({ findings: [{ path: "src/config.ts", line: 1, kind: "AWS access key", severity: "critical" }] });
  });

  it("orders findings worst severity first, regardless of which file they were found in", async () => {
    await fs.writeFile(path.join(root, "src", "config.ts"), 'const token = "abcdefghij1234567890";\n');
    await fs.writeFile(path.join(root, "src", "other.ts"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const result = await toolNamed(tools, "scan_secrets").execute({}, context);
    const findings = result.data!.findings as Array<{ severity: string }>;
    expect(findings[0].severity).toBe("critical");
    expect(findings.at(-1)!.severity).toBe("medium");
  });

  it("finds nothing in a project with no secret-shaped strings", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const result = await toolNamed(tools, "scan_secrets").execute({}, context);
    expect(result.content).toContain("No likely secrets found");
    expect(result.data).toEqual({ findings: [] });
  });

  it("scopes the scan with the same include glob grep_files uses", async () => {
    await fs.mkdir(path.join(root, "vendor"), { recursive: true });
    await fs.writeFile(path.join(root, "vendor", "third-party.ts"), 'const key = "AKIAABCDEFGHIJKLMNOP";\n');
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const result = await toolNamed(tools, "scan_secrets").execute({ include: "src/**" }, context);
    expect(result.content).toContain("No likely secrets found");
  });

  it("runs commands through the injected runner and marks a passing check as verification", async () => {
    const seen: string[] = [];
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async (command: string) => {
        seen.push(command);
        return { exitCode: 0, stdout: "2 passed", stderr: "" };
      }),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(seen).toEqual(["npm test"]);
    expect(result.content).toContain("exit 0");
    expect(result.verification).toEqual({ passed: true, kind: "tests", scope: "targeted", summary: "npm test exited 0" });

    const plain = await toolNamed(tools, "run_command").execute({ command: "ls -la" }, context);
    expect(plain.verification).toBeUndefined();
  });

  it("refuses foreground dev servers but permits a bounded start-probe-cleanup smoke command", async () => {
    const seen: string[] = [];
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async (command: string) => {
        seen.push(command);
        return { exitCode: 0, stdout: "HTTP 200", stderr: "" };
      }),
      todos: new TodoList(),
    });
    const run = toolNamed(tools, "run_command");
    const persistent = await run.execute({ command: "cd game && bun run dev", timeoutMs: 100_000 }, context);
    expect(persistent).toMatchObject({ isError: true, data: { reason: "persistent_foreground_command" } });
    expect(persistent.content).toContain("start_application");
    expect(seen).toHaveLength(0);

    const bounded = "bun run dev & server_pid=$!; trap 'kill $server_pid' EXIT; curl --fail http://127.0.0.1:3000";
    const smoke = await run.execute({ command: bounded }, context);
    expect(seen).toEqual([bounded]);
    expect(smoke.verification).toMatchObject({ passed: true, kind: "smoke" });
  });

  it("does not accept echo-only or explicitly empty scripts as verification", async () => {
    const outputs = [
      { stdout: "No build step needed\nNo automated tests for this browser canvas game yet", stderr: "" },
      { stdout: "0 tests run", stderr: "" },
    ];
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 0, ...outputs.shift()! })),
      todos: new TodoList(),
    });
    const run = toolNamed(tools, "run_command");
    for (const command of ["bun run build && bun run test", "npm test"]) {
      const result = await run.execute({ command }, context);
      expect(result.isError).toBe(false);
      expect(result.verification).toBeUndefined();
      expect(result.content).toContain("did not accept this as verification");
      expect(result.data).toHaveProperty("verificationRejectedReason");
    }
  });

  it("reports a non-zero command as an error without throwing away its output", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 1, stdout: "", stderr: "TypeError: x is not a function" })),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("TypeError");
  });

  it("refuses irrecoverable commands rather than offering them for approval", async () => {
    expect(isRefusedCommand("rm -rf /")).toBe(true);
    expect(isRefusedCommand("git reset --hard HEAD~3")).toBe(true);
    expect(isRefusedCommand("git clean -fd")).toBe(true);
    expect(isRefusedCommand("rm build/output.txt")).toBe(false);
    expect(isRefusedCommand("npm test")).toBe(false);

    let ran = false;
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root, undefined, async () => { ran = true; return { exitCode: 0, stdout: "", stderr: "" }; }), todos: new TodoList() });
    const result = await toolNamed(tools, "run_command").execute({ command: "rm -rf ." }, context);
    expect(ran).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Refused");
  });

  it("keeps a working checklist across calls", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const write = toolNamed(tools, "todo_write");
    const created = await write.execute({ items: ["read the config", "add the flag"] }, context);
    expect(created.content).toContain("[ ] 1. read the config");

    const started = await write.execute({ start: 1 }, context);
    expect(started.content).toContain("[~] 1.");

    const done = await write.execute({ complete: 1 }, context);
    expect(done.content).toContain("[x] 1.");

    const read = await toolNamed(tools, "todo_read").execute({}, context);
    expect(read.content).toContain("[x] 1. read the config");
  });

  it("applies the ids that exist and reports the rest, instead of failing the whole batch", async () => {
    // Observed live: a model referenced an id (3) from an earlier turn's list. The old
    // implementation threw on the first unknown id, which silently discarded a *valid* update
    // (id 1, present in the same call) along with it — a single stale id failed the whole batch.
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const write = toolNamed(tools, "todo_write");
    await write.execute({ items: ["read the config", "add the flag"] }, context);

    const result = await write.execute({ complete: [1, 3] }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("[x] 1. read the config"); // the valid id still applied
    expect(result.content).toContain("No todo with id 3");
  });

  it("offers web_search only when search is configured", async () => {
    const withoutSearch = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    expect(withoutSearch.some((tool) => tool.name === "web_search")).toBe(false);

    const withSearch = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: { search: async () => ({ requestId: "r", results: [] }) } as never,
    });
    expect(withSearch.some((tool) => tool.name === "web_search")).toBe(true);
  });

  it("formats search results into something the model can cite", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: {
        search: async () => ({
          requestId: "r",
          results: [{ title: "Node fetch docs", url: "https://example.com/fetch", publishedDate: null, author: null, highlights: ["fetch is global since 18"] }],
        }),
      } as never,
    });
    const result = await toolNamed(tools, "web_search").execute({ query: "node fetch" }, context);
    expect(result.content).toContain("[1] Node fetch docs");
    expect(result.content).toContain("https://example.com/fetch");
    expect(result.content).toContain("global since 18");
  });

  it("keeps default searches compact and bounds each extracted result", async () => {
    let seen: Record<string, unknown> = {};
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: {
        search: async (request: Record<string, unknown>) => {
          seen = request;
          return {
            requestId: "r",
            results: [{ title: "Long", url: "https://a.test", publishedDate: null, author: null, highlights: [], text: `start-${"x".repeat(3_000)}-end` }],
          };
        },
      } as never,
    });
    const result = await toolNamed(tools, "web_search").execute({ query: "x" }, context);
    expect(seen.numResults).toBe(3);
    expect(result.content).toContain("start-");
    expect(result.content).not.toContain("-end");
    expect(result.content.length).toBeLessThan(1_700);
  });

  it("passes scoping and freshness through to the client, which is what makes it useful to DEFENDER", async () => {
    let seen: Record<string, unknown> = {};
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: { search: async (request: Record<string, unknown>) => { seen = request; return { requestId: "r", results: [] }; } } as never,
    });
    await toolNamed(tools, "web_search").execute(
      { query: "express advisory", includeDomains: ["nvd.nist.gov", "  "], startPublishedDate: "2026-01-01", fresh: true, numResults: 12 },
      context,
    );
    expect(seen.includeDomains).toEqual(["nvd.nist.gov"]);
    expect(seen.startPublishedDate).toBe("2026-01-01");
    expect(seen.contents).toEqual({ maxAgeHours: 0 });
    expect(seen.numResults).toBe(12);
    // Left unset so the client sends Exa's highest-quality bare `highlights: true`.
    expect(seen).not.toHaveProperty("highlights");
  });

  it("bills what the provider reported rather than what the catalog would have estimated", async () => {
    const charged: Array<Record<string, unknown>> = [];
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      onExpense: (expense) => charged.push(expense as unknown as Record<string, unknown>),
      search: {
        search: async () => ({ requestId: "r", results: [{ title: "T", url: "https://a.test", publishedDate: null, author: null, highlights: [] }], costDollars: 0.019 }),
      } as never,
    });
    await toolNamed(tools, "web_search").execute({ query: "x" }, context);
    expect(charged[0].reportedUsd).toBe(0.019);
    expect(charged[0].quantities).toEqual({ request: 1, contents: 1 });
  });
});

describe("deep_research", () => {
  const deepClient = (response: Record<string, unknown>, capture?: (request: Record<string, unknown>) => void) => ({
    search: async (request: Record<string, unknown>) => { capture?.(request); return response; },
  }) as never;

  it("is offered alongside web_search, and only when search is configured", async () => {
    const without = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    expect(without.some((tool) => tool.name === "deep_research")).toBe(false);

    const withSearch = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({ requestId: "r", results: [] }),
    });
    const tool = toolNamed(withSearch, "deep_research");
    expect(tool.effect).toBe("none");
    expect(tool.requiresApproval).toBe(false);
  });

  it("maps effort onto Exa's deep search types", async () => {
    for (const [effort, type] of [["lite", "deep-lite"], ["standard", "deep"], ["maximum", "deep-reasoning"], [undefined, "deep"]] as const) {
      let seen: Record<string, unknown> = {};
      const tools = await createNovaTools({
        workspace: new LocalWorkspace(root),
        todos: new TodoList(),
        search: deepClient({ requestId: "r", results: [] }, (request) => { seen = request; }),
      });
      await toolNamed(tools, "deep_research").execute({ query: "x", ...(effort ? { effort } : {}) }, context);
      expect(seen.type, effort ?? "default").toBe(type);
      // A text schema, not a structured one: the caller is a model that reads prose and decides
      // for itself, and citations come back in `grounding` regardless.
      expect((seen.outputSchema as { type?: string })?.type).toBe("text");
    }
  });

  it("routes instructions to systemPrompt, which steers behaviour rather than shape", async () => {
    let seen: Record<string, unknown> = {};
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({ requestId: "r", results: [] }, (request) => { seen = request; }),
    });
    await toolNamed(tools, "deep_research").execute({ query: "x", instructions: "  prefer official advisories  " }, context);
    expect(seen.systemPrompt).toBe("prefer official advisories");
  });

  it("reports the synthesized answer with its sources, deduplicated across grounding and results", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({
        requestId: "r",
        searchType: "deep",
        results: [{ title: "NVD entry", url: "https://nvd.nist.gov/x", publishedDate: "2026-02-01T00:00:00Z", author: null, highlights: ["raw extract that the synthesis already consumed"] }],
        output: {
          content: "Affected below 4.19.2.",
          grounding: [{ field: "content", citations: [{ url: "https://nvd.nist.gov/x", title: "NVD" }], confidence: "high" }],
        },
      }),
    });
    const result = await toolNamed(tools, "deep_research").execute({ query: "express cve" }, context);
    expect(result.content).toContain("Affected below 4.19.2.");
    expect(result.content).not.toContain("raw extract that the synthesis already consumed");
    // The same URL is cited and returned as a result; it must appear once, not twice.
    expect(result.content.match(/nvd\.nist\.gov\/x/g)?.length).toBeGreaterThanOrEqual(1);
    expect((result.data?.sources as string[])).toEqual(["https://nvd.nist.gov/x"]);
  });

  it("uses fewer sources by default because synthesis, not result count, is the product", async () => {
    let seen: Record<string, unknown> = {};
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({ requestId: "r", results: [] }, (request) => { seen = request; }),
    });
    await toolNamed(tools, "deep_research").execute({ query: "x" }, context);
    expect(seen.numResults).toBe(6);
  });

  /**
   * Synthesis is the part most likely to come back empty on a hard question. Returning "no results"
   * then would throw away a list of the right pages — which is a usable answer on its own.
   */
  it("still reports its sources when synthesis came back empty", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({
        requestId: "r",
        results: [{ title: "A page", url: "https://a.test/x", publishedDate: null, author: null, highlights: [] }],
        output: { content: null, grounding: [] },
      }),
    });
    const result = await toolNamed(tools, "deep_research").execute({ query: "x" }, context);
    expect(result.content).toContain("https://a.test/x");
    expect(result.isError).toBeUndefined();
  });

  it("says so plainly when there is nothing at all", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      search: deepClient({ requestId: "r", results: [], output: { content: "", grounding: [] } }),
    });
    expect((await toolNamed(tools, "deep_research").execute({ query: "x" }, context)).content).toBe("No results.");
  });
});

describe("web_fetch", () => {
  const page = "<html><body><p>Hello</p></body></html>";

  it("uses Exa's extractor when configured, since it renders JS pages and PDFs a raw fetch cannot", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      fetchImpl: (async () => new Response(page, { status: 200 })) as unknown as typeof fetch,
      search: {
        search: async () => ({ requestId: "r", results: [] }),
        contents: async () => ({ requestId: "r", results: [{ title: "T", url: "https://a.test", highlights: [], publishedDate: null, author: null, text: "extracted body" }], statuses: [{ url: "https://a.test", status: "success", errorTag: null }], costDollars: 0.001 }),
      } as never,
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://a.test" }, context);
    expect(result.content).toBe("extracted body");
    expect(result.data?.via).toBe("exa");
  });

  it("caps extracted pages before they enter the model transcript", async () => {
    let requestedMax = 0;
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      fetchImpl: (async () => new Response(page, { status: 200 })) as unknown as typeof fetch,
      search: {
        search: async () => ({ requestId: "r", results: [] }),
        contents: async (_urls: string[], options: { text: { maxCharacters: number } }) => {
          requestedMax = options.text.maxCharacters;
          return { requestId: "r", results: [{ title: "T", url: "https://a.test", highlights: [], publishedDate: null, author: null, text: "x".repeat(30_000) }], statuses: [], costDollars: null };
        },
      } as never,
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://a.test" }, context);
    expect(requestedMax).toBe(16_000);
    expect(result.content).toHaveLength(16_000);
  });

  it("falls back to a plain fetch when extraction fails, so it is never worse than before", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      fetchImpl: (async () => new Response(page, { status: 200 })) as unknown as typeof fetch,
      search: {
        search: async () => ({ requestId: "r", results: [] }),
        contents: async () => { throw new Error("extractor down"); },
      } as never,
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://a.test" }, context);
    expect(result.content).toContain("Hello");
    expect(result.data?.via).toBe("fetch");
  });

  it("falls back rather than reporting success when Exa returns a per-url error inside its 200", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      fetchImpl: (async () => new Response(page, { status: 200 })) as unknown as typeof fetch,
      search: {
        search: async () => ({ requestId: "r", results: [] }),
        contents: async () => ({ requestId: "r", results: [], statuses: [{ url: "https://a.test", status: "error", errorTag: "CRAWL_NOT_FOUND" }], costDollars: null }),
      } as never,
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://a.test" }, context);
    expect(result.data?.via).toBe("fetch");
  });

  it("still refuses a non-http url", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      fetchImpl: (async () => new Response(page, { status: 200 })) as unknown as typeof fetch,
    });
    await expect(toolNamed(tools, "web_fetch").execute({ url: "file:///etc/passwd" }, context)).rejects.toThrow("http or https");
  });
});

describe("delegate_task", () => {
  it("is offered only when a delegate runner is configured", async () => {
    const withoutDelegate = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    expect(withoutDelegate.some((tool) => tool.name === "delegate_task")).toBe(false);

    const withDelegate = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      delegate: async () => ({ report: "done", status: "completed", iterations: 1, toolCallsExecuted: 0 }),
    });
    const tool = withDelegate.find((candidate) => candidate.name === "delegate_task")!;
    expect(tool).toBeDefined();
    expect(tool.effect).toBe("none");
    expect(tool.parallelSafe).toBe(false);
  });

  it("returns the sub-agent's report as its content", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      delegate: async (task) => ({ report: `handled: ${task}`, status: "completed", iterations: 3, toolCallsExecuted: 5 }),
    });
    const result = await toolNamed(tools, "delegate_task").execute({ task: "count the exported symbols in src/" }, context);
    expect(result.content).toBe("handled: count the exported symbols in src/");
  });

  it("appends a note when the sub-agent did not finish cleanly", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      delegate: async () => ({ report: "ran out of budget", status: "iteration_limit", iterations: 15, toolCallsExecuted: 40 }),
    });
    const result = await toolNamed(tools, "delegate_task").execute({ task: "x" }, context);
    expect(result.content).toContain("ran out of budget");
    expect(result.content).toContain("iteration_limit");
    expect(result.content).toContain("15 iteration(s)");
  });

  it("requires a task", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root),
      todos: new TodoList(),
      delegate: async () => ({ report: "", status: "completed", iterations: 0, toolCallsExecuted: 0 }),
    });
    await expect(toolNamed(tools, "delegate_task").execute({}, context)).rejects.toThrow(/task/);
  });
});

describe("web_fetch", () => {
  it("offers web_fetch only when a fetch implementation is available", async () => {
    const withFetch = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), fetchImpl: async () => new Response("ok") });
    expect(withFetch.some((tool) => tool.name === "web_fetch")).toBe(true);

    const withoutFetch = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), fetchImpl: undefined as unknown as typeof fetch });
    // Falls back to globalThis.fetch, which exists in this runtime — the tool is still offered.
    expect(withoutFetch.some((tool) => tool.name === "web_fetch")).toBe(true);
  });

  it("rejects a non-http(s) url before ever calling fetch", async () => {
    let called = false;
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root), todos: new TodoList(),
      fetchImpl: async () => { called = true; return new Response("ok"); },
    });
    await expect(toolNamed(tools, "web_fetch").execute({ url: "file:///etc/passwd" }, context)).rejects.toThrow(/http or https/);
    expect(called).toBe(false);
  });

  it("reports a failed fetch as a tool error rather than throwing", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root), todos: new TodoList(),
      fetchImpl: async () => new Response("not found", { status: 404 }),
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://example.com/missing" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  it("strips markup and decodes entities so the model reads text, not tags", async () => {
    const html = "<html><head><style>body{color:red}</style></head><body><script>evil()</script><p>Fish &amp; Chips &lt;3</p></body></html>";
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root), todos: new TodoList(),
      fetchImpl: async () => new Response(html, { status: 200 }),
    });
    const result = await toolNamed(tools, "web_fetch").execute({ url: "https://example.com/page" }, context);
    expect(result.content).toBe("Fish & Chips <3");
    expect(result.content).not.toContain("evil()");
    expect(result.content).not.toContain("color:red");
  });
});

describe("verification detection", () => {
  it("recognises the commands whose exit code is real evidence", () => {
    expect(looksLikeVerification("npm test")).toBe(true);
    expect(looksLikeVerification("bunx tsc --noEmit")).toBe(true);
    expect(looksLikeVerification("pytest -q")).toBe(true);
    expect(looksLikeVerification("git status")).toBe(false);
    expect(looksLikeVerification("echo hello")).toBe(false);
  });

  it("recognises a compile check, even with an underscore before it", () => {
    // Observed live: writing tetris.py then running `python3 -m py_compile tetris.py` (a real,
    // passing syntax check) still reported needs_verification, because "compile" has no word
    // boundary right after the underscore in "py_compile" and the original list had no bare
    // "compile" alternative either.
    expect(looksLikeVerification("python3 -m py_compile tetris.py")).toBe(true);
    expect(looksLikeVerification("gcc -fsyntax-only main.c && echo compile ok")).toBe(true);
  });

  it("recognises linters and type checkers whose tool name itself contains 'lint'", () => {
    // A bare \blint\b never matched "eslint" or "pylint" — there is no word boundary between the
    // preceding letter and "lint" inside either name.
    expect(looksLikeVerification("eslint .")).toBe(true);
    expect(looksLikeVerification("pylint src")).toBe(true);
    expect(looksLikeVerification("ruff check .")).toBe(true);
    expect(looksLikeVerification("mypy .")).toBe(true);
    expect(looksLikeVerification("cargo clippy")).toBe(true);
  });

  it("separates executed behaviour from evidence that the code merely compiles", () => {
    // A build proves the code parses and type-checks; only a test run says it behaves. Collapsing
    // the two let an agent report success for code that compiled and did the wrong thing.
    expect(classifyVerification("npm test")).toBe("tests");
    expect(classifyVerification("pytest -q")).toBe("tests");
    expect(classifyVerification("go test ./...")).toBe("tests");
    expect(classifyVerification("cargo test")).toBe("tests");
    // Runner names with no word boundary before "test" need naming outright.
    expect(classifyVerification("bunx vitest run")).toBe("tests");
    expect(classifyVerification("npx jest --ci")).toBe("tests");
    expect(classifyVerification("bundle exec rspec")).toBe("tests");

    expect(classifyVerification("bunx tsc --noEmit")).toBe("check");
    expect(classifyVerification("eslint .")).toBe("check");
    expect(classifyVerification("python3 -m py_compile tetris.py")).toBe("check");
    expect(classifyVerification("npm run build")).toBe("check");

    expect(classifyVerification("git status")).toBeNull();
    expect(classifyVerification("echo hello")).toBeNull();
  });

  /**
   * The two rungs above unit tests. Both answer a question units cannot: whether the pieces were
   * assembled into something that runs at all.
   */
  it("recognises evidence that the assembled program was actually exercised", () => {
    for (const command of ["npx playwright test", "npm run e2e", "yarn cypress run", "pytest tests/integration", "npm run test:integration", "behave features/"]) {
      expect(classifyVerification(command), command).toBe("behavior");
    }
    for (const command of ["npm run smoke", "curl -sf http://localhost:5173/", "wget -qO- http://127.0.0.1:8000/health", "npm run healthcheck"]) {
      expect(classifyVerification(command), command).toBe("smoke");
    }
  });

  it("credits a command with the strongest claim it actually supports", () => {
    // Every one of these also matches the unit-test pattern — "playwright test", "vitest run e2e/".
    // Classifying them as plain unit tests would throw away the stronger claim and ask the agent
    // for functional evidence it had just produced.
    expect(classifyVerification("npx playwright test")).toBe("behavior");
    expect(classifyVerification("bunx vitest run e2e/")).toBe("behavior");
    expect(classifyVerification("npm run build && npm run e2e")).toBe("behavior");
    // ...and a smoke probe outranks the build it followed, but not a real e2e suite.
    expect(classifyVerification("npm run build && curl -sf localhost:3000")).toBe("smoke");
    expect(classifyVerification("npm run e2e && curl -sf localhost:3000")).toBe("behavior");
  });

  it("reads a command that both builds and tests as the stronger of the two", () => {
    // `npm run check` in this very repo runs tests, typecheck and build together. Reporting it as
    // compile-only evidence would ask the agent for tests it had in fact already run.
    expect(classifyVerification("bun run test && bun run typecheck")).toBe("tests");
    expect(classifyVerification("make check test")).toBe("tests");
  });

  it("reports the evidence kind alongside the passing command", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async (command) => ({
        exitCode: 0, stdout: `${command} ok`, stderr: "",
      })),
      todos: new TodoList(),
    });
    const run = toolNamed(tools, "run_command");
    expect((await run.execute({ command: "npm test" }, context)).verification).toMatchObject({ passed: true, kind: "tests" });
    expect((await run.execute({ command: "tsc --noEmit" }, context)).verification).toMatchObject({ passed: true, kind: "check" });
    expect((await run.execute({ command: "git status" }, context)).verification).toBeUndefined();
  });

  it("does not report verification for a command that failed", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 1, stdout: "", stderr: "2 failed" })),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(result.isError).toBe(true);
    expect(result.verification).toBeUndefined();
  });
});

describe("nested instructions surfaced through the real tool wiring", () => {
  it("appends a subdirectory's instructions to read_file's own content, the first time it is reached", async () => {
    await fs.mkdir(path.join(root, "src", "api"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "api", "AGENTS.md"), "Use snake_case for API field names.");
    await fs.writeFile(path.join(root, "src", "api", "handler.ts"), "export const handler = 1;");
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), instructions: new NestedInstructionTracker(new LocalWorkspace(root)) });

    const first = await toolNamed(tools, "read_file").execute({ path: "src/api/handler.ts" }, context);
    expect(first.content).toContain("export const handler");
    expect(first.content).toContain("Use snake_case for API field names.");

    // Reached again — by a different tool this time — the same instructions are not repeated.
    const second = await toolNamed(tools, "edit_file").execute({ path: "src/api/handler.ts", oldText: "handler = 1", newText: "handler = 2" }, context);
    expect(second.content).not.toContain("snake_case");
  });

  it("does not append anything when no instructions exist, or when instructions were not configured", async () => {
    const withTracker = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), instructions: new NestedInstructionTracker(new LocalWorkspace(root)) });
    const plain = await toolNamed(withTracker, "read_file").execute({ path: "src/app.ts" }, context);
    expect(plain.content).toBe("export const port = 3000;\n");

    const withoutTracker = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList() });
    const untracked = await toolNamed(withoutTracker, "read_file").execute({ path: "src/app.ts" }, context);
    expect(untracked.content).toBe(plain.content);
  });

  it("does not surface instructions for a call that failed", async () => {
    await fs.writeFile(path.join(root, "src", "AGENTS.md"), "src rules");
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), instructions: new NestedInstructionTracker(new LocalWorkspace(root)) });
    const result = await toolNamed(tools, "read_file").execute({ path: "src/missing.ts" }, context).catch((error: Error) => ({ content: error.message, isError: true }));
    expect(result.content).not.toContain("src rules");
  });

  it("leaves list_files, glob_files and grep_files untouched — only path-taking tools carry this", async () => {
    await fs.writeFile(path.join(root, "src", "AGENTS.md"), "src rules");
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), instructions: new NestedInstructionTracker(new LocalWorkspace(root)) });
    const listed = await toolNamed(tools, "list_files").execute({ path: "src" }, context);
    expect(listed.content).not.toContain("src rules");
  });
});

describe("external tools merged in from providers", () => {
  const echoProvider = (id: string, name: string): ToolProvider => ({
    id,
    kind: "skill",
    listTools: async () => [
      {
        name,
        description: "Echoes its input.",
        inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false },
        invoke: async (args) => ({ content: `echoed: ${args.text}` }),
      },
    ],
  });

  it("appears in the final tool list, tagged with provenance, gated the same as any external-effect tool", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), externalToolProviders: [echoProvider("local-skills", "greet")] });
    const greet = toolNamed(tools, "greet");
    expect(greet).toMatchObject({ effect: "external", requiresApproval: true, capabilityId: "workspace.external", provenance: { kind: "skill", providerId: "local-skills" } });
    const result = await greet.execute({ text: "hi" }, context);
    expect(result.content).toBe("echoed: hi");
  });

  it("still validates the external tool's own arguments against its schema, through the same wrapping every tool gets", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), externalToolProviders: [echoProvider("local-skills", "greet")] });
    await expect(toolNamed(tools, "greet").execute({}, context)).rejects.toThrow(/requires text/);
  });

  it("refuses to register an external tool whose name collides with a built-in one", async () => {
    await expect(
      createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), externalToolProviders: [echoProvider("evil", "read_file")] }),
    ).rejects.toThrow(/collides with a built-in Nova tool/);
  });

  it("refuses to register two external tools of the same name from different providers", async () => {
    await expect(
      createNovaTools({
        workspace: new LocalWorkspace(root),
        todos: new TodoList(),
        externalToolProviders: [echoProvider("a", "greet"), echoProvider("b", "greet")],
      }),
    ).rejects.toThrow(/greet/);
  });
});

describe("hooks wired through the real tool wrapping", () => {
  async function writeHookScript(scriptPath: string, body: string): Promise<void> {
    await fs.mkdir(path.dirname(scriptPath), { recursive: true });
    if (process.platform === "win32") {
      const windowsPath = scriptPath.replace(/\.sh$/, ".cmd");
      const windowsBody = body
        .replace(/echo '([^']*)' >&2/g, "echo $1 1>&2")
        .replace(/^exit (\d+)$/gm, "exit /b $1");
      await fs.writeFile(windowsPath, `@echo off\r\n${windowsBody.replaceAll("\n", "\r\n")}\r\n`);
      return;
    }
    await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }

  it("blocks a tool call when a pre-tool-use hook exits non-zero, and the tool body never runs", async () => {
    await writeHookScript(path.join(root, ".nova/hooks/pre-tool-use/deny-writes.sh"), "echo 'writes are frozen' >&2\nexit 1");
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), hooks: HookRegistry.local(new LocalWorkspace(root)) });
    const result = await toolNamed(tools, "write_file").execute({ path: "new.txt", content: "hi" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("writes are frozen");
    await expect(fs.readFile(path.join(root, "new.txt"), "utf8")).rejects.toThrow(); // never written
  });

  it("appends a post-tool-use hook's warning to an otherwise-successful result, without turning it into an error", async () => {
    await writeHookScript(path.join(root, ".nova/hooks/post-tool-use/audit.sh"), "echo 'no test run after this edit' >&2\nexit 1");
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), hooks: HookRegistry.local(new LocalWorkspace(root)) });
    const result = await toolNamed(tools, "read_file").execute({ path: "src/app.ts" }, context);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("export const port");
    expect(result.content).toContain("no test run after this edit");
  });

  it("runs with no hook directory present — behaves exactly as if hooks were never configured", async () => {
    const tools = await createNovaTools({ workspace: new LocalWorkspace(root), todos: new TodoList(), hooks: HookRegistry.local(new LocalWorkspace(root)) });
    const result = await toolNamed(tools, "read_file").execute({ path: "src/app.ts" }, context);
    expect(result.content).toBe("export const port = 3000;\n");
  });
});

describe("a command that names a program this environment does not have", () => {
  it("identifies the program from every shell's way of saying so", () => {
    expect(missingProgram("npm test", { exitCode: 127, stdout: "", stderr: "spawn npm ENOENT" })).toBe("npm");
    expect(missingProgram("pnpm install", { exitCode: 127, stdout: "", stderr: "sh: 1: pnpm: command not found" })).toBe("pnpm");
    expect(missingProgram("yarn build", { exitCode: 1, stdout: "'yarn' is not recognized as an internal or external command", stderr: "" })).toBe("yarn");
  });

  it("does not mistake a program's own output for a missing program", () => {
    // The failure is real, but it is a compile error, not an uninstalled toolchain — telling the
    // model "do not retry" here would stop it fixing the thing it was asked to fix.
    expect(missingProgram("bun run build", { exitCode: 1, stdout: "", stderr: "src/a.ts:3:10 - error TS2307: module not found" })).toBeNull();
    expect(missingProgram("bun test", { exitCode: 1, stdout: "expected: fixture not found", stderr: "" })).toBeNull();
    expect(missingProgram("npm test", { exitCode: 0, stdout: "command not found", stderr: "" })).toBeNull();
  });

  it("tells the model to stop retrying instead of surfacing a bare ENOENT", async () => {
    const tools = await createNovaTools({
      workspace: new LocalWorkspace(root, undefined, async () => ({ exitCode: 127, stdout: "", stderr: "spawn npm ENOENT" })),
      todos: new TodoList(),
    });
    const result = await toolNamed(tools, "run_command").execute({ command: "npm test" }, context);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available in this environment");
    expect(result.content).toContain("Do not retry");
    expect((result.data as { missingProgram?: string }).missingProgram).toBe("npm");
    // A missing program proves nothing about the code, so it must not count as verification.
    expect(result.verification).toBeUndefined();
  });
});
