"use client";

import { ArrowUpRight, FileText, LoaderCircle, Pause, Play, X } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { DownloadWorkButton } from "@/components/download-work-button";

/**
 * Everything about one sandbox that does not belong on screen until it is asked for: the file
 * tree, the run timeline, and the live preview frame.
 *
 * Split out of the messenger and loaded on demand. It is the only part of the surface that pulls
 * the archive builder, and nobody pays for that code — or for the two extra subscriptions below —
 * while they are simply reading the conversation.
 */
export function SandboxDrawer({
  inline = false,
  taskId,
  title,
  status,
  runs,
  previewUrl,
  previewLoading,
  onSelectRun,
  onStartPreview,
  onPause,
  onResume,
  onNotice,
  onClose,
}: {
  /** Inline is a tab: no backdrop, no dialog role, and it does not trap focus. */
  inline?: boolean;
  taskId: Id<"tasks">;
  title: string;
  status: string;
  /** The other in-flight tasks, so a person can move between parallel runs without closing this. */
  runs: { id: Id<"tasks">; title: string; state: string }[];
  previewUrl: string | null;
  previewLoading: boolean;
  onSelectRun: (taskId: Id<"tasks">) => void;
  onStartPreview: (runId: Id<"agentRuns">) => void;
  onPause: (runId: Id<"agentRuns">) => void;
  onResume: (runId: Id<"agentRuns">) => void;
  onNotice: (text: string) => void;
  onClose: () => void;
}) {
  const artifacts = useQuery(api.artifacts.listForTask, { taskId });
  const taskRuns = useQuery(api.agentRuns.listForTask, { taskId });
  const latestRun = taskRuns?.reduce((latest, run) => !latest || run.createdAt > latest.createdAt ? run : latest, undefined as (typeof taskRuns)[number] | undefined);
  const detail = useQuery(api.agentRuns.getRunDetail, latestRun ? { runId: latestRun._id } : "skip");

  const panel = <section className={`output-panel${inline ? " inline" : ""}`} {...(inline ? { "aria-label": "Sandbox detail" } : { role: "dialog", "aria-modal": true, "aria-label": "Sandbox detail" })}>
      <header>
        <div>
          <p className="overline">SANDBOX DETAIL</p>
          <h2>{title}</h2>
          <span>{status}{latestRun?.sandboxId ? ` · ${latestRun.sandboxId}` : ""}</span>
        </div>
        <button onClick={onClose} aria-label="Close sandbox detail"><X /></button>
      </header>

      {runs.length > 1 && <div className="output-switcher" role="tablist" aria-label="Running sandboxes">
        {runs.map((run) => <button role="tab" key={run.id} aria-selected={run.id === taskId} className={run.id === taskId ? "active" : ""} onClick={() => onSelectRun(run.id)}>
          <span className={`task-dot ${run.state}`} />{run.title}
        </button>)}
      </div>}

      <div className="output-actions">
        <DownloadWorkButton taskId={taskId} className="download-output" label="Download all output" onNotice={({ text }) => onNotice(text)} />
        {latestRun?.sandboxId && <button className="run-control" disabled={previewLoading} onClick={() => onStartPreview(latestRun._id)}>
          <ArrowUpRight /> {previewLoading ? "Starting preview…" : "Live preview"}
        </button>}
        {latestRun?.status === "paused"
          ? <button className="run-control" onClick={() => onResume(latestRun._id)}><Play /> Resume sandbox</button>
          : latestRun && ["queued", "running"].includes(latestRun.status)
            ? <button className="run-control" onClick={() => onPause(latestRun._id)}><Pause /> Pause sandbox</button>
            : null}
        <small>Updates automatically while E2B continues.</small>
      </div>

      {previewUrl && <section className="live-preview">
        <header>
          <span><b>INTERACTIVE SANDBOX PREVIEW</b><small>Ephemeral E2B port 3000 · isolated frame</small></span>
          <a href={previewUrl} target="_blank" rel="noreferrer">Open full screen <ArrowUpRight /></a>
        </header>
        {/* No allow-same-origin: generated code runs in a foreign origin and must not reach this one. */}
        <iframe src={previewUrl} title="Generated app preview" sandbox="allow-scripts allow-forms allow-modals allow-popups" referrerPolicy="no-referrer" />
      </section>}

      <div className="output-grid">
        <section>
          <p className="section-label">FILES &amp; EVIDENCE</p>
          {artifacts === undefined ? <div className="output-loading"><LoaderCircle /> Reading output…</div>
            : artifacts.length === 0 ? <p className="output-empty">No files yet. Output appears here as sandbox steps finish.</p>
              : <ul className="artifact-list">{[...artifacts].sort((a, b) => b.createdAt - a.createdAt).map((artifact) => <li key={artifact.id}>
                <span><FileText /><b>{artifact.path ?? artifact.kind.replaceAll("_", " ")}</b><small>{artifact.stepTitle ?? "Run evidence"} · {Math.max(1, Math.round(artifact.byteLength / 1024))} KB</small></span>
                {artifact.url ? <a href={artifact.url} target="_blank" rel="noreferrer">Open <ArrowUpRight /></a> : <em>Metadata only</em>}
              </li>)}</ul>}
        </section>
        <section>
          <p className="section-label">RUN TIMELINE</p>
          {detail === undefined ? <div className="output-loading"><LoaderCircle /> Reading timeline…</div>
            : !detail ? <p className="output-empty">No execution run exists yet.</p>
              : <>
                <ol className="step-list">{detail.steps.map((step) => <li key={step._id}>
                  <i className={`task-dot ${step.status}`} /><span><b>{step.title}</b><small>{step.status.replaceAll("_", " ")}{step.summary ? ` · ${step.summary}` : ""}</small></span>
                </li>)}</ol>
                <ol className="event-list">{[...detail.events].reverse().slice(0, 12).map((event) => <li key={event._id}>
                  <time>{new Date(event.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time><p>{event.message}</p>
                </li>)}</ol>
              </>}
        </section>
      </div>
  </section>;

  if (inline) return panel;
  return <div className="output-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>{panel}</div>;
}
