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
  // The query stays subscribed through BOTH listing and zipping. If it dropped to "skip" the
  // instant we moved to "zipping", `artifacts` would flip to undefined mid-build and the effect
  // below would tear its own work down. The arg is stable across that transition, so Convex keeps
  // returning the same array reference and the effect never re-fires.
  const artifacts = useQuery(api.artifacts.listForTask, phase.status === "idle" ? "skip" : { taskId }) as ArchivableArtifact[] | undefined;

  // Held in a ref, not a dependency: hosts pass an inline callback that changes identity every
  // render, and re-running the effect below would start a second archive over the first.
  const noticeRef = useRef(onNotice);
  noticeRef.current = onNotice;

  // One archive per click. The effect keys ONLY on `artifacts` — never on `phase.status`, which
  // it sets itself. Keying on a value the effect mutates was the bug: React runs the previous
  // cleanup before every re-run, so moving listing→zipping fired the "cancelled" cleanup and the
  // finished archive was discarded, leaving the button stuck on "Zipping N/N" forever.
  const startedRef = useRef(false);
  useEffect(() => {
    if (artifacts === undefined || startedRef.current) return;
    startedRef.current = true;
    let cancelled = false;

    if (artifacts.length === 0) {
      startedRef.current = false;
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
        startedRef.current = false;
        if (!cancelled) setPhase({ status: "idle", done: 0, total: 0 });
      });

    // Only a genuine teardown (unmount, or the query dropping its value) cancels — not this
    // effect's own listing→zipping state change, which no longer re-runs it.
    return () => {
      cancelled = true;
    };
  }, [artifacts]);

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
