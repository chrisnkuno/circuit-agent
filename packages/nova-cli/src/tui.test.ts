import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visibleWidth } from "./markdown";
import {
  box,
  effectGlyph,
  formatStatusLine,
  formatTokens,
  MarkdownStream,
  PromptBox,
  renderAgentLabel,
  renderFilesTouched,
  renderPromptBox,
  ReplaceableBlock,
  rowsOccupied,
  Spinner,
  sparkline,
  StatusBar,
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
});

describe("formatTokens", () => {
  it("counts exactly below a thousand and abbreviates above it", () => {
    expect(formatTokens(0)).toBe("0 tokens");
    expect(formatTokens(999)).toBe("999 tokens");
    expect(formatTokens(1_200)).toBe("1.2k tokens");
    expect(formatTokens(45_600)).toBe("45.6k tokens");
  });
});

describe("thinkingVerb", () => {
  it("holds a word for several seconds rather than flickering every frame", () => {
    expect(thinkingVerb(0)).toBe(thinkingVerb(3_999));
    expect(thinkingVerb(0)).not.toBe(thinkingVerb(4_000));
  });

  it("cycles rather than running out, however long the turn takes", () => {
    expect(thinkingVerb(10 * 60_000)).toBeTruthy();
    expect(thinkingVerb(-1)).toBe(thinkingVerb(0));
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
    expect(ticks).toBe(4);
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
    expect(ticks).toBe(2);
  });

  it("stopping before ever starting is a safe no-op", () => {
    const spinner = new Spinner(() => {});
    expect(() => spinner.stop()).not.toThrow();
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

describe("renderAgentLabel", () => {
  it("names the speaker, uncoloured when colour is off", () => {
    const label = renderAgentLabel("none");
    expect(label).not.toMatch(ESCAPE);
    expect(plain(label)).toBe("✦ nova");
  });

  it("paints the glyph and name when colour is on", () => {
    expect(renderAgentLabel("truecolor")).toMatch(ESCAPE);
    expect(plain(renderAgentLabel("truecolor"))).toBe("✦ nova");
  });
});

describe("renderFilesTouched", () => {
  it("titles the box and lists every path", () => {
    const rendered = plain(renderFilesTouched(["src/b.ts", "src/a.ts"], "none", 80));
    expect(rendered.split("\n")[0]).toContain("files modified");
    expect(rendered).toContain("src/a.ts");
    expect(rendered).toContain("src/b.ts");
  });

  it("deduplicates and sorts paths, since the same file can be touched twice in a turn", () => {
    const rendered = plain(renderFilesTouched(["src/b.ts", "src/a.ts", "src/b.ts"], "none", 80));
    const lines = rendered.split("\n").filter((line) => line.includes("src/"));
    expect(lines).toHaveLength(2);
    expect(rendered.indexOf("src/a.ts")).toBeLessThan(rendered.indexOf("src/b.ts"));
  });
});

describe("effectGlyph", () => {
  it("marks nothing for a read-only call", () => {
    expect(effectGlyph("none", "truecolor")).toBe("");
  });

  it("marks a workspace-writing call, uncoloured when colour is off", () => {
    expect(plain(effectGlyph("workspace", "truecolor"))).not.toBe("");
    expect(effectGlyph("workspace", "none")).not.toMatch(ESCAPE);
  });

  it("marks an external call differently from a workspace one", () => {
    expect(plain(effectGlyph("external", "truecolor"))).not.toBe(plain(effectGlyph("workspace", "truecolor")));
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
    const line = sparkline([3, 3, 3]);
    expect(new Set(line)).toHaveProperty("size", 1);
  });

  it("does not divide by zero when the whole series is zero", () => {
    expect(sparkline([0, 0, 0])).toHaveLength(3);
  });

  it("rises left to right for a rising series", () => {
    const levels = "▁▂▃▄▅▆▇█";
    const line = sparkline([1, 2, 3, 4]);
    const indices = [...line].map((glyph) => levels.indexOf(glyph));
    expect(indices).toEqual([...indices].sort((left, right) => left - right));
    expect(indices[0]).toBeLessThan(indices.at(-1)!);
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
  });
});

describe("wrappedRemainder", () => {
  it("returns nothing while the line fits on the input row", () => {
    expect(wrappedRemainder("a short line", 4, 80)).toBe("");
    expect(wrappedRemainder("", 4, 80)).toBe("");
  });

  it("returns the part of the line that spilled onto the next row", () => {
    // The input row starts four columns in, so at width 20 the first row holds sixteen
    // characters and the remaining four spill over.
    expect(wrappedRemainder("x".repeat(20), 4, 20)).toBe("x".repeat(4));
  });

  it("counts double-width characters as two columns", () => {
    // Width 12 with a four-column start leaves eight columns: 日本語日 fits, 本 wraps.
    expect(wrappedRemainder("日本語".repeat(3), 4, 12)).toBe("本語日本語");
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

describe("PromptBox", () => {
  it("draws the box and parks the cursor at the start of the input row, returning the prefix", () => {
    const { stream, output, writes } = fakeStream(60);
    const promptBox = new PromptBox(stream);
    expect(promptBox.isDrawn).toBe(false);

    const prefix = promptBox.draw("build", "circuit-agent");
    expect(prefix).toBe("│ › ");
    expect(promptBox.isDrawn).toBe(true);
    expect(writes).toHaveLength(3); // header, closing border, and the cursor reposition
    const text = output();
    expect(text).toContain("╭─"); // header row
    expect(text).toContain("╰"); // closing border
    expect(text).toContain("\x1b[1A\r"); // back onto the input row, column one
  });

  it("erases exactly the rows the box and the submitted line occupy", () => {
    const { stream, writes } = fakeStream(80);
    const promptBox = new PromptBox(stream);
    promptBox.draw("build", "circuit-agent");
    writes.length = 0;

    promptBox.erase("");
    expect(writes).toHaveLength(3); // input row, newline row, top border

    writes.length = 0;
    promptBox.draw("build", "circuit-agent");
    writes.length = 0;
    promptBox.erase("x".repeat(200)); // wraps onto two extra rows
    expect(writes).toHaveLength(5);
    for (const write of writes) expect(write).toBe("\x1b[1A\x1b[2K");
  });

  it("erasing before anything was drawn is a safe no-op", () => {
    const { stream, writes } = fakeStream();
    new PromptBox(stream).erase("");
    expect(writes).toHaveLength(0);
  });

  it("drops the closing border once and re-shows the wrapped text", () => {
    const { stream, output, writes } = fakeStream(60);
    const promptBox = new PromptBox(stream);
    promptBox.draw("build", "circuit-agent");
    writes.length = 0;

    promptBox.dropBorder("the remainder that wrapped");
    expect(writes).toHaveLength(2);
    expect(output()).toContain("\r\x1b[2K");
    expect(output()).toContain("the remainder that wrapped");

    promptBox.dropBorder("more"); // already opened — nothing further is written
    expect(writes).toHaveLength(2);

    promptBox.erase("");
    expect(writes).toHaveLength(2 + 3);
  });
});
