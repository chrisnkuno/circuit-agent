import { archiveFilename, archivePathForArtifact, createZip } from "./zip";

/** The fields of a listed artifact an archive needs; a superset is fine. */
export type ArchivableArtifact = {
  id: string;
  kind: string;
  path: string | null;
  stepTitle: string | null;
  createdAt: number;
  url: string | null;
};

export type ArchiveResult = {
  bytes: Uint8Array;
  filename: string;
  fileCount: number;
  /** Rows with no stored content, which are named so the caller can say what was left out. */
  skipped: string[];
};

export type ArchiveOptions = {
  fetchImpl?: typeof fetch;
  /** Called after each file lands, for a progress label. */
  onProgress?: (done: number, total: number) => void;
  concurrency?: number;
};

/**
 * Fetches every artifact that has stored content and packs it into one archive.
 *
 * Shared by every "download the work" control in the app, so the terminal, the task list and the
 * drawer produce byte-identical archives rather than three variations that drift apart. Bytes come
 * from the same short-lived storage URLs the viewer already uses, so this adds no server cost.
 *
 * A file that cannot be fetched fails the whole archive: a zip that silently contains nine of ten
 * files looks complete and is worse than an error, because nothing about it says what is missing.
 * Rows that never had content are a different case — they are reported in `skipped`, since no
 * fetch could ever recover them.
 */
export async function buildArtifactArchive(artifacts: readonly ArchivableArtifact[], options: ArchiveOptions = {}): Promise<ArchiveResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const downloadable = artifacts.filter((artifact) => artifact.url);
  const skipped = artifacts.filter((artifact) => !artifact.url).map((artifact) => artifact.path ?? artifact.kind);

  const entries: Array<{ path: string; data: Uint8Array; modified: Date }> = [];
  const queue = [...downloadable];
  let done = 0;

  // Bounded concurrency: a task can hold a few hundred artifacts, and firing every fetch at once
  // would stall the browser's connection pool and the UI along with it.
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 6, queue.length)) }, async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      const response = await fetchImpl(next.url!);
      if (!response.ok) throw new Error(`${next.path ?? next.kind} could not be read (${response.status})`);
      entries.push({ path: archivePathForArtifact(next), data: new Uint8Array(await response.arrayBuffer()), modified: new Date(next.createdAt) });
      done += 1;
      options.onProgress?.(done, downloadable.length);
    }
  });
  await Promise.all(workers);

  // Stable order inside the archive, which the concurrent fetches above do not preserve.
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return {
    bytes: await createZip(entries),
    // Named for what it holds: a Wander lab is a notebook, anything else is just the work.
    filename: archiveFilename(entries.some((entry) => entry.path.startsWith("wander/")) ? "wander lab" : "produced"),
    fileCount: entries.length,
    skipped,
  };
}

/** Hands the finished archive to the browser as a download. */
export function saveArchive(archive: ArchiveResult): void {
  const url = URL.createObjectURL(new Blob([archive.bytes as BlobPart], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = archive.filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
