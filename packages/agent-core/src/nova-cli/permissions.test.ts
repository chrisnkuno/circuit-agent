import { describe, expect, it } from "vitest";
import type { AgentTool, AgentToolCall } from "../agent-runtime";
import { actionDigest, capabilitiesForMode, describeToolCall, NOVA_CAPABILITIES, PermissionLedger, type PermissionDecision } from "./permissions";

function tool(overrides: Partial<AgentTool> & { name: string }): AgentTool {
  return {
    description: "",
    inputSchema: {},
    capabilityId: NOVA_CAPABILITIES.write,
    effect: "workspace",
    requiresApproval: true,
    parallelSafe: false,
    execute: async () => ({ content: "" }),
    ...overrides,
  };
}

const call = (name: string, args: Record<string, unknown> = {}): AgentToolCall => ({ id: "call_1", name, arguments: args });

describe("mode capabilities", () => {
  it("gives plan mode no way to change anything, and build mode the full set", () => {
    const plan = capabilitiesForMode("plan");
    expect(plan).toContain(NOVA_CAPABILITIES.read);
    expect(plan).toContain(NOVA_CAPABILITIES.research);
    // The guarantee behind Plan mode: the write and terminal tools are never even offered.
    expect(plan).not.toContain(NOVA_CAPABILITIES.write);
    expect(plan).not.toContain(NOVA_CAPABILITIES.terminal);

    expect(capabilitiesForMode("build")).toContain(NOVA_CAPABILITIES.write);
    expect(capabilitiesForMode("build")).toContain(NOVA_CAPABILITIES.terminal);
  });
});

describe("permission ledger", () => {
  it("never asks about tools that change nothing", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("build", async () => { asked += 1; return "allow"; });
    await expect(ledger.isApproved(call("read_file"), tool({ name: "read_file", effect: "none", requiresApproval: false }))).resolves.toBe(true);
    expect(asked).toBe(0);
  });

  it("remembers 'always' only for the exact action digest", async () => {
    const asked: string[] = [];
    const ledger = new PermissionLedger("build", async (request) => { asked.push(request.tool.name); return "allow_always"; });

    await ledger.isApproved(call("edit_file", { path: "a.ts" }), tool({ name: "edit_file" }));
    await ledger.isApproved(call("edit_file", { path: "a.ts" }), tool({ name: "edit_file" }));
    await ledger.isApproved(call("edit_file", { path: "b.ts" }), tool({ name: "edit_file" }));
    expect(asked).toEqual(["edit_file", "edit_file"]);
    expect(Object.keys(ledger.snapshot())).toHaveLength(2);
    expect(Object.keys(ledger.snapshot()).every((key) => key.startsWith("nova-approval-v1:"))).toBe(true);
  });

  it("keeps a standing 'always allow' scoped to the one tool it was given for", async () => {
    const asked: string[] = [];
    const ledger = new PermissionLedger("build", async (request) => {
      asked.push(request.tool.name);
      return request.tool.name === "edit_file" ? "allow_always" : "deny";
    });

    await ledger.isApproved(call("edit_file"), tool({ name: "edit_file" }));
    const command = await ledger.isApproved(call("run_command"), tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.terminal }));
    expect(command).toBe(false);
    expect(asked).toEqual(["edit_file", "run_command"]);
  });

  it("remembers a refusal so the agent cannot wear the user down", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("build", async () => { asked += 1; return "deny_always"; });
    expect(await ledger.isApproved(call("run_command"), tool({ name: "run_command" }))).toBe(false);
    expect(await ledger.isApproved(call("run_command"), tool({ name: "run_command" }))).toBe(false);
    expect(asked).toBe(1);
  });

  it("pre-approves workspace edits in auto mode but still gates external actions", async () => {
    const asked: string[] = [];
    const ledger = new PermissionLedger("auto", async (request) => { asked.push(request.tool.name); return "allow"; });

    expect(await ledger.isApproved(call("edit_file"), tool({ name: "edit_file", effect: "workspace" }))).toBe(true);
    expect(asked).toEqual([]);

    // Nothing a checkpoint can undo, so it stays a human decision even here.
    expect(await ledger.isApproved(call("open_pull_request"), tool({ name: "open_pull_request", effect: "external" }))).toBe(true);
    expect(asked).toEqual(["open_pull_request"]);
  });

  it("does not auto-approve sensitive workspace paths or high-impact commands", async () => {
    const asked: string[] = [];
    const ledger = new PermissionLedger("auto", async (request) => {
      asked.push(`${request.tool.name}:${request.safety.reasons.join(",")}`);
      return "allow";
    });

    await expect(ledger.isApproved(call("write_file", { path: ".env", content: "SAFE=value" }), tool({ name: "write_file" }))).resolves.toBe(true);
    await expect(ledger.isApproved(call("run_command", { command: "git push origin main" }), tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.terminal }))).resolves.toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked[0]).toContain("credential");
    expect(asked[1]).toContain("publication");
  });

  it("keeps ordinary auto-mode edits on the no-prompt fast path", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("auto", async () => { asked += 1; return "deny"; });
    await expect(ledger.isApproved(call("write_file", { path: "src/app.ts", content: "export const ok = true;" }), tool({ name: "write_file" }))).resolves.toBe(true);
    await expect(ledger.isApproved(call("run_command", { command: "npm test" }), tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.terminal }))).resolves.toBe(true);
    expect(asked).toBe(0);
  });

  it("restores standing decisions when a session resumes", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("build", async () => { asked += 1; return "allow"; });
    const edit = call("edit_file", { path: "a.ts" });
    const editTool = tool({ name: "edit_file" });
    const key = `nova-approval-v1:${actionDigest(edit, editTool)}`;
    ledger.restore({ [key]: "allow", run_command: "deny" });

    expect(await ledger.isApproved(edit, editTool)).toBe(true);
    expect(await ledger.isApproved(call("run_command"), tool({ name: "run_command" }))).toBe(false);
    expect(asked).toBe(0);
  });

  it("does not migrate a legacy broad allow across arbitrary arguments", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("build", async () => { asked += 1; return "deny"; });
    ledger.restore({ run_command: "allow" });
    expect(await ledger.isApproved(call("run_command", { command: "curl secret.example" }), tool({ name: "run_command" }))).toBe(false);
    expect(asked).toBe(1);
  });

  it("generates the same digest regardless of object key order and a new digest for a new command", () => {
    const commandTool = tool({ name: "run_command", capabilityId: NOVA_CAPABILITIES.terminal });
    const first = actionDigest(call("run_command", { command: "bun test", timeoutMs: 1000 }), commandTool);
    const reordered = actionDigest(call("run_command", { timeoutMs: 1000, command: "bun test" }), commandTool);
    const changed = actionDigest(call("run_command", { command: "bun run build", timeoutMs: 1000 }), commandTool);
    expect(first).toBe(reordered);
    expect(changed).not.toBe(first);
  });

  it("treats an unrecognised answer as refusal, so a stray keypress never approves a write", async () => {
    const decisions: PermissionDecision[] = ["deny"];
    const ledger = new PermissionLedger("build", async () => decisions[0]);
    expect(await ledger.isApproved(call("write_file"), tool({ name: "write_file" }))).toBe(false);
  });
});

describe("describeToolCall", () => {
  it("says what will happen in words a person can act on", () => {
    expect(describeToolCall(call("write_file", { path: "src/app.ts" }), tool({ name: "write_file" }))).toBe("write src/app.ts");
    expect(describeToolCall(call("edit_file", { path: "src/app.ts" }), tool({ name: "edit_file" }))).toBe("edit src/app.ts");
    expect(describeToolCall(call("run_command", { command: "npm test" }), tool({ name: "run_command" }))).toBe("run npm test");
  });
});
