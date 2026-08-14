import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SCROLLBACK_LINES,
  LineLog,
  OutputRouter,
  TabSink,
  replayLines,
  terminalStream,
  type OutputStream,
} from "./output";

function recorder(): OutputStream & { written: string[]; text: string } {
  const written: string[] = [];
  return {
    written,
    get text() {
      return written.join("");
    },
    write: (text: string) => void written.push(text),
    columns: 80,
  };
}

describe("the terminal sink", () => {
  afterEach(() => vi.restoreAllMocks());

  it("resolves stdout's write at call time, so headless mode's redirect still wins", () => {
    // --json replaces process.stdout.write to claim stdout for JSONL. A sink that captured the
    // method at module load would write straight past that and corrupt the machine-readable stream.
    const replacement = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    terminalStream.write("human prose\n");
    expect(replacement).toHaveBeenCalledWith("human prose\n");
  });

  it("reports the terminal's size as it is now, not as it was at construction", () => {
    // Read through on every access: a terminal is resizable, and a width captured once would be
    // wrong for the rest of a session that outlives a single SIGWINCH.
    const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", { value: 133, configurable: true });
    expect(terminalStream.columns).toBe(133);
    Object.defineProperty(process.stdout, "columns", { value: 90, configurable: true });
    expect(terminalStream.columns).toBe(90);
    if (original) Object.defineProperty(process.stdout, "columns", original);
    else delete (process.stdout as { columns?: number }).columns;
  });
});

describe("recording lines", () => {
  it("joins writes that do not end a line, which is how streamed text arrives", () => {
    const log = new LineLog();
    log.write("The ");
    log.write("answer");
    expect(log.size).toBe(0);
    expect(log.pending).toBe("The answer");
    log.write(" is 42.\n");
    expect(log.lines).toEqual(["The answer is 42."]);
    expect(log.pending).toBe("");
  });

  it("splits one write carrying several lines", () => {
    const log = new LineLog();
    log.write("one\ntwo\nthree\n");
    expect(log.lines).toEqual(["one", "two", "three"]);
  });

  it("keeps blank lines, which carry the spacing the transcript is laid out with", () => {
    const log = new LineLog();
    log.write("a\n\nb\n");
    expect(log.lines).toEqual(["a", "", "b"]);
  });

  it("preserves colour bytes exactly — a replay must look like the original, not a cleaned copy", () => {
    const log = new LineLog();
    log.write("\x1b[36mnova\x1b[0m\n");
    expect(log.lines).toEqual(["\x1b[36mnova\x1b[0m"]);
  });

  it("drops the oldest lines past its limit and counts what it dropped", () => {
    const log = new LineLog(3);
    for (const line of ["1", "2", "3", "4", "5"]) log.write(`${line}\n`);
    expect(log.lines).toEqual(["3", "4", "5"]);
    expect(log.dropped).toBe(2);
    expect(log.size).toBe(3);
  });

  it("commits a half-written line on flush, so nothing said is lost when a tab is left", () => {
    const log = new LineLog();
    log.write("still typing");
    log.flush();
    expect(log.lines).toEqual(["still typing"]);
    // Flushing twice must not duplicate it.
    log.flush();
    expect(log.lines).toEqual(["still typing"]);
  });

  it("returns the most recent lines, oldest first, and nothing for a non-positive count", () => {
    const log = new LineLog();
    log.write("a\nb\nc\n");
    expect(log.tail(2)).toEqual(["b", "c"]);
    expect(log.tail(99)).toEqual(["a", "b", "c"]);
    expect(log.tail(0)).toEqual([]);
  });

  it("has a scrollback deep enough to be worth calling one", () => {
    expect(DEFAULT_SCROLLBACK_LINES).toBeGreaterThanOrEqual(1_000);
  });
});

describe("a tab's sink", () => {
  it("passes everything through untouched while it is in front", () => {
    const terminal = recorder();
    const sink = new TabSink(terminal, { live: true });
    sink.write("\x1b[1mhello\x1b[0m\n");
    // Byte-identical: the whole reason the existing transcript tests still hold.
    expect(terminal.text).toBe("\x1b[1mhello\x1b[0m\n");
  });

  it("records but stays silent when it is not in front — the property tabs could not have before", () => {
    const terminal = recorder();
    const sink = new TabSink(terminal);
    sink.write("background work\n");
    expect(terminal.written).toEqual([]);
    expect(sink.log.lines).toEqual(["background work"]);
  });

  it("records the same lines whether or not anyone is watching", () => {
    const terminal = recorder();
    const front = new TabSink(terminal, { live: true });
    const back = new TabSink(terminal);
    for (const sink of [front, back]) sink.write("one\ntwo\n");
    expect(front.log.lines).toEqual(back.log.lines);
  });

  it("stops and resumes forwarding as it loses and regains the front", () => {
    const terminal = recorder();
    const sink = new TabSink(terminal, { live: true });
    sink.write("seen\n");
    sink.setLive(false);
    sink.write("unseen\n");
    sink.setLive(true);
    sink.write("seen again\n");
    expect(terminal.text).toBe("seen\nseen again\n");
    expect(sink.log.lines).toEqual(["seen", "unseen", "seen again"]);
  });

  it("commits its half-written line when it goes to the back", () => {
    const sink = new TabSink(recorder(), { live: true });
    sink.write("mid-sentence");
    sink.setLive(false);
    expect(sink.log.lines).toEqual(["mid-sentence"]);
  });

  it("reports the terminal's width, since a tab is laid out for the screen it will be shown on", () => {
    expect(new TabSink(recorder()).columns).toBe(80);
  });
});

describe("routing", () => {
  it("delivers to whichever sink is current, and loses nothing across a switch", () => {
    const first = recorder();
    const second = recorder();
    const router = new OutputRouter(first);
    router.write("to the first\n");
    router.route(second);
    router.write("to the second\n");
    expect(first.text).toBe("to the first\n");
    expect(second.text).toBe("to the second\n");
  });

  it("defaults to the terminal, so a session with no tabs behaves as it always did", () => {
    expect(new OutputRouter().current).toBe(terminalStream);
  });

  it("exposes the current target, which is what a tab switch re-points", () => {
    const sink = new TabSink(recorder());
    const router = new OutputRouter();
    router.route(sink);
    expect(router.current).toBe(sink);
    expect(router.columns).toBe(80);
  });
});

describe("replaying what a tab missed", () => {
  it("returns the tail and says how much was left above it", () => {
    const log = new LineLog();
    log.write("a\nb\nc\nd\n");
    expect(replayLines(log, 2)).toEqual({ lines: ["c", "d"], dropped: 0, omitted: 2 });
  });

  it("admits when the beginning is gone rather than implying the tab started there", () => {
    const log = new LineLog(2);
    log.write("a\nb\nc\n");
    const replay = replayLines(log, 10);
    expect(replay.lines).toEqual(["b", "c"]);
    expect(replay.dropped).toBe(1);
    expect(replay.omitted).toBe(0);
  });
});
