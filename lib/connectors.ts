export type ConnectorDomain = "calendar" | "email" | "tasks" | "files" | "notes" | "messaging" | "contacts" | "home";
export type ConnectorPermission = "read" | "draft" | "execute";
export type ConnectorRisk = "read" | "write" | "send" | "control" | "purchase" | "delete";
export type ConnectorAuth = "oauth2" | "api_key" | "webhook" | "mcp";
export type ConnectionStatus = "pending" | "connected" | "degraded" | "revoked" | "expired";

export type ConnectorAction = {
  id: string;
  label: string;
  permission: ConnectorPermission;
  risk: ConnectorRisk;
  description: string;
  idempotent: boolean;
  requiresApproval: boolean;
};

export type ConnectorManifest = {
  id: string;
  appName: string;
  description: string;
  domains: ConnectorDomain[];
  auth: ConnectorAuth;
  actions: ConnectorAction[];
};

export type ConnectionGrant = {
  connectorId: string;
  status: ConnectionStatus;
  permissions: ConnectorPermission[];
  credentialReference: string;
  externalAccountLabel?: string;
  expiresAt?: number;
};

const manifests: ConnectorManifest[] = [
  {
    id: "google-calendar",
    appName: "Google Calendar",
    description: "Understand availability and coordinate calendar events.",
    domains: ["calendar", "contacts"],
    auth: "oauth2",
    actions: [
      action("events.list", "Read events", "read", "read", true),
      action("events.propose", "Draft an event", "draft", "write", true),
      action("events.create", "Create an event", "execute", "write", false),
      action("events.update", "Update an event", "execute", "write", false),
      action("events.delete", "Delete an event", "execute", "delete", false),
    ],
  },
  {
    id: "gmail",
    appName: "Gmail",
    description: "Triage mail, prepare replies, and send only with approval.",
    domains: ["email", "contacts"],
    auth: "oauth2",
    actions: [
      action("messages.list", "Read messages", "read", "read", true),
      action("drafts.create", "Create a draft", "draft", "write", true),
      action("messages.send", "Send a message", "execute", "send", false),
    ],
  },
  {
    id: "google-drive",
    appName: "Google Drive",
    description: "Find files and prepare task-scoped documents.",
    domains: ["files"],
    auth: "oauth2",
    actions: [
      action("files.search", "Search files", "read", "read", true),
      action("files.create", "Create a file", "draft", "write", true),
      action("files.share", "Share a file", "execute", "send", false),
    ],
  },
  {
    id: "notion",
    appName: "Notion",
    description: "Read workspaces and prepare or publish structured notes.",
    domains: ["notes", "tasks"],
    auth: "oauth2",
    actions: [
      action("pages.search", "Search pages", "read", "read", true),
      action("pages.create", "Create a page", "draft", "write", true),
      action("pages.update", "Update a page", "execute", "write", false),
    ],
  },
  {
    id: "todoist",
    appName: "Todoist",
    description: "Read, prepare, and complete personal or team tasks.",
    domains: ["tasks"],
    auth: "oauth2",
    actions: [
      action("tasks.list", "Read tasks", "read", "read", true),
      action("tasks.create", "Create a task", "draft", "write", true),
      action("tasks.complete", "Complete a task", "execute", "write", false),
    ],
  },
  {
    id: "slack",
    appName: "Slack",
    description: "Summarize channels, prepare updates, and send approved messages.",
    domains: ["messaging"],
    auth: "oauth2",
    actions: [
      action("messages.list", "Read messages", "read", "read", true),
      action("messages.compose", "Compose a message", "draft", "write", true),
      action("messages.send", "Send a message", "execute", "send", false),
    ],
  },
  {
    id: "whatsapp-business",
    appName: "WhatsApp Business",
    description: "Prepare and send approved customer conversations.",
    domains: ["messaging", "contacts"],
    auth: "webhook",
    actions: [
      action("messages.list", "Read conversations", "read", "read", true),
      action("messages.compose", "Compose a reply", "draft", "write", true),
      action("messages.send", "Send a reply", "execute", "send", false),
    ],
  },
  {
    id: "home-assistant",
    appName: "Home Assistant",
    description: "Read device state and request approved home controls.",
    domains: ["home"],
    auth: "api_key",
    actions: [
      action("state.read", "Read device state", "read", "read", true),
      action("service.call", "Control a device", "execute", "control", false),
    ],
  },
];

function action(id: string, label: string, permission: ConnectorPermission, risk: ConnectorRisk, idempotent: boolean): ConnectorAction {
  return {
    id,
    label,
    permission,
    risk,
    description: `${label} through the connected provider account.`,
    idempotent,
    requiresApproval: risk !== "read",
  };
}

const permissionRank: Record<ConnectorPermission, number> = { read: 0, draft: 1, execute: 2 };

export class ConnectorRegistry {
  private readonly entries: Map<string, ConnectorManifest>;

  constructor(entries: ConnectorManifest[]) {
    const issues = validateConnectorManifests(entries);
    if (issues.length > 0) throw new Error(`Invalid connector registry: ${issues.join("; ")}`);
    this.entries = new Map(entries.map((entry) => [entry.id, Object.freeze({ ...entry })]));
  }

  list(): ConnectorManifest[] { return [...this.entries.values()]; }
  get(id: string): ConnectorManifest | undefined { return this.entries.get(id); }

  action(connectorId: string, actionId: string): ConnectorAction {
    const connector = this.entries.get(connectorId);
    if (!connector) throw new Error(`Unknown connector: ${connectorId}`);
    const selected = connector.actions.find((candidate) => candidate.id === actionId);
    if (!selected) throw new Error(`Unknown action ${actionId} for ${connectorId}`);
    return selected;
  }
}

export function validateConnectorManifests(entries: ConnectorManifest[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const connector of entries) {
    if (!/^[a-z][a-z0-9-]+$/.test(connector.id)) issues.push(`invalid connector id ${connector.id}`);
    if (ids.has(connector.id)) issues.push(`duplicate connector id ${connector.id}`);
    ids.add(connector.id);
    if (!connector.appName.trim() || !connector.description.trim()) issues.push(`connector ${connector.id} needs a name and description`);
    if (connector.domains.length === 0 || connector.actions.length === 0) issues.push(`connector ${connector.id} must expose domains and actions`);
    const actionIds = new Set<string>();
    for (const candidate of connector.actions) {
      if (actionIds.has(candidate.id)) issues.push(`duplicate action ${connector.id}.${candidate.id}`);
      actionIds.add(candidate.id);
      if (candidate.risk !== "read" && !candidate.requiresApproval) issues.push(`external action ${connector.id}.${candidate.id} must require approval`);
      if (candidate.risk === "read" && candidate.permission !== "read") issues.push(`read action ${connector.id}.${candidate.id} must use read permission`);
      if (["send", "control", "purchase", "delete"].includes(candidate.risk) && candidate.permission !== "execute") issues.push(`high-impact action ${connector.id}.${candidate.id} must use execute permission`);
    }
  }
  return issues;
}

export function authorizeConnectorAction(input: {
  grant: ConnectionGrant | undefined;
  connectorId: string;
  actionId: string;
  approved: boolean;
  now?: number;
}): ConnectorAction {
  const selected = connectorRegistry.action(input.connectorId, input.actionId);
  const grant = input.grant;
  if (!grant || grant.connectorId !== input.connectorId || grant.status !== "connected") throw new Error(`${input.connectorId} is not connected`);
  if (!grant.credentialReference.startsWith("vault://")) throw new Error("Connection credential must be an opaque vault reference");
  if (grant.expiresAt !== undefined && grant.expiresAt <= (input.now ?? Date.now())) throw new Error(`${input.connectorId} connection has expired`);
  const permitted = grant.permissions.some((permission) => permissionRank[permission] >= permissionRank[selected.permission]);
  if (!permitted) throw new Error(`${input.connectorId} connection lacks ${selected.permission} permission`);
  if (selected.requiresApproval && !input.approved) throw new Error(`${input.connectorId}.${input.actionId} requires approval`);
  return selected;
}

export const connectorRegistry = new ConnectorRegistry(manifests);
