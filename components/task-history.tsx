"use client";

import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Doc, Id } from "@/convex/_generated/dataModel";
import { formatRwf } from "@/lib/task-cost";

type TaskDoc = Doc<"tasks">;
type TaskStatus = TaskDoc["status"];

type Folder = { key: string; label: string; match: (status: TaskStatus) => boolean };

const FOLDERS: Folder[] = [
  { key: "active", label: "Active", match: (status) => status === "running" || status === "awaiting_approval" || status === "quoted" || status === "draft" },
  { key: "completed", label: "Completed", match: (status) => status === "completed" },
  { key: "attention", label: "Needs attention", match: (status) => status === "blocked" || status === "cancelled" },
];

function relativeTime(ms: number): string {
  const diffMinutes = Math.floor((Date.now() - ms) / 60_000);
  if (diffMinutes < 1) return "just now";
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

export function TaskHistory({ organizationId, onResumeTask }: { organizationId: Id<"organizations"> | undefined; onResumeTask: (taskId: Id<"tasks">) => void }) {
  const tasks = useQuery(api.tasks.listRecent, organizationId ? { organizationId } : "skip");
  const [openFolder, setOpenFolder] = useState<string | null>("active");

  if (!tasks || tasks.length === 0) return null;

  return (
    <div className="task-history">
      <div className="task-history-header">
        <span className="task-history-title">Task history</span>
        <span className="task-history-count">{tasks.length}</span>
      </div>
      {FOLDERS.map((folder) => {
        const items = tasks.filter((task) => folder.match(task.status));
        if (items.length === 0) return null;
        const isOpen = openFolder === folder.key;
        return (
          <div className="task-folder" key={folder.key}>
            <button type="button" className="task-folder-toggle" onClick={() => setOpenFolder(isOpen ? null : folder.key)} aria-expanded={isOpen}>
              <span className={`task-folder-glyph${isOpen ? " task-folder-glyph-open" : ""}`}>▸</span>
              <span className="task-folder-label">{folder.label}</span>
              <span className="task-folder-count">{items.length}</span>
            </button>
            {isOpen && (
              <ul className="task-list">
                {items.map((task) => (
                  <li key={task._id} className="task-card">
                    <div className="task-card-main">
                      <span className="task-card-title">{task.title}</span>
                      <b className={`task-card-status task-status-${task.status}`}>{task.status.replace("_", " ")}</b>
                    </div>
                    <div className="task-card-meta">
                      <span>{formatRwf(Number(task.spentRwf))} of {formatRwf(Number(task.maxRwf))}</span>
                      <span>{relativeTime(task.createdAt)}</span>
                    </div>
                    <button type="button" className="task-card-resume" onClick={() => onResumeTask(task._id)}>
                      View live status →
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}
