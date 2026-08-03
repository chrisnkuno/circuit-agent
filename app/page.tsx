"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { estimateTaskCost, formatRwf, type QualityTier, type TaskKind } from "@/lib/task-cost";
import { AgentBoard } from "@/components/agent-board";
import { AuthPanel, useCurrentOrganization } from "@/components/auth-panel";
import { authClient } from "@/lib/auth-client";

const taskKinds: { value: TaskKind; label: string; copy: string }[] = [
  { value: "coding", label: "Build or fix software", copy: "E2B sandbox, checks, review-ready evidence" },
  { value: "research", label: "Research a decision", copy: "Sources, synthesis, and a concise recommendation" },
  { value: "operations", label: "Run work operations", copy: "Plan, app actions, approval gates, and handoff" },
  { value: "writing", label: "Create a deliverable", copy: "Draft, revise, and package an artifact" },
];

function normalizeAttachmentCount(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(10, Math.max(0, Math.trunc(parsed)));
}

export default function Home() {
  const [kind, setKind] = useState<TaskKind>("coding");
  const [quality, setQuality] = useState<QualityTier>("balanced");
  const [attachments, setAttachments] = useState(1);
  const [browser, setBrowser] = useState(false);
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<"idle" | "pending" | "done" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const quote = useMemo(() => estimateTaskCost({ kind, quality, attachmentCount: attachments, requiresBrowser: browser, requiresSandbox: kind !== "writing" }), [attachments, browser, kind, quality]);
  const selected = taskKinds.find((item) => item.value === kind)!;
  const effectiveTitle = title.trim() || selected.label;
  const idempotencyKey = useMemo(() => crypto.randomUUID(), [kind, quality, attachments, browser, effectiveTitle]);

  const session = authClient.useSession();
  const organization = useCurrentOrganization();
  const createQuotedTask = useMutation(api.tasks.createQuotedTask);

  function resetStatus() {
    setStatus("idle");
    setError(null);
  }

  async function reserve() {
    if (!session.data) { setStatus("error"); setError("Sign in to reserve a task cap."); return; }
    if (!organization) { setStatus("error"); setError("Your workspace is still being set up. Try again in a moment."); return; }
    setStatus("pending");
    setError(null);
    try {
      await createQuotedTask({
        organizationId: organization._id,
        title: effectiveTitle,
        kind,
        quality,
        estimateLowRwf: BigInt(quote.estimateLowRwf),
        estimateHighRwf: BigInt(quote.estimateHighRwf),
        maxRwf: BigInt(quote.maxRwf),
        confidence: quote.confidence,
        assumptions: quote.assumptions,
        idempotencyKey,
      });
      setStatus("done");
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Could not reserve the task cap.");
    }
  }

  return <main>
    <header className="topbar"><a className="brand" href="#top">CIRCUIT<span>AGENT</span></a><AuthPanel /></header>
    <section className="hero" id="top"><p className="eyebrow">TASK-PRICED AGENT OPERATING SYSTEM</p><h1>Know the cost.<br /><em>Keep the control.</em></h1><p className="lede">A durable agent workspace for coding and everyday execution—quoted in RWF before work begins, observable from your phone, and capped by your approval.</p></section>
    <section className="workspace" aria-label="Task quote builder">
      <div className="builder"><div className="section-label">01 / Define the work</div><h2>What should the agent complete?</h2>
        <div className="task-grid">{taskKinds.map((item) => <button className={kind === item.value ? "task-card selected" : "task-card"} key={item.value} onClick={() => { setKind(item.value); resetStatus(); }}><strong>{item.label}</strong><span>{item.copy}</span></button>)}</div>
        <div className="controls"><label>Task title<input placeholder={selected.label} value={title} onChange={(event) => { setTitle(event.target.value); resetStatus(); }} /></label><label>Quality<select value={quality} onChange={(event) => { setQuality(event.target.value as QualityTier); resetStatus(); }}><option value="fast">Fast — routine work</option><option value="balanced">Balanced — default</option><option value="expert">Expert — complex work</option></select></label><label>Attached files<input min="0" max="10" step="1" type="number" value={attachments} onChange={(event) => { setAttachments(normalizeAttachmentCount(event.target.value)); resetStatus(); }} /></label><label className="check"><input type="checkbox" checked={browser} onChange={(event) => { setBrowser(event.target.checked); resetStatus(); }} /> Includes browser or app work</label></div>
      </div>
      <aside className="quote"><div className="quote-head"><span>02 / Your quote</span><b className={`confidence ${quote.confidence}`}>{quote.confidence} confidence</b></div><p className="task-name">{selected.label}</p><div className="range"><strong>{formatRwf(quote.estimateLowRwf)}</strong><span>to</span><strong>{formatRwf(quote.estimateHighRwf)}</strong></div><p className="quote-copy">Expected cost based on the selected execution plan.</p><div className="cap"><span>Never exceeds without approval</span><b>{formatRwf(quote.maxRwf)}</b></div><ul>{quote.assumptions.map((assumption) => <li key={assumption}>{assumption}</li>)}</ul><button className="primary" onClick={reserve} disabled={status === "pending"}>{status === "pending" ? "Reserving…" : "Reserve task cap"} <span>→</span></button>{status === "done" && <p className="notice">Task and quote persisted in Convex. Circuit Pay authorization is still blocked until its webhook contract is verified; execution awaits the dispatcher.</p>}{status === "error" && <p className="notice">{error}</p>}</aside>
    </section>
    <section className="principles"><div><span>01</span><h3>Durable by default</h3><p>Convex persists task plans, quotes, approvals, events, and payment holds.</p></div><div><span>02</span><h3>Isolated execution</h3><p>E2B runs code and browser work away from the user’s device.</p></div><div><span>03</span><h3>Human authority</h3><p>No overage, send, merge, or payment action happens silently.</p></div></section>
    <AgentBoard />
  </main>;
}
