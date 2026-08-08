"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { FileArchive } from "lucide-react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { buildArtifactArchive, saveArchive, type ArchivableArtifact } from "@/lib/artifact-archive";

type Phase = { status: "idle" | "listing" | "zipping"; done: number; total: number };

/**
 * "Download the whole folder", wherever a task is on screen.
 *
 * The artifact list is fetched only after a click, never on render: this button appears once per
 * task card, and subscribing every one of them to its task's artifacts would make opening the task
 * list cost a query per row for data almost nobody asks for.
 */
export function DownloadWorkButton({
  taskId,
  className,
  label = "Download folder",
  onNotice,
}: {
  taskId: Id<"tasks">;
  className?: string;
  label?: string;
  /** Reports completion and failure wherever the host already talks to the user. */
  onNotice?: (notice: { tone: "success" | "error"; text: string }) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ status: "idle", done: 0, total: 0 });
  const artifacts = useQuery(api.artifacts.listForTask, phase.status === "listing" ? { taskId } : "skip") as ArchivableArtifact[] | undefined;

  // Held in a ref, not a dependency: hosts pass an inline callback that changes identity every
  // render, and re-running the effect below would start a second archive over the first.
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  useEffect(() => {
    if (phase.status !== "listing" || artifacts === undefined) return;
    let cancelled = false;

    if (artifacts.length === 0) {
      setPhase({ status: "idle", done: 0, total: 0 });
      noticeRef.current?.({ tone: "error", text: "This task has not produced any files yet." });
      return;
    }

    setPhase({ status: "zipping", done: 0, total: artifacts.length });
    void buildArtifactArchive(artifacts, { onProgress: (done, total) => !cancelled && setPhase({ status: "zipping", done, total }) })
      .then((archive) => {
        if (cancelled) return;
        saveArchive(archive);
        const missing = archive.skipped.length > 0 ? `, ${archive.skipped.length} without stored content omitted` : "";
        noticeRef.current?.({ tone: "success", text: `downloaded ${archive.filename} — ${archive.fileCount} files${missing}` });
      })
      .catch((error: unknown) => {
        if (!cancelled) noticeRef.current?.({ tone: "error", text: error instanceof Error ? error.message : "Could not build the archive" });
      })
      .finally(() => {
        if (!cancelled) setPhase({ status: "idle", done: 0, total: 0 });
      });

    return () => {
      cancelled = true;
    };
  }, [phase.status, artifacts]);

  const busy = phase.status !== "idle";
  return (
    <button
      type="button"
      className={className}
      disabled={busy}
      title="Download every file this task produced as one .zip"
      onClick={() => setPhase({ status: "listing", done: 0, total: 0 })}
    >
      <FileArchive size={13} strokeWidth={1.75} aria-hidden="true" />
      {phase.status === "zipping" ? `Zipping ${phase.done}/${phase.total}` : phase.status === "listing" ? "Reading…" : label}
    </button>
  );
}
