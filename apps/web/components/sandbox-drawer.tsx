"use client";

import { useEffect, useState } from "react";
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

  // Whether the preview iframe actually rendered. A just-resumed sandbox running `next start` or
  // `next dev` can legitimately take 10-20s to answer, so "not loaded yet" is shown as a patient
  // spinner first. Only a load that has still not happened well past that is surfaced as "didn't
  // load" — which usually means a browser extension, content blocker, or DNS filter is refusing
  // the cross-origin frame (it fires no catchable error, it just stays blank).
  const [frameState, setFrameState] = useState<"loading" | "slow" | "loaded" | "stuck">("loading");
  const [frameAttempt, setFrameAttempt] = useState(0);
  useEffect(() => {
    if (!previewUrl) return;
    setFrameState("loading");
    const slow = setTimeout(() => setFrameState((state) => (state === "loaded" ? state : "slow")), 8_000);
    const stuck = setTimeout(() => setFrameState((state) => (state === "loaded" ? state : "stuck")), 28_000);
    return () => {
      clearTimeout(slow);
      clearTimeout(stuck);
    };
  }, [previewUrl, frameAttempt]);

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

      {previewUrl && <section className={`live-preview${frameState === "stuck" ? " frame-stuck" : ""}`}>
        <header>
          <span><b>INTERACTIVE SANDBOX PREVIEW</b><small>Ephemeral E2B port 3000 · isolated frame</small></span>
          <a href={previewUrl} target="_blank" rel="noreferrer">Open full screen <ArrowUpRight /></a>
        </header>
        {frameState === "slow" && <p className="frame-fallback">
          <LoaderCircle className="spin" size={13} aria-hidden="true" /> Starting the app in the sandbox — this can take up to half a minute on the first load.
        </p>}
        {frameState === "stuck" && <p className="frame-fallback">
          The app isn’t rendering in this frame, but it’s serving fine — this is a browser privacy feature (Firefox Enhanced Tracking Protection, Safari cross-site tracking prevention, or a content blocker) refusing the cross-origin frame for <code>{new URL(previewUrl).host}</code>. It is not blocked on our side.
          {" "}<a href={previewUrl} target="_blank" rel="noreferrer">Open it full screen <ArrowUpRight /></a> — that always works.
          {" · "}<button type="button" className="frame-retry" onClick={() => setFrameAttempt((n) => n + 1)}>retry in frame</button>
        </p>}
        {/*
          No `sandbox` attribute. The preview is already a foreign origin (`3000-<id>.e2b.app`),
          so the same-origin policy alone stops it reading our DOM, cookies or storage — that
          isolation does not depend on `sandbox`. Adding `sandbox` only ever *subtracts*
          capabilities from the framed document, and the subtractions bite unevenly across
          browsers: without `allow-same-origin` the frame runs in an opaque origin and cannot load
          its own `/_next/static` bundles (renders unstyled); *with* `allow-same-origin` some
          browsers partition its storage so aggressively that the app's client JS throws on first
          `localStorage` access and renders nothing at all. A plain cross-origin frame gets normal
          (silently partitioned) storage and just works. The one thing we give up is blocking
          top-window navigation from generated code — an annoyance, not a cross-origin breach.
        */}
        <iframe
          key={`${previewUrl}#${frameAttempt}`}
          src={previewUrl}
          title="Generated app preview"
          referrerPolicy="no-referrer"
          onLoad={() => setFrameState("loaded")}
        />
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
