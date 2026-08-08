"use client";

import { useEffect, useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { buildArtifactArchive, saveArchive } from "@/lib/artifact-archive";

type ArtifactRow = {
  id: string;
  kind: string;
  path: string | null;
  mediaType: string;
  byteLength: number;
  stepTitle: string | null;
  createdAt: number;
  url: string | null;
};

const KIND_LABEL: Record<string, string> = {
  workspace_file: "File",
  model_plan: "Plan",
  command_log: "Commands",
  patch: "Patch",
  test_log: "Tests",
  review_summary: "Review",
};

function labelForArtifact(artifact: ArtifactRow): string {
  if (artifact.path === "wander/REPORT.html") return "Harvest";
  return KIND_LABEL[artifact.kind] ?? artifact.kind;
}

function formatBytes(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * A sliding panel over the produced work: the files a task's steps actually wrote, plus the plans
 * and command logs behind them.
 *
 * Content is fetched only when something is opened, never up front. A task can carry a few hundred
 * artifacts, and pulling every byte to render a list of names would make opening the panel far more
 * expensive than reading the one file someone wanted.
 */
export function ArtifactDrawer({ taskId, onClose }: { taskId: Id<"tasks"> | null; onClose: () => void }) {
  const artifacts = useQuery(api.artifacts.listForTask, taskId ? { taskId } : "skip") as ArtifactRow[] | undefined;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [content, setContent] = useState<{ id: string; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [archiveState, setArchiveState] = useState<{ status: "idle" | "building"; done: number; total: number; error: string | null }>({
    status: "idle",
    done: 0,
    total: 0,
    error: null,
  });

  // Files first: they are the work. Everything else explains how the work happened.
  const ordered = [...(artifacts ?? [])].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "workspace_file" ? -1 : right.kind === "workspace_file" ? 1 : 0;
    return (left.path ?? "").localeCompare(right.path ?? "");
  });
  const selected = ordered.find((artifact) => artifact.id === selectedId) ?? ordered[0] ?? null;

  useEffect(() => {
    if (!selected?.url) {
      setContent(null);
      return;
    }
    if (content?.id === selected.id) return;
    let cancelled = false;
    setLoadError(null);
    fetch(selected.url)
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error(`Could not read this artifact (${response.status})`))))
      .then((text) => {
        if (!cancelled) setContent({ id: selected.id, text });
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "Could not read this artifact");
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.url, content?.id]);

  // Escape closes, which is what a drawer is expected to do.
  useEffect(() => {
    if (!taskId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId, onClose]);

  if (!taskId) return null;

  async function copy() {
    if (!content) return;
    await navigator.clipboard.writeText(content.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  /**
   * Everything at once, as the folder the run worked in.
   *
   * Downloading a lab notebook one file at a time is nine clicks for something that is only
   * meaningful whole — the hypotheses, both reviews and the consensus are one document.
   */
  async function downloadAll() {
    const downloadable = ordered.filter((artifact) => artifact.url);
    if (downloadable.length === 0) return;
    setArchiveState({ status: "building", done: 0, total: downloadable.length, error: null });
    try {
      saveArchive(await buildArtifactArchive(ordered, { onProgress: (done, total) => setArchiveState({ status: "building", done, total, error: null }) }));
      setArchiveState({ status: "idle", done: 0, total: 0, error: null });
    } catch (error) {
      setArchiveState({ status: "idle", done: 0, total: 0, error: error instanceof Error ? error.message : "Could not build the archive" });
    }
  }

  return (
    <>
      <div className="artifact-scrim" onClick={onClose} aria-hidden="true" />
      <aside className="artifact-drawer" role="dialog" aria-label="Generated files">
        <header className="artifact-drawer-head">
          <span className="artifact-drawer-title">Produced work</span>
          <span className="artifact-drawer-count">{ordered.length}</span>
          {ordered.some((artifact) => artifact.url) && (
            <button
              type="button"
              className="artifact-drawer-zip"
              onClick={() => void downloadAll()}
              disabled={archiveState.status === "building"}
              title="Download every file this task produced as one .zip"
            >
              {archiveState.status === "building" ? `Zipping ${archiveState.done}/${archiveState.total}` : "Download all"}
            </button>
          )}
          <button type="button" className="artifact-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        {archiveState.error && <p className="artifact-drawer-empty">{archiveState.error}</p>}
        {artifacts === undefined && <p className="artifact-drawer-empty">Loading…</p>}
        {artifacts?.length === 0 && (
          <p className="artifact-drawer-empty">
            Nothing recorded yet. Files appear here once a step has run and its workspace has been captured.
          </p>
        )}

        <div className="artifact-drawer-body">
          <ul className="artifact-list">
            {ordered.map((artifact) => (
              <li key={artifact.id}>
                <button
                  type="button"
                  className={`artifact-item${selected?.id === artifact.id ? " artifact-item-active" : ""}`}
                  onClick={() => setSelectedId(artifact.id)}
                >
                  <span className="artifact-item-kind">{labelForArtifact(artifact)}</span>
                  <span className="artifact-item-name">{artifact.path ?? artifact.stepTitle ?? artifact.kind}</span>
                  <span className="artifact-item-size">{formatBytes(artifact.byteLength)}</span>
                </button>
              </li>
            ))}
          </ul>

          <div className="artifact-view">
            {selected && (
              <div className="artifact-view-head">
                <span className="artifact-view-path">{selected.path ?? selected.stepTitle ?? selected.kind}</span>
                {selected.url && (
                  <>
                    <button type="button" className="artifact-view-action" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</button>
                    <a className="artifact-view-action" href={selected.url} download={selected.path ?? `${selected.kind}.txt`}>Download</a>
                  </>
                )}
              </div>
            )}
            {selected && !selected.url && (
              // Honest about the gap rather than showing an empty box: these rows predate content
              // being stored at all, so the artifact is real but its bytes were never kept.
              <p className="artifact-drawer-empty">This artifact was recorded before its content was retained, so only its hash and size exist.</p>
            )}
            {loadError && <p className="artifact-drawer-empty">{loadError}</p>}
            {content && selected?.id === content.id && <pre className="artifact-code">{content.text}</pre>}
          </div>
        </div>
      </aside>
    </>
  );
}
