import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import {
  activityLabel,
  box,
  CountdownTimer,
  formatCountdown,
  formatStatusLine,
  formatHeaderSegments,
  formatTokens,
  MarkdownStream,
  novaSpinnerFrame,
  stepProgress,
  joinHorizontal,
  padToWidth,
  paginator,
  progressBar,
  PromptBox,
  PROMPT_PREFIX_COLUMNS,
  promptStatusRoom,
  renderPromptBox,
  ReplaceableBlock,
  rowsOccupied,
  scrollIndicator,
  scrollPercent,
  sliceToWidth,
  sparkline,
  Spinner,
  Spring,
  SpringAnimator,
  StatusBar,
  table,
  thinkingVerb,
  wrappedRemainder,
  wrapPlain,
} from "./tui";

const ESCAPE = /\x1b\[[0-9;]*m/g;
const plain = (value: string) => value.replace(ESCAPE, "");

/** A stdout stand-in that records exactly what would have reached the terminal. */
function fakeStream(columns = 80) {
  const writes: string[] = [];
  const stream = {
    columns,
    write: (chunk: unknown) => { writes.push(String(chunk)); return true; },
  } as unknown as NodeJS.WriteStream;
  return { stream, writes, output: () => writes.join("") };
}

describe("status line", () => {
  const fields = { mode: "build", spinnerGlyph: "✦", elapsedMs: 4_200, toolCalls: 3, tokens: 1_200, cost: "$0.0120" };

  it("shows what it is doing, plus mode, tools, tokens, elapsed and cost when there is room", () => {
    const line = plain(formatStatusLine(fields, 80, "none"));
    expect(line).toContain("…"); // a verb, so the line reads as activity rather than as a label
    expect(line).toContain("build");
    expect(line).toContain("3 tools");
    expect(line).toContain("1.2k tokens");
    expect(line).toContain("4.2s");
    expect(line).toContain("$0.0120");
  });

  it("never exceeds the width it was given, at any width", () => {
    for (const width of [4, 10, 20, 40, 60, 80, 120]) {
      const line = plain(formatStatusLine(fields, width, "none"));
      expect(line.length, `width ${width}`).toBeLessThanOrEqual(width);
    }
  });

  it("gives up cost first and elapsed time last, because elapsed answers 'is it still going'", () => {
    const narrow = plain(formatStatusLine(fields, 26, "none"));
    expect(narrow).not.toContain("$0.0120");
    expect(narrow).toContain("4.2s");
  });

  it("keeps only the verb when even the elapsed time will not fit", () => {
    const tiny = plain(formatStatusLine(fields, 12, "none"));
    expect(tiny).toContain("…");
    expect(tiny.length).toBeLessThanOrEqual(12);
  });

  it("pluralizes a single tool call correctly", () => {
    const one = plain(formatStatusLine({ ...fields, toolCalls: 1 }, 80, "none"));
    expect(one).toContain("1 tool ");
    expect(one).not.toContain("1 tools");
  });

  it("omits the tool count and token count entirely before there is anything to count", () => {
    const none = plain(formatStatusLine({ ...fields, toolCalls: 0, tokens: 0 }, 80, "none"));
    expect(none).not.toContain("tools");
    expect(none).not.toContain("tokens");
  });

  it("formats elapsed time in minutes once it crosses a minute", () => {
    expect(plain(formatStatusLine({ ...fields, elapsedMs: 75_000 }, 80, "none"))).toContain("1m 15s");
  });

  it("emits colour only when colour was asked for", () => {
    expect(formatStatusLine(fields, 80, "none")).not.toMatch(ESCAPE);
    expect(formatStatusLine(fields, 80, "truecolor")).toMatch(ESCAPE);
  });

  it("keeps the confirmed balance ahead of less important running detail", () => {
    const wide = plain(formatStatusLine({ ...fields, balance: "1,240 RWF left" }, 100, "none"));
    expect(wide).toContain("1,240 RWF left");
    const narrow = plain(formatStatusLine({ ...fields, balance: "1,240 RWF left" }, 48, "none"));
    expect(narrow).toContain("1,240 RWF left");
    expect(narrow).not.toContain("$0.0120");
  });
});

describe("persistent header segments", () => {
  const segments = [
    { full: "balance 1,240 RWF left", compact: "1.2k RWF" },
    { full: "build" },
    { full: "$0.0120" },
  ];

  it("keeps every fact when it fits and drops from the least important end", () => {
    expect(formatHeaderSegments(segments, 80)).toBe("balance 1,240 RWF left · build · $0.0120");
    expect(formatHeaderSegments(segments, 30)).toBe("balance 1,240 RWF left · build");
  });

  it("uses the compact balance before surrendering the header, without overflowing", () => {
    expect(formatHeaderSegments(segments, 10)).toBe("1.2k RWF");
    expect(formatHeaderSegments(segments, 4)).toBe("");
  });
});

describe("formatTokens", () => {
  it("counts exactly below a thousand and abbreviates above it", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
    expect(formatTokens(1_200)).toBe("1.2k tokens");
    expect(formatTokens(45_600)).toBe("45.6k tokens");
  });
});

describe("sparkline", () => {
  it("is empty for an empty series", () => {
    expect(sparkline([])).toBe("");
  });

  it("scales to the series' own maximum, not an absolute one", () => {
    expect(sparkline([0, 5, 10])).toBe(sparkline([0, 50, 100]));
  });

  it("reads flat when every value is the same", () => {
    expect(new Set([...sparkline([3, 3, 3])]).size).toBe(1);
  });

  it("does not divide by zero when the whole series is zero", () => {
    expect(sparkline([0, 0, 0])).toHaveLength(3);
  });

  it("rises left to right for a rising series", () => {
    const levels = UNICODE_GLYPHS.sparkLevels;
    const indices = [...sparkline([1, 2, 3, 4])].map((glyph) => levels.indexOf(glyph));
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    expect(indices[0]).toBeLessThan(indices.at(-1)!);
  });

  it("stays in the ASCII set when given the ASCII glyph set", () => {
    const line = sparkline([1, 5, 2], ASCII_GLYPHS);
    for (const character of line) expect(character.codePointAt(0)).toBeLessThan(128);
  });
});

describe("progressBar", () => {
  it("draws an empty track at 0% and a fully filled bar at 100%, both at the requested width", () => {
    const empty = plain(progressBar(0, 10, { depth: "none" }));
    const full = plain(progressBar(1, 10, { depth: "none" }));
    expect(visibleWidth(empty)).toBe(10);
    expect(visibleWidth(full)).toBe(10);
    expect(empty).toBe("░".repeat(10));
    expect(full).toBe("█".repeat(10));
  });

  it("clamps a fraction outside 0..1 rather than drawing past the bar's own ends", () => {
    expect(plain(progressBar(-0.5, 8, { depth: "none" }))).toBe(plain(progressBar(0, 8, { depth: "none" })));
    expect(plain(progressBar(1.5, 8, { depth: "none" }))).toBe(plain(progressBar(1, 8, { depth: "none" })));
  });

  it("treats a non-finite fraction as empty rather than throwing or drawing garbage", () => {
    expect(plain(progressBar(Number.NaN, 8, { depth: "none" }))).toBe(plain(progressBar(0, 8, { depth: "none" })));
  });

  it("lands a fraction inside a cell at sub-character precision, not just on whole blocks", () => {
    // 37% of 10 cells is 3.7 — neither 3 nor 4 whole blocks alone is the honest answer.
    const rendered = plain(progressBar(0.37, 10, { depth: "none" }));
    expect(rendered).not.toBe(plain(progressBar(0.3, 10, { depth: "none" })));
    expect(rendered).not.toBe(plain(progressBar(0.4, 10, { depth: "none" })));
    expect(rendered.slice(0, 3)).toBe("███");
    expect(rendered.slice(4)).toBe("░".repeat(6));
  });

  it("paints nothing when colour is off, and something when it is on", () => {
    expect(progressBar(0.5, 10, { depth: "none" })).not.toMatch(ESCAPE);
    expect(progressBar(0.5, 10, { depth: "truecolor" })).toMatch(ESCAPE);
  });

  it("only ever draws whole ASCII cells on an ASCII terminal, never a fractional block", () => {
    const rendered = progressBar(0.37, 10, { depth: "none", glyphs: ASCII_GLYPHS });
    for (const character of rendered) expect(character.codePointAt(0)).toBeLessThan(128);
    expect(rendered).toBe("####------");
  });

  it("shows more of the gradient as the fraction grows, since the gradient runs across the whole width", () => {
    // A 10% bar exposes only cells near the gradient's cool end; run its colours forward and a
    // deeply-filled bar's tail should reach further toward the warm end than a barely-filled one's.
    const low = progressBar(0.2, 20, { depth: "truecolor" });
    const high = progressBar(0.9, 20, { depth: "truecolor" });
    const lastColorOf = (rendered: string) => [...rendered.matchAll(/38;2;(\d+);(\d+);(\d+)m/g)].at(-1);
    const lowEnd = lastColorOf(low)!;
    const highEnd = lastColorOf(high)!;
    // The default gradient runs blue (high blue channel) toward warm (low blue channel).
    expect(Number(highEnd[3])).toBeLessThan(Number(lowEnd[3]));
  });
});

describe("table", () => {
  it("widens each column to fit its widest cell, header included", () => {
    const rendered = plain(table(["name", "note"], [["a", "short"], ["much longer name", "x"]], { depth: "none" }));
    const lines = rendered.split("\n");
    // Every row (borders included) is the same length — the whole point of a fixed grid.
    const widths = new Set(lines.map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
    expect(lines[0]).toMatch(/^╭─+╮$/);
  });

  it("separates the header from the body with a rule that lines up with the vertical rules", () => {
    const rendered = plain(table(["a", "b"], [["1", "2"]], { depth: "none" }));
    const lines = rendered.split("\n");
    // top, header, separator, one body row, bottom
    expect(lines).toHaveLength(5);
    expect(lines[2]).toMatch(/^├─+┼─+┤$/);
  });

  it("renders an empty body as header and rules only, without throwing", () => {
    const rendered = table(["only"], [], { depth: "none" });
    expect(rendered.split("\n")).toHaveLength(4); // top, header, separator, bottom
  });

  it("pads a short cell out to the column width rather than leaving ragged rows", () => {
    const rendered = plain(table(["col"], [["a"], ["bb"], ["ccc"]], { depth: "none" }));
    const bodyLines = rendered.split("\n").slice(3, -1);
    const widths = new Set(bodyLines.map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });

  it("shrinks the widest column first when the table would not otherwise fit", () => {
    const rendered = plain(table(["short", "very long column that dominates the row"], [["x", "y"]], { depth: "none", width: 30 }));
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(30);
  });

  it("does not leak escape codes when colour is off, but does when it is on", () => {
    expect(table(["a"], [["1"]], { depth: "none" })).not.toMatch(ESCAPE);
    expect(table(["a"], [["1"]], { depth: "truecolor" })).toMatch(ESCAPE);
  });

  it("draws double-lined borders when asked, distinct from the default round style", () => {
    const rendered = table(["a"], [["1"]], { depth: "none", borderStyle: "double" });
    expect(rendered).toMatch(/^╔/);
    expect(rendered).toContain("║");
  });

  it("stays inside ASCII on an ASCII terminal", () => {
    const rendered = table(["a"], [["1"]], { depth: "none", glyphs: ASCII_GLYPHS });
    for (const character of rendered) expect(character.codePointAt(0)).toBeLessThan(128);
  });
});

describe("scrollPercent and scrollIndicator", () => {
  it("reports fully shown when the content already fits the viewport", () => {
    expect(scrollPercent(0, 5, 10)).toBe(1);
    expect(scrollIndicator(scrollPercent(0, 5, 10))).toBe("Bot");
  });

  it("reports 0 at the very first line and 1 at the last possible position", () => {
    expect(scrollPercent(0, 100, 10)).toBe(0);
    expect(scrollPercent(90, 100, 10)).toBe(1);
    expect(scrollIndicator(0)).toBe("Top");
    expect(scrollIndicator(1)).toBe("Bot");
  });

  it("rounds to a percentage in between, never showing Top or Bot for a mid-scroll position", () => {
    const fraction = scrollPercent(45, 100, 10); // 45 / (100 - 10) = 50%
    expect(fraction).toBeCloseTo(0.5);
    expect(scrollIndicator(fraction)).toBe("50%");
  });

  it("clamps an out-of-range offset instead of reporting past either end", () => {
    expect(scrollPercent(-5, 100, 10)).toBe(0);
    expect(scrollPercent(9_999, 100, 10)).toBe(1);
  });
});

describe("paginator", () => {
  it("shows a one-based position among a count, arabic style by default", () => {
    expect(paginator(0, 42)).toBe("1/42");
    expect(paginator(11, 42)).toBe("12/42");
    expect(paginator(41, 42)).toBe("42/42");
  });

  it("clamps an out-of-range position instead of showing a nonsense one", () => {
    expect(paginator(-5, 10)).toBe("1/10");
    expect(paginator(999, 10)).toBe("10/10");
  });

  it("never reports a count below 1, so a list that turns out empty still renders", () => {
    expect(paginator(0, 0)).toBe("1/1");
  });

  it("marks the current page with a solid dot in dot style, the rest with a plain one", () => {
    expect(paginator(1, 3, { style: "dots" })).toBe("· • ·");
  });
});

describe("thinkingVerb", () => {
  it("holds a word for several seconds rather than flickering every frame", () => {
    expect(thinkingVerb(0)).toBe(thinkingVerb(5_999));
    expect(thinkingVerb(0)).not.toBe(thinkingVerb(6_000));
  });

  it("cycles rather than running out, however long the turn takes", () => {
    expect(thinkingVerb(10 * 60_000)).toBeTruthy();
    expect(thinkingVerb(-1)).toBe(thinkingVerb(0));
  });
});

describe("Nova activity", () => {
  it("pulses within a fixed width so its label never jitters", () => {
    const frames = Array.from({ length: 12 }, (_unused, index) => novaSpinnerFrame(index));
    expect(new Set(frames).size).toBeGreaterThan(3);
    expect(new Set(frames.map((frame) => visibleWidth(frame)))).toEqual(new Set([5]));
    expect(frames.join("")).toContain("✶");
  });

  it("falls back safely for invalid frame indexes", () => {
    expect(novaSpinnerFrame(Number.NaN)).toBe(novaSpinnerFrame(0));
    expect(novaSpinnerFrame(-4)).toBe(novaSpinnerFrame(0));
  });

  it("names common operations without exposing their arguments", () => {
    expect(activityLabel("operation", "run_command", 0)).toBe("Running command");
    expect(activityLabel("operation", "web_search", 0)).toBe("Searching the web");
    expect(activityLabel("operation", "unknown_tool", 0)).toBe("Running operation");
    expect(activityLabel("thinking", undefined, 0)).toBe("Thinking");
  });

  it("shows the operation phase in the status line", () => {
    const line = formatStatusLine({ mode: "build", spinnerGlyph: novaSpinnerFrame(3), elapsedMs: 4_200, toolCalls: 1, tokens: 1_200, cost: "$0.0120", phase: "operation", operation: "edit_file" }, 80, "none");
    expect(line).toContain("Editing workspace…");
    expect(line).not.toContain("Thinking");
  });
});

describe("rowsOccupied", () => {
  it("counts the rows a line wraps onto, and gives an empty line one", () => {
    expect(rowsOccupied("", 80)).toBe(1);
    expect(rowsOccupied("x".repeat(80), 80)).toBe(1);
    expect(rowsOccupied("x".repeat(81), 80)).toBe(2);
    expect(rowsOccupied("x".repeat(200), 80)).toBe(3);
  });

  it("ignores escape codes, which occupy no columns", () => {
    expect(rowsOccupied("\x1b[1m" + "x".repeat(10) + "\x1b[0m", 80)).toBe(1);
  });
});

describe("StatusBar", () => {
  it("clears exactly the line it drew, and nothing before it was ever drawn", () => {
    const { stream, writes } = fakeStream();
    const bar = new StatusBar(stream);

    bar.clear(); // nothing drawn yet — must be a no-op
    expect(writes).toHaveLength(0);

    bar.render({ mode: "build", spinnerGlyph: "✦", elapsedMs: 0, toolCalls: 0, tokens: 0, cost: "$0" }, "none");
    expect(writes).toHaveLength(1);

    bar.clear();
    expect(writes[1]).toBe("\x1b[1A\x1b[2K");

    bar.clear(); // already cleared — must be a no-op, not a second erase
    expect(writes).toHaveLength(2);
  });
});

describe("ReplaceableBlock", () => {
  it("rewrites a line in place instead of printing a second one", () => {
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);

    const line = block.append("⋯ run_command  npm test");
    expect(writes).toEqual(["⋯ run_command  npm test\n"]);

    expect(block.update(line, "✓ run_command  npm test · exit 0")).toBe(true);
    expect(writes[1]).toBe("\x1b[1A\x1b[2K"); // one row up, erased
    expect(writes.at(-1)).toBe("✓ run_command  npm test · exit 0\n");
  });

  it("rewrites the right line when several calls were announced before any returned", () => {
    // The runtime issues read-only tools in parallel, so the line to rewrite is usually not the
    // last one printed — the case a single replaceable line cannot express at all.
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    const first = block.append("⋯ list_files  .");
    const second = block.append("⋯ read_file  hello.py");

    block.update(second, "✓ read_file  hello.py · 1 line");
    expect(writes.at(-2)).toBe("⋯ list_files  .\n"); // the still-running call is redrawn as-is
    expect(writes.at(-1)).toBe("✓ read_file  hello.py · 1 line\n");

    block.update(first, "✓ list_files  . · 2 entries");
    expect(writes.at(-2)).toBe("✓ list_files  . · 2 entries\n");
    expect(writes.at(-1)).toBe("✓ read_file  hello.py · 1 line\n");
  });

  it("erases every row the block occupied, including lines that wrapped", () => {
    const { stream, writes } = fakeStream(20);
    const block = new ReplaceableBlock(stream, () => 20);
    const line = block.append("x".repeat(45)); // three rows at twenty columns
    block.append("short");                     // one more
    writes.length = 0;
    block.update(line, "done");
    expect(writes.filter((chunk) => chunk === "\x1b[1A\x1b[2K")).toHaveLength(4);
  });

  it("refuses to rewrite once something else has printed", () => {
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    const line = block.append("⋯ read_file  a.ts");
    block.forget();
    expect(block.active).toBe(false);
    expect(block.update(line, "✓ read_file  a.ts")).toBe(false);
    expect(writes).toHaveLength(1); // nothing was written over the transcript
  });

  it("refuses a handle it never issued", () => {
    const { stream } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    expect(block.update(0, "x")).toBe(false);
    block.append("a");
    expect(block.update(5, "x")).toBe(false);
    expect(block.update(-1, "x")).toBe(false);
  });

  it("updateAll rewrites every line in a single redraw, not one redraw per line", () => {
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    block.append("one");
    block.append("two");
    block.append("three");
    writes.length = 0;

    block.updateAll(["1", "2", "3"]);
    // Erases exactly the three rows the block occupied, once — not three separate erase-and-reprint
    // passes the way three individual `update()` calls would produce.
    expect(writes.filter((chunk) => chunk === "\x1b[1A\x1b[2K")).toHaveLength(3);
    expect(writes.slice(-3)).toEqual(["1\n", "2\n", "3\n"]);
  });

  it("updateAll leaves an entry alone when fewer texts are given than there are lines", () => {
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    block.append("one");
    block.append("two");
    writes.length = 0;

    block.updateAll(["1"]);
    expect(writes.slice(-2)).toEqual(["1\n", "two\n"]);
  });

  it("updateAll ignores extra texts beyond the lines the block already holds", () => {
    const { stream, writes } = fakeStream();
    const block = new ReplaceableBlock(stream, () => 80);
    block.append("one");
    writes.length = 0;

    expect(() => block.updateAll(["1", "2", "3"])).not.toThrow();
    expect(writes.at(-1)).toBe("1\n");
    expect(writes.filter((chunk) => chunk === "1\n" || chunk === "2\n" || chunk === "3\n")).toEqual(["1\n"]);
  });
});

describe("MarkdownStream", () => {
  it("writes text raw as it arrives, so the session reads as live", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("Hello");
    expect(writes).toEqual(["Hello"]);
    expect(markdown.active).toBe(true);
  });

  it("re-renders the line as markdown the moment it is whole", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("Changed **the port**");
    markdown.push(" to `8080`\n");

    // The raw text went out first, was erased, and the styled line replaced it.
    expect(writes[0]).toBe("Changed **the port**");
    expect(writes).toContain("\r\x1b[2K");
    expect(writes.at(-1)).toBe("Changed the port to 8080\n");
    expect(markdown.active).toBe(false);
  });

  it("erases every row the raw partial line wrapped onto", () => {
    const { stream, writes } = fakeStream(20);
    const markdown = new MarkdownStream(stream, "none", () => 20);
    markdown.push("y".repeat(45)); // three rows at twenty columns
    markdown.push("\n");
    expect(writes.filter((chunk) => chunk === "\x1b[1A\x1b[2K")).toHaveLength(2); // plus the \r-clear
    expect(writes).toContain("\r\x1b[2K");
  });

  it("keeps a blank line blank rather than swallowing the paragraph break", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("one\n\ntwo\n");
    expect(writes.filter((chunk) => chunk === "\n")).toHaveLength(1);
    expect(writes.at(-1)).toBe("two\n");
  });

  it("renders a heading and a bullet list arriving in fragments", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);

    // Asserted on the write that survives the erase, not on the concatenation of every write:
    // the raw fragments are deliberately written first and then cleared, so the raw form appears
    // in the byte stream and is precisely what is no longer on screen.
    markdown.push("## Res");
    markdown.push("ult\n");
    expect(writes.at(-1)).toBe("Result\n"); // the hashes were consumed by the renderer

    markdown.push("- first");
    markdown.push(" thing\n");
    expect(writes.at(-1)).toBe("• first thing\n");
  });

  it("finalizes a trailing partial line when the turn ends", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("no newline at the end");
    markdown.end();
    expect(markdown.active).toBe(false);
    expect(writes.at(-1)).toBe("no newline at the end\n");
  });

  it("does nothing on end() when no partial line is pending", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.end();
    expect(writes).toHaveLength(0);
  });

  it("forgets an unclosed code fence between turns, so it cannot colour the next answer", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("```ts\n");
    markdown.reset();
    markdown.push("ordinary **prose**\n");
    expect(writes.at(-1)).toBe("ordinary prose\n"); // styled as prose, not gutter-marked as code
  });

  it("closes an unclosed code fence when the streamed answer ends", () => {
    const { stream, writes } = fakeStream();
    const markdown = new MarkdownStream(stream, "none", () => 80);
    markdown.push("```ts\nconst x = 1;");
    markdown.end();
    // Matched by its corner: the closing rule is now drawn to the same length as the opening one,
    // so a fixed stub width is no longer what "visually closed" means.
    expect(writes.join("")).toMatch(/╰─{4,}/);
    expect(markdown.active).toBe(false);
  });

  it("emits colour when the terminal has it", () => {
    const { stream, output } = fakeStream();
    const markdown = new MarkdownStream(stream, "truecolor", () => 80);
    markdown.push("**bold**\n");
    expect(output()).toMatch(ESCAPE);
  });
});

describe("Spinner", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cycles through frames on a tick, and reports the current one via glyph", () => {
    const spinner = new Spinner(() => {}, 100);
    const first = spinner.glyph;
    spinner.start();
    vi.advanceTimersByTime(100);
    expect(spinner.glyph).not.toBe(first);
    const second = spinner.glyph;
    vi.advanceTimersByTime(100);
    expect(spinner.glyph).not.toBe(second);
  });

  it("calls onTick exactly once per interval", () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 50);
    spinner.start();
    vi.advanceTimersByTime(220);
    expect(ticks).toBe(5); // immediate paint, then four interval ticks
  });

  it("does not tick after being stopped", () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 50);
    spinner.start();
    vi.advanceTimersByTime(100);
    const afterTwoTicks = ticks;
    spinner.stop();
    vi.advanceTimersByTime(200);
    expect(ticks).toBe(afterTwoTicks);
  });

  it("starting twice does not double the tick rate", () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 50);
    spinner.start();
    spinner.start();
    vi.advanceTimersByTime(100);
    expect(ticks).toBe(3); // one immediate paint and two interval ticks, still only one timer
  });

  it("stopping before ever starting is a safe no-op", () => {
    const spinner = new Spinner(() => {});
    expect(() => spinner.stop()).not.toThrow();
  });
});

describe("formatCountdown", () => {
  it("shows plain seconds under a minute", () => {
    expect(formatCountdown(6_000)).toBe("6s");
    expect(formatCountdown(500)).toBe("1s"); // rounds up: 1ms left still reads as "about to happen", not "done"
    expect(formatCountdown(0)).toBe("0s");
  });

  it("switches to minutes and seconds at a minute", () => {
    expect(formatCountdown(65_000)).toBe("1m 05s");
    expect(formatCountdown(125_000)).toBe("2m 05s");
  });

  it("never shows negative time", () => {
    expect(formatCountdown(-500)).toBe("0s");
  });
});

describe("CountdownTimer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks once immediately with the full duration, then once per interval", () => {
    const ticks: number[] = [];
    new CountdownTimer(3_000, (remaining) => ticks.push(remaining), () => {}, 1_000).start();
    expect(ticks).toEqual([3_000]);
    vi.advanceTimersByTime(1_000);
    expect(ticks).toEqual([3_000, 2_000]);
  });

  it("calls onDone exactly once when the duration elapses, not onTick with a negative remainder", () => {
    const ticks: number[] = [];
    let done = 0;
    new CountdownTimer(2_000, (remaining) => ticks.push(remaining), () => { done += 1; }, 1_000).start();
    vi.advanceTimersByTime(5_000); // well past the end — must not keep ticking or double-fire onDone
    expect(done).toBe(1);
    expect(ticks.every((value) => value >= 0)).toBe(true);
  });

  it("fires onDone immediately for a duration that has already elapsed", () => {
    let done = 0;
    new CountdownTimer(0, () => {}, () => { done += 1; }).start();
    expect(done).toBe(1);
  });

  it("stops ticking once stopped, and stopping before starting is a safe no-op", () => {
    const timer = new CountdownTimer(5_000, () => {}, () => {}, 1_000);
    expect(() => timer.stop()).not.toThrow();
    let ticks = 0;
    const running = new CountdownTimer(5_000, () => { ticks += 1; }, () => {}, 1_000);
    running.start();
    running.stop();
    const afterStop = ticks;
    vi.advanceTimersByTime(3_000);
    expect(ticks).toBe(afterStop);
  });
});

describe("Spring", () => {
  it("moves toward the target, never past it, for a critically-damped spring starting at rest", () => {
    const spring = new Spring(18, 1);
    let position = 0;
    let velocity = 0;
    for (let step = 0; step < 200; step += 1) {
      [position, velocity] = spring.update(position, velocity, 10, 1 / 60);
      expect(position).toBeLessThanOrEqual(10.0001); // no overshoot at critical damping
    }
    expect(position).toBeCloseTo(10, 2);
  });

  it("overshoots and settles for an under-damped spring, unlike a critically-damped one", () => {
    const under = new Spring(18, 0.3);
    let position = 0;
    let velocity = 0;
    let overshot = false;
    for (let step = 0; step < 200; step += 1) {
      [position, velocity] = under.update(position, velocity, 10, 1 / 60);
      if (position > 10) overshot = true;
    }
    expect(overshot).toBe(true);
    expect(position).toBeCloseTo(10, 1);
  });

  it("stays stable at a coarse timestep, the property a naive Euler integrator lacks", () => {
    // A terminal redraw tick is tens of milliseconds, not a 60fps frame — this is the actual
    // operating regime, and the whole reason a closed-form integrator was used instead of x += v*dt.
    const spring = new Spring(18, 0.86);
    let position = 0;
    let velocity = 0;
    for (let step = 0; step < 50; step += 1) [position, velocity] = spring.update(position, velocity, 5, 0.1);
    expect(Number.isFinite(position)).toBe(true);
    expect(position).toBeCloseTo(5, 1);
  });

  it("is exactly implicit Euler — the integrator it claims to be, not merely something spring-shaped", () => {
    // Derived independently from the backward-Euler equations rather than copied from the source
    // under test, so this fails if that implementation drifts into a different scheme:
    //   v' = [v - dt·w²·(x - target)] / (1 + 2·z·w·dt + dt²·w²)      x' = x + dt·v'
    const reference = (x: number, v: number, target: number, dt: number, w: number, z: number): [number, number] => {
      const determinant = 1 + 2 * z * w * dt + dt * dt * w * w;
      const velocity = (v - dt * w * w * (x - target)) / determinant;
      return [x + dt * velocity, velocity];
    };
    const spring = new Spring(18, 0.86);
    let [ax, av] = [0, 0];
    let [bx, bv] = [0, 0];
    for (let step = 0; step < 200; step += 1) {
      [ax, av] = spring.update(ax, av, 10, 1 / 60);
      [bx, bv] = reference(bx, bv, 10, 1 / 60, 18, 0.86);
      expect(ax).toBeCloseTo(bx, 10);
      expect(av).toBeCloseTo(bv, 10);
    }
  });

  it("converges rather than diverging at a timestep far past anything a terminal would produce", () => {
    // The one property the implicit form is chosen for. Forward Euler blows up here; this must not.
    const spring = new Spring(18, 0.86);
    for (const dt of [0.1, 0.5, 2, 10]) {
      let [position, velocity] = [0, 0];
      for (let step = 0; step < 500; step += 1) [position, velocity] = spring.update(position, velocity, 5, dt);
      expect(Number.isFinite(position), `dt ${dt}`).toBe(true);
      expect(position, `dt ${dt}`).toBeCloseTo(5, 3);
    }
  });

  it("does nothing when already at the target with no velocity", () => {
    const spring = new Spring(18, 1);
    const [position, velocity] = spring.update(5, 0, 5, 1 / 60);
    expect(position).toBeCloseTo(5, 5);
    expect(velocity).toBeCloseTo(0, 5);
  });
});

describe("SpringAnimator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("ticks toward the target and eventually settles exactly on it", () => {
    const values: number[] = [];
    const animator = new SpringAnimator(0, (value) => values.push(value), { intervalMs: 40 });
    animator.retarget(10);
    vi.advanceTimersByTime(40 * 40); // generous — the point is it settles, not exactly when
    expect(values.at(-1)).toBe(10);
    expect(animator.settled).toBe(true);
  });

  it("settles immediately without starting a timer when already within epsilon of the target", () => {
    let ticks = 0;
    const spy = new SpringAnimator(0, () => { ticks += 1; }, { intervalMs: 40 });
    spy.retarget(0.001); // already within epsilon of 0
    expect(ticks).toBe(1); // one notification that it's there, no timer running
    expect(spy.settled).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(1); // nothing further ticks — there was never a timer to fire
  });

  it("stops calling onTick once it settles from a real animation, rather than ticking forever", () => {
    let ticks = 0;
    const animator = new SpringAnimator(0, () => { ticks += 1; }, { intervalMs: 40 });
    animator.retarget(10);
    vi.advanceTimersByTime(40 * 40);
    expect(animator.settled).toBe(true);
    const afterSettling = ticks;
    vi.advanceTimersByTime(1_000);
    expect(ticks).toBe(afterSettling);
  });

  it("redirects from wherever it currently is, without resetting to the old position", () => {
    const values: number[] = [];
    const animator = new SpringAnimator(0, (value) => values.push(value), { intervalMs: 40 });
    animator.retarget(10);
    vi.advanceTimersByTime(40 * 3); // partway there, not settled
    const midpoint = values.at(-1)!;
    expect(midpoint).toBeGreaterThan(0);
    expect(midpoint).toBeLessThan(10);
    animator.retarget(20); // redirected before reaching 10
    vi.advanceTimersByTime(40); // the very next tick
    // The next tick starts from the midpoint already reached, not from 0 or from 10.
    expect(values.at(-1)).toBeGreaterThanOrEqual(midpoint);
  });

  it("snapTo jumps immediately and stops any animation in flight", () => {
    const values: number[] = [];
    const animator = new SpringAnimator(0, (value) => values.push(value), { intervalMs: 40 });
    animator.retarget(10);
    vi.advanceTimersByTime(40 * 3);
    animator.snapTo(50);
    expect(values.at(-1)).toBe(50);
    expect(animator.value).toBe(50);
    expect(animator.settled).toBe(true);
    const countAfterSnap = values.length;
    vi.advanceTimersByTime(1_000);
    expect(values.length).toBe(countAfterSnap); // nothing further ticks after a snap
  });
});

describe("box", () => {
  it("sizes itself to the longest line, not the terminal width", () => {
    const rendered = plain(box(["short", "a rather longer line here"], { width: 80, depth: "none" }));
    const lines = rendered.split("\n");
    expect(new Set(lines.map((line) => visibleWidth(line))).size).toBe(1);
    expect(visibleWidth(lines[0])).toBeLessThan(40);
  });

  it("never exceeds the terminal width even when content is longer", () => {
    const rendered = plain(box(["x".repeat(200)], { width: 40, depth: "none" }));
    for (const line of rendered.split("\n")) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("truncates an over-long line rather than wrapping or overflowing the box", () => {
    expect(plain(box(["x".repeat(200)], { width: 40, depth: "none" }))).toContain("…");
  });

  it("keeps its borders aligned when the content is double-width", () => {
    // Padding by character count rather than by column leaves the right border short here.
    const rendered = plain(box(["日本語のテキスト", "ascii"], { width: 80, depth: "none" }));
    const widths = new Set(rendered.split("\n").map((line) => visibleWidth(line)));
    expect(widths.size).toBe(1);
  });

  it("includes the title in the top border when given one", () => {
    expect(plain(box(["a"], { width: 80, depth: "none", title: "todos" })).split("\n")[0]).toContain("todos");
  });

  it("paints a coloured title only when colour was asked for", () => {
    expect(box(["a"], { width: 80, depth: "none", title: "you", titleColor: "green" })).not.toMatch(ESCAPE);
    expect(box(["a"], { width: 80, depth: "truecolor", title: "you", titleColor: "green" })).toMatch(ESCAPE);
    expect(plain(box(["a"], { width: 80, depth: "truecolor", title: "you", titleColor: "green" })).split("\n")[0]).toContain("you");
  });
});

describe("renderPromptBox", () => {
  const fields = { mode: "build", workspace: "circuit-agent", depth: "none" as const, width: 80 };

  it("draws a full-width three-row box with the mode and workspace in the header", () => {
    const { top, prefix, bottom } = renderPromptBox(fields);
    const [topPlain, prefixPlain, bottomPlain] = [plain(top), plain(prefix), plain(bottom)];
    expect(topPlain).toContain("build");
    expect(topPlain).toContain("circuit-agent");
    // The input row is open on the right — the cursor types there — so only its four-column
    // prefix is drawn; the borders above and below span the full width.
    expect(prefixPlain).toBe("│ › ");
    expect(visibleWidth(prefixPlain)).toBe(4);
    expect(visibleWidth(topPlain)).toBe(80);
    expect(visibleWidth(bottomPlain)).toBe(80);
  });

  it("draws the corners the active theme's border style asks for, not a fixed shape", () => {
    expect(plain(renderPromptBox({ ...fields, borderStyle: "round" }).top)).toContain("╭");
    expect(plain(renderPromptBox({ ...fields, borderStyle: "single" }).top)).toContain("┌");
    expect(plain(renderPromptBox({ ...fields, borderStyle: "double" }).top)).toContain("╔");
  });

  it("clips an over-long workspace rather than overflowing the right-hand corner", () => {
    const { top } = renderPromptBox({ ...fields, workspace: "x".repeat(500) });
    expect(plain(top)).toContain("…");
    expect(visibleWidth(plain(top))).toBe(80);
  });

  it("keeps every row inside the width at any width", () => {
    for (const width of [40, 60, 80, 120]) {
      const { top, prefix, bottom } = renderPromptBox({ ...fields, width });
      for (const line of [top, prefix, bottom]) {
        expect(visibleWidth(plain(line)), `width ${width}`).toBeLessThanOrEqual(width);
      }
    }
  });

  it("colours the border and accents only when colour was asked for", () => {
    const none = renderPromptBox(fields);
    const colour = renderPromptBox({ ...fields, depth: "truecolor" });
    expect(`${none.top}${none.prefix}${none.bottom}`).not.toMatch(ESCAPE);
    expect(`${colour.top}${colour.prefix}${colour.bottom}`).toMatch(ESCAPE);
  });

  it("accents each mode with its own colour so the permission posture reads at a glance", () => {
    expect(renderPromptBox({ ...fields, mode: "plan", depth: "truecolor" }).top).toMatch(/\x1b\[33m/);
    expect(renderPromptBox({ ...fields, mode: "auto", depth: "truecolor" }).top).toMatch(/\x1b\[32m/);
    expect(renderPromptBox({ ...fields, mode: "build", depth: "truecolor" }).top).toMatch(/\x1b\[36m/);
    expect(renderPromptBox({ ...fields, mode: "defender", depth: "truecolor" }).top).toMatch(/\x1b\[31m/);
  });

  it("carries the status line on the top border, so the bar costs no extra row", () => {
    const { top } = renderPromptBox({ ...fields, status: "build · $0.12" });
    expect(plain(top)).toContain("$0.12");
    expect(visibleWidth(plain(top))).toBe(80);
  });

  it("keeps the border exactly the terminal's width whatever the status says", () => {
    for (const status of ["", "a", "build · $0.12 · 4 tools", "x".repeat(40)]) {
      const { top } = renderPromptBox({ ...fields, status });
      expect(visibleWidth(plain(top)), JSON.stringify(status)).toBe(80);
    }
  });

  it("drops the status rather than the workspace when a narrow window cannot hold both", () => {
    // Losing the workspace would leave the bar unable to say where it is; the transcript above
    // repeats the cost soon enough, so that is the segment worth giving up.
    const { top } = renderPromptBox({ ...fields, width: 30, status: "a very long status indeed" });
    expect(plain(top)).not.toContain("a very long status indeed");
    expect(plain(top)).toContain("build");
    expect(visibleWidth(plain(top))).toBe(30);
  });

  it("keeps a compact balance and gives up the workspace when that is the only honest fit", () => {
    const { top } = renderPromptBox({ ...fields, workspace: "a-very-long-workspace-name", width: 30, status: "499 RWF" });
    expect(plain(top)).toContain("499 RWF");
    expect(plain(top)).not.toContain("a-very-long-workspace-name");
    expect(visibleWidth(plain(top))).toBe(30);
  });

  it("draws with ASCII glyphs on a terminal that cannot render the box characters", () => {
    const { top, prefix, bottom } = renderPromptBox({ ...fields, glyphs: ASCII_GLYPHS, status: "$0.12" });
    for (const line of [top, bottom]) expect(visibleWidth(plain(line))).toBe(80);
    expect(plain(prefix)).toBe("| > ");
    expect(visibleWidth(plain(prefix))).toBe(PROMPT_PREFIX_COLUMNS);
    expect(top).not.toContain("╭");
  });

  it("pays for the ellipsis out of the workspace's budget, not out of the border", () => {
    // ASCII's ellipsis is three columns to Unicode's one. Clipping to the budget and appending it
    // afterwards is what pushes a border one character past its own corner.
    const { top } = renderPromptBox({ ...fields, workspace: "x".repeat(500), glyphs: ASCII_GLYPHS });
    expect(plain(top)).toContain("...");
    expect(visibleWidth(plain(top))).toBe(80);
  });

  it("draws both borders at exactly the terminal's width, for every combination that fits", () => {
    // The invariant the whole bar rests on. A border one column over wraps onto the row below,
    // which on a pinned footer is the input line — the bar eats the place you type. One column
    // under leaves a ragged notch. Neither is caught by any single hand-picked example, so this
    // sweeps the axes that interact: width against title length against status length.
    for (const width of [20, 30, 48, 80, 120, 200]) {
      for (const workspace of ["a", "circuit-agent", "x".repeat(60), "日本語のリポジトリ"]) {
        for (const status of ["", "$0.12", "build · $0.12 · 4 tools · 12.3s", "y".repeat(50)]) {
          for (const glyphs of [undefined, ASCII_GLYPHS]) {
            const { top, bottom } = renderPromptBox({ mode: "build", workspace, depth: "none", width, status, ...(glyphs ? { glyphs } : {}) });
            const where = `width ${width} · workspace ${workspace.length} · status ${status.length}${glyphs ? " · ascii" : ""}`;
            expect(visibleWidth(plain(top)), where).toBe(width);
            expect(visibleWidth(plain(bottom)), where).toBe(width);
          }
        }
      }
    }
  });
});

describe("promptStatusRoom", () => {
  it("reports the columns left over once the title and corners are laid out", () => {
    const room = promptStatusRoom("build", "circuit-agent", 80);
    // Whatever it reports must actually fit: a status of exactly that width leaves the border
    // exactly the terminal's width, which is the property the number exists to guarantee.
    const { top } = renderPromptBox({ mode: "build", workspace: "circuit-agent", depth: "none", width: 80, status: "x".repeat(room) });
    expect(plain(top)).toContain("x".repeat(room));
    expect(visibleWidth(plain(top))).toBe(80);
  });

  it("reserves for the compact title so a long workspace cannot erase the balance", () => {
    expect(promptStatusRoom("build", "a", 80)).toBe(promptStatusRoom("build", "a".repeat(300), 80));
    expect(promptStatusRoom("build", "x".repeat(500), 20)).toBeGreaterThanOrEqual(0);
  });
});

describe("wrapPlain", () => {
  it("wraps at word boundaries", () => {
    expect(wrapPlain("the quick brown fox", 10)).toEqual(["the quick", "brown fox"]);
  });

  it("gives an empty message a single empty line", () => {
    expect(wrapPlain("", 10)).toEqual([""]);
    expect(wrapPlain("   ", 10)).toEqual([""]);
  });

  it("hard-slices a single word longer than the whole budget", () => {
    expect(wrapPlain("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });

  it("keeps lines within the budget when the text contains double-width characters", () => {
    for (const line of wrapPlain("日本語のテキストがここにあります", 10)) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(10);
    }
  });
});

describe("wrappedRemainder", () => {
  it("returns nothing while the line still fits on its first row", () => {
    expect(wrappedRemainder("a short line", 4, 80)).toBe("");
    expect(wrappedRemainder("", 4, 80)).toBe("");
  });

  it("returns exactly the part that spilled onto the next row", () => {
    // The input row starts four columns in, so at width 20 the first row holds sixteen
    // characters and the remaining four spill over.
    expect(wrappedRemainder("x".repeat(20), 4, 20)).toBe("x".repeat(4));
  });

  it("counts a double-width character as two columns, not one", () => {
    // Width 12 with a four-column start leaves eight columns: 日本語日 fits, the rest wraps.
    expect(wrappedRemainder("日本語".repeat(3), 4, 12)).toBe("本語日本語");
  });

  it("accounts for the starting column, not just the line", () => {
    // The same line wraps sooner the further right it begins.
    expect(wrappedRemainder("x".repeat(10), 0, 12)).toBe("");
    expect(wrappedRemainder("x".repeat(10), 6, 12)).toBe("x".repeat(4));
  });
});

describe("PromptBox", () => {
  it("draws the box and parks the cursor at the start of the input row, returning the prefix", () => {
    const { stream, writes, output } = fakeStream(60);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 60 });
    expect(promptBox.isDrawn).toBe(false);

    const prefix = promptBox.draw("build", "circuit-agent");
    expect(plain(prefix)).toBe("│ › ");
    expect(visibleWidth(plain(prefix))).toBe(PROMPT_PREFIX_COLUMNS);
    expect(promptBox.isDrawn).toBe(true);
    expect(writes).toHaveLength(3); // header row, closing border, cursor reposition
    expect(output()).toContain("\x1b[1A\r"); // back onto the input row, column one
  });

  it("erases exactly the rows the box and the submitted line occupy, wrapping included", () => {
    const { stream, writes } = fakeStream(80);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 80 });

    promptBox.draw("build", "circuit-agent");
    writes.length = 0;
    promptBox.erase("");
    expect(writes).toHaveLength(3); // input row, newline row, top border
    for (const write of writes) expect(write).toBe("\x1b[1A\x1b[2K");

    promptBox.draw("build", "circuit-agent");
    writes.length = 0;
    promptBox.erase("x".repeat(200)); // spills onto two further rows at width 80
    expect(writes).toHaveLength(5);
  });

  it("erasing before anything was drawn is a safe no-op", () => {
    const { stream, writes } = fakeStream();
    new PromptBox(stream, { depth: "none" }).erase("");
    expect(writes).toHaveLength(0);
  });

  it("never divides by a zero-column stream — a 0x0 pty must not spin forever", () => {
    const { stream, writes } = fakeStream(0);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 0 });
    promptBox.draw("build", "x");
    writes.length = 0;
    promptBox.erase("some text");
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.length).toBeLessThan(100); // bounded, not an infinite erase
  });

  it("drops the closing border once, re-showing the wrapped text, and not again after", () => {
    const { stream, writes, output } = fakeStream(60);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 60 });
    promptBox.draw("build", "circuit-agent");
    writes.length = 0;

    promptBox.dropBorder("the remainder that wrapped");
    expect(writes).toHaveLength(2);
    expect(output()).toContain("\r\x1b[2K");
    expect(output()).toContain("the remainder that wrapped");

    promptBox.dropBorder("more"); // already opened — nothing further is written
    expect(writes).toHaveLength(2);
  });

  it("ignores a dropBorder with nothing to show, or before the box exists", () => {
    const { stream, writes } = fakeStream(60);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 60 });
    promptBox.dropBorder("something"); // not drawn yet
    expect(writes).toHaveLength(0);
    promptBox.draw("build", "x");
    writes.length = 0;
    promptBox.dropBorder(""); // nothing wrapped
    expect(writes).toHaveLength(0);
  });

  it("re-arms the border on the next draw, so a reopened box closes again", () => {
    const { stream, writes } = fakeStream(60);
    const promptBox = new PromptBox(stream, { depth: "none", columns: () => 60 });
    promptBox.draw("build", "x");
    promptBox.dropBorder("wrapped");
    promptBox.erase("wrapped");
    promptBox.draw("build", "x");
    writes.length = 0;
    promptBox.dropBorder("wrapped again");
    expect(writes).toHaveLength(2); // opened again rather than staying latched open
  });

  it("paints colour only when colour was asked for", () => {
    const bare = fakeStream(60);
    new PromptBox(bare.stream, { depth: "none", columns: () => 60 }).draw("build", "x");
    expect(bare.output()).not.toMatch(ESCAPE);

    const painted = fakeStream(60);
    new PromptBox(painted.stream, { depth: "truecolor", columns: () => 60 }).draw("build", "x");
    expect(painted.output()).toMatch(ESCAPE);
  });
});

describe("padToWidth and joinHorizontal", () => {
  it("pads a short cell out to exactly the width", () => {
    expect(padToWidth("ab", 5)).toBe("ab   ");
    expect(visibleWidth(padToWidth("ab", 5))).toBe(5);
  });

  it("clips a long cell down to exactly the width rather than overflowing", () => {
    expect(padToWidth("abcdefgh", 4)).toBe("abcd");
    expect(visibleWidth(padToWidth("abcdefgh", 4))).toBe(4);
  });

  it("measures in columns, so a wide character costs two", () => {
    // Three double-width characters are six columns, so at a budget of four only two survive.
    expect(padToWidth("日本語", 4)).toBe("日本");
    expect(visibleWidth(padToWidth("日本語", 4))).toBe(4);
    // And padding a wide cell fills the remaining columns, not the remaining characters.
    expect(visibleWidth(padToWidth("日", 5))).toBe(5);
  });

  it("discounts ANSI, so a coloured cell is not silently narrower than a plain one", () => {
    expect(visibleWidth(padToWidth("\x1b[31mab\x1b[0m", 5))).toBe(5);
  });

  it("keeps a coloured cell's content when clipping it, rather than spending columns on escape codes", () => {
    // The bug this closes: the walk under this asked `visibleWidth` about one character at a time,
    // and a lone `\x1b` is not a sequence the ANSI pattern matches — so it measured one column wide.
    // A painted cell paid a column for every escape character in it, and `table()`, which documents
    // that its cells arrive pre-painted, clipped away real content to afford codes nobody can see.
    const painted = padToWidth("\x1b[31mabcdefgh\x1b[0m", 4);
    expect(plain(painted)).toBe("abcd");
    expect(visibleWidth(painted)).toBe(4);
  });

  it("does not split an astral character in half while slicing", () => {
    // A surrogate pair cut down the middle renders as replacement characters, not a narrower emoji.
    expect(sliceToWidth("🌟🌟", 2)).toBe("🌟");
  });

  it("joins two columns to a total that never varies with either side's content", () => {
    const narrow = joinHorizontal("a", "b", { leftWidth: 6, rightWidth: 8, separator: " | " });
    const wide = joinHorizontal("a".repeat(50), "b".repeat(50), { leftWidth: 6, rightWidth: 8, separator: " | " });
    expect(visibleWidth(narrow)).toBe(6 + 3 + 8);
    expect(visibleWidth(wide)).toBe(6 + 3 + 8);
  });

  it("keeps the separator at the same column on every row — the ragged-seam bug", () => {
    const rows = ["short", "a much longer left cell than the others", ""].map((left) =>
      joinHorizontal(left, "preview", { leftWidth: 10, rightWidth: 12, separator: " │ " }));
    const seams = new Set(rows.map((row) => row.indexOf("│")));
    expect(seams.size).toBe(1);
  });

  it("defaults to a single space between the columns", () => {
    expect(joinHorizontal("a", "b", { leftWidth: 2, rightWidth: 2 })).toBe("a  b ");
  });
});

describe("sliceToWidth", () => {
  it("never returns more columns than asked for, and never splits a wide character in half", () => {
    expect(sliceToWidth("日本語", 3)).toBe("日"); // 2 fits, 4 would not
    expect(visibleWidth(sliceToWidth("日本語", 3))).toBe(2);
  });

  it("returns nothing for a zero or negative budget", () => {
    expect(sliceToWidth("abc", 0)).toBe("");
    expect(sliceToWidth("abc", -5)).toBe("");
  });
});

describe("counted progress", () => {
  it("shows the two numbers, and never a bar without them", () => {
    expect(stepProgress(3, 8, { depth: "none" })).toBe("3/8");
    expect(stepProgress(3, 8, { label: "plan", depth: "none" })).toBe("plan 3/8");
    expect(stepProgress(0, 0, { label: "plan", depth: "none" })).toBe("plan 0/0");
    // A total of zero has no fraction to draw, so no bar is drawn for it.
    expect(stepProgress(0, 0, { width: 10, depth: "none" })).toBe("0/0");
  });

  it("draws a bar whose fill matches the fraction it reports", () => {
    const empty = stepProgress(0, 10, { width: 10, depth: "none" });
    const half = stepProgress(5, 10, { width: 10, depth: "none" });
    const full = stepProgress(10, 10, { width: 10, depth: "none" });
    const filled = (text: string) => [...text.split(" ").at(-1)!].filter((cell) => cell === "█").length;

    expect(filled(empty)).toBe(0);
    expect(filled(half)).toBe(5);
    expect(filled(full)).toBe(10);
  });

  it("clamps nonsense rather than throwing where a person is watching", () => {
    expect(stepProgress(12, 8, { depth: "none" })).toBe("8/8");
    expect(stepProgress(-3, 8, { depth: "none" })).toBe("0/8");
    expect(stepProgress(Number.NaN, Number.POSITIVE_INFINITY, { depth: "none" })).toBe("0/0");
    expect(stepProgress(2.7, 8.9, { depth: "none" })).toBe("2/8");
  });

  it("puts counted progress on the status line, and drops it before the mode when space runs out", () => {
    const fields = { mode: "build", spinnerGlyph: "*", elapsedMs: 1_000, toolCalls: 4, tokens: 2_000, cost: "$0.02", steps: { done: 4, total: 9, label: "plan" } };
    expect(formatStatusLine(fields, 120, "none")).toContain("plan 4/9");
    // Narrow enough that only the most important field survives: the mode outranks the counter.
    const narrow = formatStatusLine(fields, 34, "none");
    expect(narrow).toContain("build");
    expect(narrow).not.toContain("plan 4/9");
  });

  it("omits the counter entirely when there is no plan behind it", () => {
    const fields = { mode: "build", spinnerGlyph: "*", elapsedMs: 1_000, toolCalls: 0, tokens: 0, cost: "", steps: { done: 0, total: 0 } };
    expect(formatStatusLine(fields, 120, "none")).not.toContain("0/0");
  });
});

describe("spinner timing", () => {
  it("draws nothing for an operation that finishes inside the start delay", async () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 20, undefined, 200);
    spinner.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    spinner.stop();
    expect(ticks).toBe(0);

    // ...and still nothing after the delay would have elapsed, because it was cancelled.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(ticks).toBe(0);
  });

  it("animates once the wait is real, and stops when told", async () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 10, undefined, 20);
    spinner.start();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const during = ticks;
    spinner.stop();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(during).toBeGreaterThan(1);
    expect(ticks).toBe(during);
  });

  it("keeps drawing immediately when no delay is configured", () => {
    let ticks = 0;
    const spinner = new Spinner(() => { ticks += 1; }, 10);
    spinner.start();
    spinner.stop();
    expect(ticks).toBe(1);
  });
});
