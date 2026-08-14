import { TabSink, type OutputStream } from "./output";

/**
 * A background job's output, as something you can subscribe to instead of sit inside.
 *
 * `/attach` reads a job's log in a loop and owns the prompt until you interrupt it — which makes
 * watching a job and doing anything else mutually exclusive, and makes a Wander run something you
 * either supervise or abandon. A stream is the other half: it pulls the same log into a sink of its
 * own, so the output accumulates whether or not anyone is looking at it, and looking at it is a
 * separate question from receiving it.
 *
 * The log is a file on *this* machine in every case, including `--sandbox e2b`. A job worker builds
 * its own `LocalWorkspace` (`job-worker.ts`) rather than inheriting the session's sandbox, so the
 * work runs here and reports here. That asymmetry is worth knowing about — see `sandboxWarning`.
 *
 * Polling, not watching: `fs.watch` reports a file changed without saying where, so the read that
 * follows is the same byte-offset read done here, and its behaviour across platforms and network
 * filesystems is inconsistent in exactly the situations a background job cares about. A half-second
 * poll on an append-only file costs a `stat` and a short read.
 */

export type JobLogChunk = { text: string; nextByte: number };
export type JobLogReader = (root: string, id: string, fromByte: number) => Promise<JobLogChunk>;

export type WatchedJobState = {
  status: string;
  pendingApproval?: { summary: string };
};
export type JobStateReader = (root: string, id: string) => Promise<WatchedJobState | undefined>;

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export type JobStreamDeps = {
  root: string;
  id: string;
  sink: OutputStream;
  readLog: JobLogReader;
  readState: JobStateReader;
  /** Decorates each line — a label, a colour. Identity by default. */
  format?: (line: string) => string;
  /** Called once when the job reaches a terminal status, for a notification the caller owns. */
  onFinished?: (status: string) => void;
  /** Called the first time a job parks on an approval, since only a person can answer one. */
  onApproval?: (summary: string) => void;
  intervalMs?: number;
};

export class JobStream {
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private finished = false;
  /** The approval already announced, so a job parked for a minute does not say so a hundred times. */
  private announcedApproval: string | undefined;
  private lastStatus = "";

  constructor(private readonly deps: JobStreamDeps) {}

  get id(): string {
    return this.deps.id;
  }

  get status(): string {
    return this.lastStatus;
  }

  get done(): boolean {
    return this.finished;
  }

  start(): void {
    if (this.timer || this.finished) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.deps.intervalMs ?? 500);
    // Never hold the process open for a job that outlives this terminal by design.
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass: everything new in the log, then the job's own state.
   *
   * Public because it is the whole behaviour, and a test that has to wait half a second per
   * assertion is a test nobody runs. A failed read is swallowed rather than propagated — the log
   * may not exist until the worker's first write, and a watcher that dies on that would be
   * unusable for exactly the first second of every job.
   */
  async poll(): Promise<void> {
    if (this.finished) return;
    try {
      const chunk = await this.deps.readLog(this.deps.root, this.deps.id, this.offset);
      if (chunk.text) {
        this.deps.sink.write(this.deps.format ? formatLines(chunk.text, this.deps.format) : chunk.text);
      }
      this.offset = chunk.nextByte;
    } catch {
      // The log is written by another process; a read that lands between create and first write
      // is ordinary, not an error worth reporting to a user who asked to watch a job.
    }

    let state: WatchedJobState | undefined;
    try {
      state = await this.deps.readState(this.deps.root, this.deps.id);
    } catch {
      return;
    }
    // A job that has vanished from the store is over as far as a watcher is concerned; treating it
    // as still running would leave a stream polling a file nothing will ever append to again.
    if (!state) { this.finish("gone"); return; }
    this.lastStatus = state.status;

    if (state.pendingApproval && state.pendingApproval.summary !== this.announcedApproval) {
      this.announcedApproval = state.pendingApproval.summary;
      this.deps.onApproval?.(state.pendingApproval.summary);
    } else if (!state.pendingApproval) {
      this.announcedApproval = undefined;
    }

    if (TERMINAL_STATUSES.has(state.status)) this.finish(state.status);
  }

  private finish(status: string): void {
    if (this.finished) return;
    this.finished = true;
    this.lastStatus = status;
    this.stop();
    this.deps.onFinished?.(status);
  }
}

/**
 * Applies a per-line decoration without inventing or losing a line break.
 *
 * A chunk read from a log is arbitrary bytes, not whole lines: the last one is very often a partial
 * line whose remainder arrives next poll. Decorating it as though it were complete would put a
 * label in the middle of a sentence, so a trailing fragment is passed through untouched and gets
 * its decoration when the newline that completes it arrives.
 */
export function formatLines(text: string, format: (line: string) => string): string {
  const parts = text.split("\n");
  const trailing = parts.pop() ?? "";
  const decorated = parts.map((line) => (line === "" ? "" : format(line)));
  return decorated.length === 0 ? trailing : `${decorated.join("\n")}\n${trailing}`;
}

export type WatchedJob = {
  stream: JobStream;
  sink: TabSink;
  /** What the job was asked to do, for the listing. */
  objective: string;
  startedAt: number;
};

/**
 * Every job currently being streamed.
 *
 * Keyed by job id so watching twice is watching once: two streams on one log would each read from
 * their own offset and print every line twice, which looks exactly like the agent doing everything
 * twice.
 */
export class WatchRegistry {
  private readonly watched = new Map<string, WatchedJob>();

  get size(): number {
    return this.watched.size;
  }

  has(id: string): boolean {
    return this.watched.has(id);
  }

  get(id: string): WatchedJob | undefined {
    return this.watched.get(id);
  }

  get all(): readonly WatchedJob[] {
    return [...this.watched.values()];
  }

  add(id: string, job: WatchedJob): WatchedJob {
    this.watched.set(id, job);
    return job;
  }

  stop(id: string): WatchedJob | undefined {
    const job = this.watched.get(id);
    if (!job) return undefined;
    job.stream.stop();
    this.watched.delete(id);
    return job;
  }

  /** Ends every stream — for session teardown, where a live interval would keep the process up. */
  stopAll(): void {
    for (const job of this.watched.values()) job.stream.stop();
    this.watched.clear();
  }
}

/**
 * What to tell someone starting a background job from a sandboxed session.
 *
 * A job worker constructs its own `LocalWorkspace`; it does not inherit the E2B or Docker sandbox
 * the interactive session is using. So "run this in the background" silently changes *where the
 * code runs* — from a throwaway remote machine to this one. That is the kind of surprise worth a
 * line of text every single time rather than a paragraph in a document nobody opens.
 */
export function sandboxWarning(backend: string): string | undefined {
  if (backend === "local") return undefined;
  return `background jobs run on this machine, not in the ${backend === "e2b" ? "E2B sandbox" : "container"} — the sandbox belongs to this session only`;
}
