import { describe, expect, it } from "vitest";
import { authorizeConnectorAction, ConnectorRegistry, connectorRegistry, type ConnectionGrant, type ConnectorManifest } from "./connectors";

const gmailGrant: ConnectionGrant = {
  connectorId: "gmail",
  status: "connected",
  permissions: ["read", "draft", "execute"],
  credentialReference: "vault://connections/gmail/account-1",
};

describe("connector registry", () => {
  it("models common daily apps without claiming any account is connected", () => {
    expect(connectorRegistry.list().map((item) => item.appName)).toEqual(expect.arrayContaining([
      "Google Calendar", "Gmail", "Google Drive", "Notion", "Todoist", "Slack", "WhatsApp Business", "Home Assistant",
    ]));
    expect(connectorRegistry.list().every((item) => item.actions.length > 0)).toBe(true);
  });

  it("allows a connected read but gates external writes", () => {
    expect(authorizeConnectorAction({ grant: gmailGrant, connectorId: "gmail", actionId: "messages.list", approved: false }).risk).toBe("read");
    expect(() => authorizeConnectorAction({ grant: gmailGrant, connectorId: "gmail", actionId: "messages.send", approved: false })).toThrow("requires approval");
    expect(authorizeConnectorAction({ grant: gmailGrant, connectorId: "gmail", actionId: "messages.send", approved: true }).risk).toBe("send");
  });

  it("fails closed for missing, expired, under-scoped, or raw credentials", () => {
    expect(() => authorizeConnectorAction({ grant: undefined, connectorId: "gmail", actionId: "messages.list", approved: false })).toThrow("not connected");
    expect(() => authorizeConnectorAction({ grant: { ...gmailGrant, expiresAt: 9 }, connectorId: "gmail", actionId: "messages.list", approved: false, now: 10 })).toThrow("expired");
    expect(() => authorizeConnectorAction({ grant: { ...gmailGrant, permissions: ["read"] }, connectorId: "gmail", actionId: "drafts.create", approved: true })).toThrow("lacks draft");
    expect(() => authorizeConnectorAction({ grant: { ...gmailGrant, credentialReference: "oauth-access-token" }, connectorId: "gmail", actionId: "messages.list", approved: false })).toThrow("opaque vault reference");
  });

  it("rejects a manifest that downscopes a high-impact action", () => {
    const unsafe: ConnectorManifest = {
      id: "unsafe-app",
      appName: "Unsafe",
      description: "Unsafe test connector.",
      domains: ["messaging"],
      auth: "oauth2",
      actions: [{ id: "send", label: "Send", description: "Send", permission: "draft", risk: "send", idempotent: false, requiresApproval: false }],
    };
    expect(() => new ConnectorRegistry([unsafe])).toThrow("must require approval");
  });
});
