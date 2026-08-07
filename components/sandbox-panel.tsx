"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { findWorkspacePreset } from "@/lib/sandbox-templates";

type Controls = "pause" | "resume" | "stop";

/** Sandbox runtime reads in seconds and minutes: a run's sandbox is alive for seconds at a time. */
function formatRuntime(ms: number): string {
  if (ms < 1_000) return "0s";
  const seconds = Math.round(ms / 1_000);
  return seconds < 90 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function heartbeatAge(heartbeatAt: number | null): string {
  if (heartbeatAt === null) return "";
  const seconds = Math.round((Date.now() - heartbeatAt) / 1000);
  return seconds < 90 ? `${seconds}s ago` : `${Math.round(seconds / 60)}m ago`;
}

/**
 * The workspaces this organization currently owns, and the controls that act on them.
 *
 * Controls act on the *run*, not on the sandbox directly, which is the honest boundary: pausing a
 * sandbox out from under a step that is mid-command would strand its lease and its reservation
 * with no way to settle either. Holding the run instead reaches the same place — the sandbox stops
 * being used and costs nothing while suspended — and leaves the accounting intact.
 */
export function SandboxPanel({ organizationId }: { organizationId: Id<"organizations"> | undefined }) {
  const sandboxes = useQuery(api.sandboxes.listForOrganization, organizationId ? { organizationId } : "skip");
  const usage = useQuery(api.sandboxes.usageForOrganization, organizationId ? { organizationId } : "skip");
  const pauseRun = useMutation(api.agentRuns.pauseRun);
  const resumeRun = useMutation(api.agentRuns.resumeRun);
  const cancelRun = useMutation(api.agentRuns.requestCancellation);
  const [busyRunId, setBusyRunId] = useState<Id<"agentRuns"> | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Usage outlives the sandboxes it came from: runtime accrued by runs that have already finished
  // is exactly what a person compares against the provider's dashboard, and hiding it whenever
  // nothing is currently running would mean it is almost never visible.
  const hasUsage = Boolean(usage && usage.sandboxMs > 0);
  if ((!sandboxes || sandboxes.length === 0) && !hasUsage) return null;

  async function act(runId: Id<"agentRuns">, control: Controls) {
    setBusyRunId(runId);
    setError(null);
    try {
      if (control === "pause") await pauseRun({ runId });
      else if (control === "resume") await resumeRun({ runId });
      else await cancelRun({ runId });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "That control did not apply");
    } finally {
      setBusyRunId(null);
    }
  }

  return (
    <div className="sandbox-panel">
      <div className="sandbox-panel-header">
        <span className="sandbox-panel-title">Sandboxes</span>
        <span className="sandbox-panel-count">{sandboxes?.length ?? 0}</span>
      </div>
      {usage && usage.sandboxMs > 0 && (
        // Billed runtime, not elapsed time — the number to hold against the provider's dashboard.
        <div className="sandbox-usage" title={`Measured from provider lifecycle events across ${usage.runs} run(s). Provider-reported total: ${formatRuntime(usage.reportedMs)}.`}>
          <span>{formatRuntime(usage.sandboxMs)} of sandbox runtime</span>
          <span className="sandbox-usage-cost">≈ ${usage.estimatedUsd < 0.01 ? usage.estimatedUsd.toFixed(4) : usage.estimatedUsd.toFixed(2)}</span>
        </div>
      )}
      {error && <p className="sandbox-panel-error">{error}</p>}
      <ul className="sandbox-list">
        {(sandboxes ?? []).map((sandbox) => {
          const preset = findWorkspacePreset(sandbox.workspacePresetId ?? undefined);
          const executing = Boolean(sandbox.activeStepTitle);
          return (
            <li className="sandbox-card" key={sandbox.sandboxId}>
              <div className="sandbox-card-main">
                <span className={`sandbox-card-dot${executing ? " sandbox-card-dot-live" : ""}`} />
                <span className="sandbox-card-id" title={sandbox.sandboxId}>{sandbox.sandboxId.slice(0, 10)}</span>
                <span className="sandbox-card-preset">{preset.label}</span>
              </div>
              <div className="sandbox-card-task" title={sandbox.taskTitle}>{sandbox.taskTitle}</div>
              <div className="sandbox-card-state">
                {/* Suspended between steps is the resting state, not a fault — say so plainly. */}
                {executing ? `${sandbox.activeStepTitle} · ${heartbeatAge(sandbox.heartbeatAt)}` : `suspended · ${sandbox.runStatus.replaceAll("_", " ")}`}
                {sandbox.sandboxMs > 0 && <span className="sandbox-card-runtime">{formatRuntime(sandbox.sandboxMs)} run</span>}
              </div>
              <div className="sandbox-card-actions">
                {sandbox.runStatus === "paused" ? (
                  <button type="button" disabled={busyRunId === sandbox.runId} onClick={() => void act(sandbox.runId, "resume")} className="sandbox-action sandbox-action-resume">
                    Resume
                  </button>
                ) : (
                  <button type="button" disabled={busyRunId === sandbox.runId} onClick={() => void act(sandbox.runId, "pause")} className="sandbox-action">
                    Pause
                  </button>
                )}
                <button type="button" disabled={busyRunId === sandbox.runId} onClick={() => void act(sandbox.runId, "stop")} className="sandbox-action sandbox-action-stop">
                  Destroy
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
