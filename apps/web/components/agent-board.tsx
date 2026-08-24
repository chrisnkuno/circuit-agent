"use client";

import { useMemo, useState } from "react";
import { buildTaskPlan, scheduleAcrossRuns, validateTaskGraph, type AgentRunPlan } from "@/lib/agent-orchestration";
import { capabilityRegistry } from "@/lib/capability-registry";
import type { TaskKind } from "@/lib/task-cost";

const roleLabel = { planner: "Planner", coding: "Coding agent", reviewer: "Reviewer", research: "Research agent", operator: "Operations agent" };

const kindLabel: Record<TaskKind, string> = { coding: "Coding", research: "Research", writing: "Writing", operations: "Operations" };

function createPreviewRun(taskKind: TaskKind): AgentRunPlan {
  return buildTaskPlan({ runId: `preview-${crypto.randomUUID()}`, title: `${kindLabel[taskKind]} agent run`, kind: taskKind, requiresBrowserVerification: taskKind === "coding" });
}

export function AgentBoard({ taskKind }: { taskKind: TaskKind }) {
  const [runs, setRuns] = useState<AgentRunPlan[]>([]);
  const [notice, setNotice] = useState("No runs have been created.");
  const readySteps = useMemo(() => scheduleAcrossRuns(runs, 4), [runs]);
  const graphIssues = useMemo(() => runs.flatMap(validateTaskGraph), [runs]);

  function addRun() {
    const run = createPreviewRun(taskKind);
    setRuns((current) => [...current, run]);
    setNotice(`A capability-scoped ${taskKind} plan was created locally. Persisted execution still follows provider and approval gates.`);
  }

  return <section className="agent-section" id="agents">
    <div className="agent-intro"><div><p className="eyebrow">04 / ORCHESTRATION</p><h2>One goal. The right capabilities.</h2><p>A narrow core loads task-specific skills and connectors, then runs a durable dependency graph with budgets, evidence, and human approval.</p></div><button className="outline" onClick={addRun}>Plan {taskKind} run <span>+</span></button></div>
    <div className="agent-summary"><div><span>Active plans</span><b>{runs.length}</b></div><div><span>Fairly scheduled now</span><b>{readySteps.length} / 4</b></div><div><span>Graph validation</span><b>{graphIssues.length === 0 ? "Valid" : `${graphIssues.length} issues`}</b></div><div><span>Execution authority</span><b>Blocked</b></div></div>
    <div className="agent-board">{runs.length === 0 ? <p className="empty-state">Create a {taskKind} plan to inspect its capability-scoped run graph. This preview does not claim that an agent has executed work.</p> : runs.map((run) => <article className="run-card" key={run.runId}><header><div><span>MULTIPURPOSE RUN · {(run.capabilityIds ?? []).length} CAPABILITIES</span><h3>{run.title}</h3></div><b>QUEUED</b></header><ol>{run.steps.map((step, index) => <li key={step.id}><span className={index === 0 ? "step-dot ready" : "step-dot"}>{index + 1}</span><div><strong>{step.title}</strong><small>{roleLabel[step.role]}{step.sandboxTemplate ? ` · ${step.sandboxTemplate} sandbox` : ""}</small><span className="capability-list">{(step.capabilityIds ?? []).map((id) => capabilityRegistry.get(id)?.label ?? id).join(" · ")}</span></div>{step.requiresApproval && <em>Approval gate</em>}</li>)}</ol></article>)}</div>
    <p className="agent-notice">{notice}</p>
  </section>;
}
