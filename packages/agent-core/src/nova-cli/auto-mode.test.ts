import { describe, expect, it } from "vitest";
import type { AgentTool } from "../agent-runtime";
import { PermissionLedger, NOVA_CAPABILITIES, capabilitiesForMode } from "./permissions";

/**
 * What auto mode actually approves.
 *
 * Auto mode is the one people leave running, so its boundary has to be stated rather than assumed:
 * it exists to stop the agent asking permission for each of forty ordinary file writes, and it must
 * *not* quietly become "approve everything". The distinction it draws is between changing the
 * workspace — which a checkpoint can undo — and reaching outside it, which nothing can.
 *
 * Tested through `PermissionLedger` rather than through a live session because the ledger is where
 * the decision is made; a session test would exercise the same branch through several layers of
 * setup and prove less about it.
 */

const tool = (over: Partial<AgentTool> & { name: string }): AgentTool => ({
  description: over.name,
  inputSchema: { type: "object" },
  capabilityId: NOVA_CAPABILITIES.write,
  effect: "workspace",
  requiresApproval: true,
  parallelSafe: false,
  execute: async () => ({ content: "" }),
  ...over,
} as AgentTool);

/** A prompt that fails the test if it is ever reached — auto mode must not consult a human here. */
const neverAsk = async () => {
  throw new Error("auto mode asked for approval when it should not have");
};

const call = (args: Record<string, unknown> = {}) => ({ id: "c1", name: "t", arguments: args });

describe("auto mode", () => {
  it("approves ordinary workspace changes without asking", async () => {
    const ledger = new PermissionLedger("auto", neverAsk);
    for (const name of ["write_file", "edit_file", "run_command", "remember"]) {
      expect(await ledger.decide(call({ path: "src/app.ts", content: "x" }), tool({ name })), name).toBe("approved");
    }
  });

  it("approves read-only tools in every mode, since they change nothing", async () => {
    for (const mode of ["plan", "build", "auto", "defender"] as const) {
      const ledger = new PermissionLedger(mode, neverAsk);
      expect(await ledger.decide(call(), tool({ name: "read_file", effect: "none", requiresApproval: false })), mode).toBe("approved");
    }
  });

  /**
   * The boundary that makes auto mode safe to leave on. An external effect reaches outside the
   * workspace — publishing, deploying, calling someone else's API — and no checkpoint undoes that,
   * so it is asked about however convenient the mode is meant to be.
   */
  it("still asks before anything that reaches outside the workspace", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("auto", async () => { asked += 1; return "allow"; });
    expect(await ledger.decide(call({ action: "deploy" }), tool({ name: "deploy_app", effect: "external" }))).toBe("approved");
    expect(asked).toBe(1);
  });

  /**
   * Auto mode is an ergonomics feature, not a blanket trust grant. A command that deletes a tree or
   * changes or transmits credentials is exactly the one a person wants to see, and is also exactly
   * the one that arrives buried in a batch of forty routine writes.
   */
  it("still asks before a destructive, credential-changing, or publishing command", async () => {
    const asked: string[] = [];
    const ledger = new PermissionLedger("auto", async (request) => { asked.push(request.summary); return "deny"; });
    for (const command of ["rm -rf build", "git reset --hard", "export API_TOKEN=secret", "npm publish"]) {
      expect(await ledger.decide(call({ command }), tool({ name: "run_command" })), command).toBe("denied");
    }
    expect(asked).toHaveLength(4);
  });

  it("allows contained local credential reads without approval", async () => {
    const ledger = new PermissionLedger("auto", neverAsk);
    for (const command of ["cat .env", "type .env.local", "printenv MY_PROJECT_TOKEN"]) {
      expect(await ledger.decide(call({ command }), tool({ name: "run_command" })), command).toBe("approved");
    }
  });

  it("asks before writing to a credential file, whatever the mode is set to", async () => {
    let asked = 0;
    const ledger = new PermissionLedger("auto", async () => { asked += 1; return "allow"; });
    await ledger.decide(call({ path: ".env", content: "KEY=1" }), tool({ name: "write_file" }));
    expect(asked).toBe(1);
  });

  it("does not auto-approve in the modes that are meant to ask", async () => {
    for (const mode of ["build", "defender"] as const) {
      let asked = 0;
      const ledger = new PermissionLedger(mode, async () => { asked += 1; return "allow"; });
      await ledger.decide(call({ path: "src/app.ts" }), tool({ name: "write_file" }));
      expect(asked, mode).toBe(1);
    }
  });

  it("gives auto mode the tools to actually work with", () => {
    // A mode that auto-approves writes but cannot call the write tools would be worse than useless.
    const auto = capabilitiesForMode("auto");
    // Every working capability, which is all of them except the defender-only playbook retrieval:
    // auto mode has no security review to run and no reason to carry that tool's schema.
    const working = Object.values(NOVA_CAPABILITIES).filter((capability) => capability !== NOVA_CAPABILITIES.playbooks);
    for (const capability of working) expect(auto).toContain(capability);
    // Plan mode is the opposite end and must stay that way: it changes nothing, so it holds neither
    // the write nor the terminal capability.
    const plan = capabilitiesForMode("plan");
    expect(plan).not.toContain(NOVA_CAPABILITIES.write);
    expect(plan).not.toContain(NOVA_CAPABILITIES.terminal);
  });
});
