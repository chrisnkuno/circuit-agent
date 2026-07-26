"use client";

import { useMemo, useState } from "react";
import { buildCodingTaskPlan, scheduleAcrossRuns, validateTaskGraph, type AgentRunPlan } from "@/lib/agent-orchestration";

const roleLabel = { planner: "Planner", coding: "Coding agent", reviewer: "Reviewer", research: "Research agent", operator: "Operations agent" };

function createPreviewRun(): AgentRunPlan {
  return buildCodingTaskPlan({ runId: `preview-${crypto.randomUUID()}`, title: "Coding agent run", requiresBrowserVerification: true });
}

export function AgentBoard() {
  const [runs, setRuns] = useState<AgentRunPlan[]>([]);
  const [notice, setNotice] = useState("No runs have been created.");
  const readySteps = useMemo(() => scheduleAcrossRuns(runs, 4), [runs]);
  const graphIssues = useMemo(() => runs.flatMap(validateTaskGraph), [runs]);

  function addRun() {
    const run = createPreviewRun();
    setRuns((current) => [...current, run]);
    setNotice("A local plan was created. Activate Convex and E2B to persist and execute it.");
  }

  return <section className="agent-section" id="agents">
    <div className="agent-intro"><div><p className="eyebrow">03 / ORCHESTRATION</p><h2>One goal. Several accountable workers.</h2><p>Agent steps wait for their dependencies, start only within a concurrency limit, and hand back evidence before a human approval gate.</p></div><button className="outline" onClick={addRun}>Plan coding run <span>+</span></button></div>
    <div className="agent-summary"><div><span>Active plans</span><b>{runs.length}</b></div><div><span>Fairly scheduled now</span><b>{readySteps.length} / 4</b></div><div><span>Graph validation</span><b>{graphIssues.length === 0 ? "Valid" : `${graphIssues.length} issues`}</b></div><div><span>Execution authority</span><b>Blocked</b></div></div>
    <div className="agent-board">{runs.length === 0 ? <p className="empty-state">Create a coding plan to inspect the dependency-aware run graph. This preview does not claim that an agent has executed work.</p> : runs.map((run) => <article className="run-card" key={run.runId}><header><div><span>CODING RUN</span><h3>{run.title}</h3></div><b>QUEUED</b></header><ol>{run.steps.map((step, index) => <li key={step.id}><span className={index === 0 ? "step-dot ready" : "step-dot"}>{index + 1}</span><div><strong>{step.title}</strong><small>{roleLabel[step.role]}{step.sandboxTemplate ? ` · ${step.sandboxTemplate} sandbox` : ""}</small></div>{step.requiresApproval && <em>Approval gate</em>}</li>)}</ol></article>)}</div>
    <p className="agent-notice">{notice}</p>
  </section>;
}
