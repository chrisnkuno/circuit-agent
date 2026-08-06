import { describe, expect, it } from "vitest";
import { e2bSignature, isSandboxTerminated, parseE2BLifecycleEvent, verifyE2BSignature } from "./e2b-webhook";

// Shaped exactly like the documented v2 payload.
const killedBody = JSON.stringify({
  id: "evt_1",
  version: "v2",
  type: "sandbox.lifecycle.killed",
  timestamp: "2026-08-06T20:59:24Z",
  event_category: "lifecycle",
  event_label: "killed",
  event_data: {
    sandbox_metadata: {},
    execution: { started_at: "2026-08-06T20:58:24Z", vcpu_count: 2, memory_mb: 512, execution_time: 1000 },
  },
  sandbox_id: "sb_abc123",
  sandbox_execution_id: "exec_1",
  sandbox_template_id: "base",
  sandbox_build_id: "build_1",
  sandbox_team_id: "team_1",
});

describe("e2b webhook signature", () => {
  const secret = "whsec_test";

  it("accepts a signature computed the way E2B documents it", async () => {
    expect(await verifyE2BSignature(secret, killedBody, await e2bSignature(secret, killedBody))).toBe(true);
  });

  it("produces base64 with the trailing padding stripped", async () => {
    expect(await e2bSignature(secret, killedBody)).not.toMatch(/=$/);
  });

  it("rejects a body that was altered after signing", async () => {
    const signature = await e2bSignature(secret, killedBody);
    expect(await verifyE2BSignature(secret, `${killedBody} `, signature)).toBe(false);
  });

  it("rejects a signature made with a different secret", async () => {
    expect(await verifyE2BSignature(secret, killedBody, await e2bSignature("whsec_other", killedBody))).toBe(false);
  });

  it("rejects a missing signature or an unconfigured secret rather than defaulting open", async () => {
    expect(await verifyE2BSignature(secret, killedBody, null)).toBe(false);
    expect(await verifyE2BSignature("", killedBody, await e2bSignature("", killedBody))).toBe(false);
  });

  it("rejects a wrong-length signature without throwing", async () => {
    await expect(verifyE2BSignature(secret, killedBody, "short")).resolves.toBe(false);
  });
});

describe("e2b lifecycle payload", () => {
  it("extracts the sandbox and event identity", () => {
    const event = parseE2BLifecycleEvent(killedBody);
    expect(event).toMatchObject({ id: "evt_1", type: "sandbox.lifecycle.killed", sandboxId: "sb_abc123", executionTimeMs: 1000 });
  });

  it("ignores an unknown or future event type instead of guessing", () => {
    expect(parseE2BLifecycleEvent(JSON.stringify({ id: "e", type: "sandbox.lifecycle.teleported", sandbox_id: "sb_1" }))).toBeNull();
  });

  it("ignores a payload with no sandbox to act on", () => {
    expect(parseE2BLifecycleEvent(JSON.stringify({ id: "e", type: "sandbox.lifecycle.killed" }))).toBeNull();
    expect(parseE2BLifecycleEvent("not json")).toBeNull();
  });

  it("omits execution time on events that do not carry it", () => {
    const created = JSON.stringify({ id: "e", type: "sandbox.lifecycle.created", sandbox_id: "sb_1" });
    expect(parseE2BLifecycleEvent(created)?.executionTimeMs).toBeUndefined();
  });

  it("treats only a kill as the end of a sandbox", () => {
    // A paused or checkpointed sandbox can be resumed; failing a step for one would be wrong.
    const of = (type: string) => parseE2BLifecycleEvent(JSON.stringify({ id: "e", type, sandbox_id: "sb_1" }))!;
    expect(isSandboxTerminated(of("sandbox.lifecycle.killed"))).toBe(true);
    expect(isSandboxTerminated(of("sandbox.lifecycle.paused"))).toBe(false);
    expect(isSandboxTerminated(of("sandbox.lifecycle.checkpointed"))).toBe(false);
    expect(isSandboxTerminated(of("sandbox.lifecycle.created"))).toBe(false);
  });
});
