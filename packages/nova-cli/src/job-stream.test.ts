import { describe, expect, it, vi } from "vitest";
import {
  JobStream,
  TERMINAL_STATUSES,
  WatchRegistry,
  formatLines,
  sandboxWarning,
  type JobLogReader,
  type JobStateReader,
} from "./job-stream";
import { TabSink } from "./output";

function fakeLog(chunks: string[]): { read: JobLogReader; appended: (text: string) => void } {
  let contents = chunks.join("");
  const read: JobLogReader = async (_root, _id, fromByte) => ({
    text: contents.slice(fromByte),
    nextByte: contents.length,
  });
  return { read, appended: (text: string) => { contents += text; } };
}

const state = (status: string, pendingApproval?: { summary: string }): JobStateReader =>
  async () => ({ status, ...(pendingApproval ? { pendingApproval } : {}) });

describe("streaming a job's log", () => {
  it("writes what is new and nothing that has already been written", async () => {
    const sink = new TabSink({ write: () => {} });
    const log = fakeLog(["first line\n"]);
    const stream = new JobStream({ root: "/repo", id: "j1", sink, readLog: log.read, readState: state("running") });

    await stream.poll();
    log.appended("second line\n");
    await stream.poll();

    expect(sink.log.lines).toEqual(["first line", "second line"]);
  });

  it("keeps accumulating while nobody is watching — the whole point of a stream", async () => {
    const terminal = { written: [] as string[], write: (text: string) => void terminal.written.push(text) };
    // A sink that is not live forwards nothing, but records everything.
    const sink = new TabSink(terminal);
    const log = fakeLog(["work happening\n"]);
    const stream = new JobStream({ root: "/repo", id: "j1", sink, readLog: log.read, readState: state("running") });

    await stream.poll();

    expect(terminal.written).toEqual([]);
    expect(sink.log.lines).toEqual(["work happening"]);
  });

  it("stops once the job is over, and says which way it went", async () => {
    const finished = vi.fn();
    const sink = new TabSink({ write: () => {} });
    const stream = new JobStream({
      root: "/repo", id: "j1", sink,
      readLog: fakeLog(["done\n"]).read,
      readState: state("completed"),
      onFinished: finished,
    });

    await stream.poll();
    expect(finished).toHaveBeenCalledWith("completed");
    expect(stream.done).toBe(true);

    // A finished stream does no further work, however often it is polled.
    const before = sink.log.size;
    await stream.poll();
    expect(sink.log.size).toBe(before);
  });

  it("treats a job that has left the store as over rather than polling a dead file forever", async () => {
    const finished = vi.fn();
    const stream = new JobStream({
      root: "/repo", id: "gone", sink: new TabSink({ write: () => {} }),
      readLog: fakeLog([]).read,
      readState: async () => undefined,
      onFinished: finished,
    });
    await stream.poll();
    expect(finished).toHaveBeenCalledWith("gone");
  });

  it("announces an approval once, not on every poll while it waits for an answer", async () => {
    const approval = vi.fn();
    const stream = new JobStream({
      root: "/repo", id: "j1", sink: new TabSink({ write: () => {} }),
      readLog: fakeLog([]).read,
      readState: state("running", { summary: "write to /etc/hosts" }),
      onApproval: approval,
    });

    await stream.poll();
    await stream.poll();
    await stream.poll();

    expect(approval).toHaveBeenCalledTimes(1);
    expect(approval).toHaveBeenCalledWith("write to /etc/hosts");
  });

  it("announces the next approval too, since a second question is a different question", async () => {
    const approval = vi.fn();
    let summary = "first action";
    const stream = new JobStream({
      root: "/repo", id: "j1", sink: new TabSink({ write: () => {} }),
      readLog: fakeLog([]).read,
      readState: async () => ({ status: "running", pendingApproval: { summary } }),
      onApproval: approval,
    });

    await stream.poll();
    summary = "second action";
    await stream.poll();

    expect(approval.mock.calls.map(([text]) => text)).toEqual(["first action", "second action"]);
  });

  it("survives a log that does not exist yet, which is every job's first moment", async () => {
    const sink = new TabSink({ write: () => {} });
    const stream = new JobStream({
      root: "/repo", id: "j1", sink,
      readLog: async () => { throw new Error("ENOENT"); },
      readState: state("queued"),
    });
    await expect(stream.poll()).resolves.toBeUndefined();
    expect(stream.done).toBe(false);
  });

  it("counts cancellation as an ending", () => {
    expect([...TERMINAL_STATUSES]).toEqual(expect.arrayContaining(["completed", "failed", "cancelled"]));
    expect(TERMINAL_STATUSES.has("running")).toBe(false);
  });
});

describe("decorating lines", () => {
  it("labels whole lines and leaves a partial one to be finished later", () => {
    // A chunk boundary lands mid-line constantly; labelling the fragment would put the label
    // inside a sentence when its remainder arrives.
    expect(formatLines("one\ntwo\nthr", (line) => `[j] ${line}`)).toBe("[j] one\n[j] two\nthr");
  });

  it("passes a lone fragment through untouched", () => {
    expect(formatLines("partial", (line) => `[j] ${line}`)).toBe("partial");
  });

  it("keeps blank lines blank rather than labelling nothing", () => {
    expect(formatLines("a\n\nb\n", (line) => `[j] ${line}`)).toBe("[j] a\n\n[j] b\n");
  });
});

describe("the registry", () => {
  const make = (id: string) => ({
    stream: new JobStream({
      root: "/repo", id, sink: new TabSink({ write: () => {} }),
      readLog: fakeLog([]).read, readState: state("running"),
    }),
    sink: new TabSink({ write: () => {} }),
    objective: `do ${id}`,
    startedAt: 0,
  });

  it("watches a job once, so its output is not printed twice", () => {
    const registry = new WatchRegistry();
    registry.add("j1", make("j1"));
    registry.add("j1", make("j1"));
    expect(registry.size).toBe(1);
    expect(registry.has("j1")).toBe(true);
  });

  it("stops one without disturbing the others", () => {
    const registry = new WatchRegistry();
    registry.add("j1", make("j1"));
    registry.add("j2", make("j2"));
    expect(registry.stop("j1")?.objective).toBe("do j1");
    expect(registry.stop("nope")).toBeUndefined();
    expect(registry.all.map((job) => job.objective)).toEqual(["do j2"]);
  });

  it("stops everything, so a live poll cannot keep the session from exiting", () => {
    const registry = new WatchRegistry();
    registry.add("j1", make("j1"));
    registry.stopAll();
    expect(registry.size).toBe(0);
  });
});

describe("where a background job actually runs", () => {
  it("says nothing when the session was local anyway", () => {
    expect(sandboxWarning("local")).toBeUndefined();
  });

  it("warns that the sandbox is not inherited, because that changes where code executes", () => {
    // job-worker.ts builds its own LocalWorkspace; a detached task from an E2B session runs here.
    expect(sandboxWarning("e2b")).toContain("this machine");
    expect(sandboxWarning("e2b")).toContain("E2B");
    expect(sandboxWarning("docker")).toContain("container");
  });
});
