"use client";

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ChevronRight, FolderOpen, History, Square } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { formatRwf } from "@/lib/task-cost";
import { SidePanel } from "@/components/side-panel";
import { DownloadWorkButton } from "@/components/download-work-button";

type TaskDoc = Doc<"tasks">;
type TaskStatus = TaskDoc["status"];

/** Live execution state of a task's running step, as last reported by the worker's heartbeat. */
type Execution = {
  runId: Id<"agentRuns">;
  completedSteps: number;
  totalSteps: number;
  stepTitle: string | null;
  sandboxId: string | null;
  heartbeatAt: number | null;
  leaseExpiresAt: number | null;
} | null;

type Folder = { key: string; label: string; match: (status: TaskStatus) => boolean };

const FOLDERS: Folder[] = [
  { key: "active", label: "Active", match: (status) => status === "running" || status === "awaiting_approval" || status === "quoted" || status === "draft" },
  { key: "completed", label: "Completed", match: (status) => status === "completed" },
  { key: "attention", label: "Needs attention", match: (status) => status === "blocked" || status === "cancelled" },
];

/**
 * Describes a worker's liveness from its own heartbeat rather than from the stored run status.
 * A lease that has already lapsed is reported as stalled, not as running — recovery will retry
 * it shortly, and claiming it is healthy in the meantime would be untrue.
 */
function sandboxState(execution: NonNullable<Execution>, now: number): { label: string; tone: "live" | "stalled" | "starting" } {
  if (!execution.stepTitle) return { label: "waiting for a worker", tone: "starting" };
  if (execution.leaseExpiresAt !== null && execution.leaseExpiresAt <= now) return { label: "worker lease lapsed — recovering", tone: "stalled" };
  if (!execution.sandboxId) return { label: "starting sandbox", tone: "starting" };
  const since = execution.heartbeatAt === null ? null : Math.round((now - execution.heartbeatAt) / 1000);
  // The sandbox id is long and opaque; a short prefix is enough to correlate with E2B's console.
  return { label: `sandbox ${execution.sandboxId.slice(0, 8)}${since === null ? "" : ` · beat ${since}s ago`}`, tone: "live" };
}

function relativeTime(ms: number): string {
  const diffMinutes = Math.floor((Date.now() - ms) / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function TaskHistory({ organizationId, onResumeTask, onOpenFiles }: { organizationId: Id<"organizations"> | undefined; onResumeTask: (taskId: Id<"tasks">) => void; onOpenFiles: (taskId: Id<"tasks">) => void }) {
  const tasks = useQuery(api.tasks.listRecent, organizationId ? { organizationId } : "skip");
  const stopTask = useMutation(api.agentRuns.requestTaskCancellation);
  const [openFolder, setOpenFolder] = useState<string | null>("active");
  const [stoppingTaskId, setStoppingTaskId] = useState<Id<"tasks"> | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  async function stop(taskId: Id<"tasks">) {
    setStoppingTaskId(taskId);
    setStopError(null);
    try {
      await stopTask({ taskId });
      // A stopped task immediately leaves "Active" for "Needs attention". Without following it
      // there, the card a person just acted on simply vanishes, which reads as a lost task
      // rather than a stopped one.
      setOpenFolder("attention");
    } catch (error) {
      setStopError(error instanceof Error ? error.message : "Could not stop that task");
    } finally {
      setStoppingTaskId(null);
    }
  }

  if (!organizationId) return null;

  if (!tasks || tasks.length === 0) {
    return (
      <SidePanel
        title="Task history"
        icon={History}
        count={0}
        empty={<p className="side-panel-empty">Runs you start in the console show up here with live status and spend.</p>}
      />
    );
  }

  return (
    <SidePanel title="Task history" icon={History} count={tasks.length}>
      {stopError && <p className="task-history-error">{stopError}</p>}
      {FOLDERS.map((folder) => {
        const items = tasks.filter((task) => folder.match(task.status));
        if (items.length === 0) return null;
        const isOpen = openFolder === folder.key;
        return (
          <div className="task-folder" key={folder.key}>
            <button type="button" className="task-folder-toggle" onClick={() => setOpenFolder(isOpen ? null : folder.key)} aria-expanded={isOpen}>
              <ChevronRight size={13} strokeWidth={2} className={`task-folder-glyph${isOpen ? " task-folder-glyph-open" : ""}`} aria-hidden="true" />
              <span className="task-folder-label">{folder.label}</span>
              <span className="task-folder-count">{items.length}</span>
            </button>
            {isOpen && (
              <ul className="task-list">
                {items.map((task) => {
                  const execution: Execution = task.execution ?? null;
                  const live = execution ? sandboxState(execution, Date.now()) : null;
                  // Stoppable exactly while there is still something to stop.
                  const canStop = task.status === "running" || task.status === "awaiting_approval" || task.status === "quoted" || task.status === "draft";
                  return (
                    <li key={task._id} className="task-card">
                      <div className="task-card-main">
                        <span className="task-card-title">{task.title}</span>
                        <b className={`task-card-status task-status-${task.status}`}>{task.status.replace("_", " ")}</b>
                      </div>
                      {execution && live && (
                        <div className={`task-card-live task-card-live-${live.tone}`}>
                          <span className="task-card-live-dot" aria-hidden="true" />
                          <span className="task-card-live-step">
                            {execution.stepTitle ?? "queued"}
                            <small>
                              {" "}
                              {execution.completedSteps}/{execution.totalSteps}
                            </small>
                          </span>
                          <span className="task-card-live-sandbox">{live.label}</span>
                        </div>
                      )}
                      <div className="task-card-meta">
                        <span>{formatRwf(Number(task.spentRwf))} of {formatRwf(Number(task.maxRwf))}</span>
                        <span>{relativeTime(task.createdAt)}</span>
                      </div>
                      <div className="task-card-actions">
                        <button type="button" className="task-card-resume" onClick={() => onResumeTask(task._id)}>
                          View live
                          <ChevronRight size={13} strokeWidth={2} aria-hidden="true" />
                        </button>
                        <button type="button" className="task-card-files" onClick={() => onOpenFiles(task._id)} title="View produced files">
                          <FolderOpen size={13} strokeWidth={1.75} aria-hidden="true" />
                          Files
                        </button>
                        <DownloadWorkButton taskId={task._id} className="task-card-files task-card-zip" label="Zip" />
                        {canStop && (
                          <button type="button" className="task-card-stop" disabled={stoppingTaskId === task._id} onClick={() => void stop(task._id)} title="Stop this task">
                            <Square size={11} strokeWidth={2.25} aria-hidden="true" />
                            {stoppingTaskId === task._id ? "…" : "Stop"}
                          </button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        );
      })}
    </SidePanel>
  );
}
