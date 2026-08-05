import type { TaskKind } from "./task-cost";

export type CapabilityLayer = "core" | "skill" | "connector";
export type CapabilityRisk = "observe" | "modify_workspace" | "external_action";
export type CapabilityRuntime = "model" | "coding" | "browser" | "data" | "external";

export type CapabilityManifest = {
  id: string;
  label: string;
  description: string;
  layer: CapabilityLayer;
  taskKinds: TaskKind[];
  runtime: CapabilityRuntime;
  risk: CapabilityRisk;
  defaultFor: TaskKind[];
  requiresApproval: boolean;
  requiredConfiguration: string[];
};

export type CapabilityAvailability = {
  capability: CapabilityManifest;
  available: boolean;
  missingConfiguration: string[];
};

const manifests: CapabilityManifest[] = [
  {
    id: "reasoning.plan",
    label: "Task planning",
    description: "Decompose a goal into bounded, auditable steps.",
    layer: "core",
    taskKinds: ["coding", "research", "writing", "operations"],
    runtime: "model",
    risk: "observe",
    defaultFor: ["coding", "research", "writing", "operations"],
    requiresApproval: false,
    requiredConfiguration: [],
  },
  {
    id: "workspace.files",
    label: "Workspace files",
    description: "Read and write task-scoped artifacts in an isolated workspace.",
    layer: "core",
    taskKinds: ["coding", "research", "writing"],
    runtime: "data",
    risk: "modify_workspace",
    defaultFor: ["coding", "writing"],
    requiresApproval: false,
    requiredConfiguration: ["E2B_API_KEY", "E2B_CODING_TEMPLATE"],
  },
  {
    id: "workspace.terminal",
    label: "Bounded terminal",
    description: "Run allowlisted argv commands with workspace confinement.",
    layer: "core",
    taskKinds: ["coding"],
    runtime: "coding",
    risk: "modify_workspace",
    defaultFor: ["coding"],
    requiresApproval: false,
    requiredConfiguration: ["E2B_API_KEY", "E2B_CODING_TEMPLATE"],
  },
  {
    id: "web.research",
    label: "Web research",
    description: "Gather source-backed information through an isolated browser runtime.",
    layer: "skill",
    taskKinds: ["coding", "research", "writing", "operations"],
    runtime: "browser",
    risk: "observe",
    defaultFor: ["research"],
    requiresApproval: false,
    requiredConfiguration: ["E2B_API_KEY", "E2B_BROWSER_TEMPLATE"],
  },
  {
    id: "document.compose",
    label: "Document composition",
    description: "Draft, revise, and package a structured deliverable.",
    layer: "skill",
    taskKinds: ["research", "writing"],
    runtime: "data",
    risk: "modify_workspace",
    defaultFor: ["research", "writing"],
    requiresApproval: false,
    requiredConfiguration: ["E2B_API_KEY", "E2B_DATA_TEMPLATE"],
  },
  {
    id: "operations.execute",
    label: "External operations",
    description: "Execute a connector action only after an explicit approval checkpoint.",
    layer: "connector",
    taskKinds: ["operations"],
    runtime: "external",
    risk: "external_action",
    defaultFor: ["operations"],
    requiresApproval: true,
    requiredConfiguration: ["CONNECTOR_RUNTIME_URL", "CONNECTOR_RUNTIME_TOKEN"],
  },
];

export class CapabilityRegistry {
  private readonly entries: Map<string, CapabilityManifest>;

  constructor(entries: CapabilityManifest[]) {
    const issues = validateCapabilityManifests(entries);
    if (issues.length > 0) throw new Error(`Invalid capability registry: ${issues.join("; ")}`);
    this.entries = new Map(entries.map((entry) => [entry.id, Object.freeze({ ...entry })]));
  }

  list(taskKind?: TaskKind): CapabilityManifest[] {
    return [...this.entries.values()].filter((entry) => !taskKind || entry.taskKinds.includes(taskKind));
  }

  get(id: string): CapabilityManifest | undefined {
    return this.entries.get(id);
  }

  defaultsFor(taskKind: TaskKind): CapabilityManifest[] {
    return this.list(taskKind).filter((entry) => entry.defaultFor.includes(taskKind));
  }

  resolve(taskKind: TaskKind, requestedIds: string[] = []): CapabilityManifest[] {
    const selected = new Map(this.defaultsFor(taskKind).map((entry) => [entry.id, entry]));
    for (const id of requestedIds) {
      const entry = this.entries.get(id);
      if (!entry) throw new Error(`Unknown capability: ${id}`);
      if (!entry.taskKinds.includes(taskKind)) throw new Error(`Capability ${id} does not support ${taskKind} tasks`);
      selected.set(id, entry);
    }
    return [...selected.values()];
  }

  availability(taskKind: TaskKind, configuredNames: Iterable<string>, requestedIds: string[] = []): CapabilityAvailability[] {
    const configured = new Set(configuredNames);
    return this.resolve(taskKind, requestedIds).map((capability) => {
      const missingConfiguration = capability.requiredConfiguration.filter((name) => !configured.has(name));
      return { capability, available: missingConfiguration.length === 0, missingConfiguration };
    });
  }
}

export function validateCapabilityManifests(entries: CapabilityManifest[]): string[] {
  const issues: string[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/.test(entry.id)) issues.push(`invalid capability id ${entry.id}`);
    if (ids.has(entry.id)) issues.push(`duplicate capability id ${entry.id}`);
    ids.add(entry.id);
    if (!entry.label.trim() || !entry.description.trim()) issues.push(`capability ${entry.id} needs a label and description`);
    if (entry.taskKinds.length === 0) issues.push(`capability ${entry.id} supports no task kinds`);
    if (entry.defaultFor.some((kind) => !entry.taskKinds.includes(kind))) issues.push(`capability ${entry.id} has an invalid default task kind`);
    if (entry.risk === "external_action" && !entry.requiresApproval) issues.push(`external capability ${entry.id} must require approval`);
    if (entry.layer === "connector" && entry.requiredConfiguration.length === 0) issues.push(`connector ${entry.id} must declare configuration gates`);
  }
  return issues;
}

export const capabilityRegistry = new CapabilityRegistry(manifests);
