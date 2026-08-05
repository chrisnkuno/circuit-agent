import { connectorRegistry, type ConnectorPermission, type ConnectorRisk } from "./connectors";

export type ActionIntentStatus = "proposed" | "awaiting_approval" | "approved" | "executing" | "completed" | "failed" | "cancelled";

export type AppActionIntent = {
  key: string;
  connectorId: string;
  actionId: string;
  title: string;
  inputSummary: string;
  dependsOn: string[];
  permission: ConnectorPermission;
  risk: ConnectorRisk;
  requiresApproval: boolean;
  status: ActionIntentStatus;
  idempotencyKey: string;
};

export type MultiAppWorkflow = {
  id: string;
  title: string;
  description: string;
  intents: AppActionIntent[];
};

export type WorkflowTemplate = "meeting-follow-up" | "inbox-to-plan" | "project-update" | "evening-routine";

type IntentInput = Pick<AppActionIntent, "key" | "connectorId" | "actionId" | "title" | "inputSummary" | "dependsOn">;

function intent(workflowId: string, input: IntentInput): AppActionIntent {
  const action = connectorRegistry.action(input.connectorId, input.actionId);
  return {
    ...input,
    permission: action.permission,
    risk: action.risk,
    requiresApproval: action.requiresApproval,
    status: action.requiresApproval ? "awaiting_approval" : "proposed",
    idempotencyKey: `${workflowId}:${input.key}`,
  };
}

export function buildMultiAppWorkflow(template: WorkflowTemplate, workflowId: string): MultiAppWorkflow {
  const templates: Record<WorkflowTemplate, Omit<MultiAppWorkflow, "id" | "intents"> & { intents: IntentInput[] }> = {
    "meeting-follow-up": {
      title: "Meeting follow-up",
      description: "Review the meeting, prepare follow-up, and turn commitments into tasks.",
      intents: [
        { key: "calendar", connectorId: "google-calendar", actionId: "events.list", title: "Read meeting context", inputSummary: "The relevant meeting window only", dependsOn: [] },
        { key: "draft", connectorId: "gmail", actionId: "drafts.create", title: "Prepare follow-up email", inputSummary: "Draft recipients, summary, and agreed next steps", dependsOn: ["calendar"] },
        { key: "tasks", connectorId: "todoist", actionId: "tasks.create", title: "Prepare action items", inputSummary: "Create tasks from explicit commitments", dependsOn: ["calendar"] },
        { key: "send", connectorId: "gmail", actionId: "messages.send", title: "Send approved follow-up", inputSummary: "Send the reviewed draft", dependsOn: ["draft", "tasks"] },
      ],
    },
    "inbox-to-plan": {
      title: "Inbox to daily plan",
      description: "Triage important mail and prepare a focused task plan.",
      intents: [
        { key: "inbox", connectorId: "gmail", actionId: "messages.list", title: "Read priority mail", inputSummary: "Unread and starred messages in the requested time range", dependsOn: [] },
        { key: "calendar", connectorId: "google-calendar", actionId: "events.list", title: "Check available time", inputSummary: "Today's availability", dependsOn: [] },
        { key: "tasks", connectorId: "todoist", actionId: "tasks.create", title: "Prepare daily tasks", inputSummary: "Tasks grounded in messages and free time", dependsOn: ["inbox", "calendar"] },
      ],
    },
    "project-update": {
      title: "Project status update",
      description: "Gather project context and prepare a team update.",
      intents: [
        { key: "notes", connectorId: "notion", actionId: "pages.search", title: "Read project notes", inputSummary: "Pages scoped to the selected project", dependsOn: [] },
        { key: "files", connectorId: "google-drive", actionId: "files.search", title: "Find recent artifacts", inputSummary: "Recent files scoped to the selected project", dependsOn: [] },
        { key: "compose", connectorId: "slack", actionId: "messages.compose", title: "Prepare status update", inputSummary: "Progress, decisions, risks, and next steps", dependsOn: ["notes", "files"] },
        { key: "send", connectorId: "slack", actionId: "messages.send", title: "Post approved update", inputSummary: "Post the reviewed status update", dependsOn: ["compose"] },
      ],
    },
    "evening-routine": {
      title: "Evening routine",
      description: "Review tomorrow and request a home routine without silent device control.",
      intents: [
        { key: "tomorrow", connectorId: "google-calendar", actionId: "events.list", title: "Read tomorrow's schedule", inputSummary: "Tomorrow's events", dependsOn: [] },
        { key: "home", connectorId: "home-assistant", actionId: "state.read", title: "Read home state", inputSummary: "Only devices included in the selected routine", dependsOn: [] },
        { key: "routine", connectorId: "home-assistant", actionId: "service.call", title: "Run approved routine", inputSummary: "Apply the reviewed evening scene", dependsOn: ["tomorrow", "home"] },
      ],
    },
  };
  const selected = templates[template];
  const workflow = { id: workflowId, title: selected.title, description: selected.description, intents: selected.intents.map((item) => intent(workflowId, item)) };
  const issues = validateMultiAppWorkflow(workflow);
  if (issues.length > 0) throw new Error(`Invalid multi-app workflow: ${issues.join("; ")}`);
  return workflow;
}

export function validateMultiAppWorkflow(workflow: MultiAppWorkflow): string[] {
  const issues: string[] = [];
  const keys = new Set(workflow.intents.map((item) => item.key));
  if (keys.size !== workflow.intents.length) issues.push("intent keys must be unique");
  for (const item of workflow.intents) {
    if (item.dependsOn.includes(item.key)) issues.push(`${item.key} cannot depend on itself`);
    for (const dependency of item.dependsOn) if (!keys.has(dependency)) issues.push(`${item.key} has unknown dependency ${dependency}`);
    const action = connectorRegistry.action(item.connectorId, item.actionId);
    if (item.permission !== action.permission || item.risk !== action.risk || item.requiresApproval !== action.requiresApproval) issues.push(`${item.key} does not match its connector action`);
    if (item.requiresApproval && !["awaiting_approval", "approved", "executing", "completed", "failed", "cancelled"].includes(item.status)) issues.push(`${item.key} bypasses approval`);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byKey = new Map(workflow.intents.map((item) => [item.key, item]));
  function visit(key: string): boolean {
    if (visiting.has(key)) return true;
    if (visited.has(key)) return false;
    visiting.add(key);
    const cycle = (byKey.get(key)?.dependsOn ?? []).some(visit);
    visiting.delete(key);
    visited.add(key);
    return cycle;
  }
  if (workflow.intents.some((item) => visit(item.key))) issues.push("intent graph contains a cycle");
  return issues;
}

export function readyIntents(workflow: MultiAppWorkflow): AppActionIntent[] {
  const completed = new Set(workflow.intents.filter((item) => item.status === "completed").map((item) => item.key));
  return workflow.intents.filter((item) => {
    if (item.status !== "proposed" && item.status !== "approved") return false;
    return item.dependsOn.every((dependency) => completed.has(dependency));
  });
}
