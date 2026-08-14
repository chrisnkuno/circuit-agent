import { describe, expect, it } from "vitest";
import { PinnedScreen, type ScreenStream } from "./screen";

function fakeStream(rows: number, columns: number): ScreenStream & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    rows,
    columns,
    write(text: string) {
      writes.push(text);
      return true;
    },
  };
}

describe("entering the pinned footer", () => {
  it("sets the scroll region to exclude the footer, then parks the cursor at its bottom", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();

    // scrollBottom for a 40-row terminal with a 3-row footer is 37 — see layout.test.ts for the math.
    expect(stream.writes).toEqual(["\x1b[1;37r", "\x1b[37;1H"]);
  });

  it("falls back to the full-screen default region on a terminal too short for a footer", () => {
    const stream = fakeStream(3, 80);
    const screen = new PinnedScreen(stream);
    screen.enter();

    expect(stream.writes[0]).toBe("\x1b[r");
    // No footer rows means nowhere fixed to park — parkInTranscript is a deliberate no-op here.
    expect(stream.writes).toEqual(["\x1b[r"]);
  });
});

describe("resize", () => {
  it("recomputes the layout from the stream's live size and reapplies the region", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    stream.rows = 20;
    const layout = screen.resize();

    expect(layout.scrollBottom).toBe(17);
    expect(stream.writes).toEqual(["\x1b[1;17r", "\x1b[17;1H"]);
  });

  it("exposes the new layout through .current after resizing", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    stream.rows = 60;
    screen.resize();
    expect(screen.current.rows).toBe(60);
  });
});

describe("the status line", () => {
  it("saves the cursor, redraws in place, and restores it — a caller mid-keystroke sees no jump", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.renderStatus("nova · build · $0.12");

    expect(stream.writes).toEqual([
      "\x1b7\x1b[?25l\x1b[38;1H\x1b[2Knova · build · $0.12\x1b8\x1b[?25h",
    ]);
  });

  it("does nothing on a terminal with no status row to draw", () => {
    const stream = fakeStream(3, 80);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.renderStatus("should not appear");
    expect(stream.writes).toEqual([]);
  });
});

describe("positioning the input line", () => {
  it("clears the input row and parks the cursor there", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.positionInput();
    expect(stream.writes).toEqual(["\x1b[39;1H\x1b[2K"]);
  });

  it("does nothing when the terminal has no room for an input row", () => {
    const stream = fakeStream(3, 80);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.positionInput();
    expect(stream.writes).toEqual([]);
  });
});

describe("the input bar's closing border", () => {
  it("draws on the row below the input line, saving and restoring the cursor around it", () => {
    // Save/restore matters more here than for the status row: this row is *below* where the user
    // is typing, so reaching it means leaving the input line and having to come back exactly.
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.renderPromptBottom("╰──────╯");

    expect(stream.writes).toEqual(["\x1b7\x1b[?25l\x1b[40;1H\x1b[2K╰──────╯\x1b8\x1b[?25h"]);
  });

  it("does nothing on a terminal too short to spare the row", () => {
    // A 5-row terminal keeps the status row and the input row and gives up this one.
    const stream = fakeStream(5, 80);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.renderPromptBottom("╰──────╯");
    expect(stream.writes).toEqual([]);
  });

  it("does nothing without a held region, where the row is ordinary transcript", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream, { holdRegion: false });
    stream.writes.length = 0;

    screen.renderPromptBottom("╰──────╯");
    expect(stream.writes).toEqual([]);
  });
});

describe("returning to the transcript", () => {
  it("moves the cursor to the bottom of the scroll region for the next ordinary write", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.parkInTranscript();
    expect(stream.writes).toEqual(["\x1b[37;1H"]);
  });
});

describe("exit", () => {
  it("always releases the scroll region, even on a terminal that never had a footer", () => {
    const stream = fakeStream(3, 80);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.exit();
    expect(stream.writes).toEqual(["\x1b[r", "\x1b[3;1H\n"]);
  });

  it("leaves the cursor below the whole screen, not mid-transcript", () => {
    const stream = fakeStream(40, 100);
    const screen = new PinnedScreen(stream);
    screen.enter();
    stream.writes.length = 0;

    screen.exit();
    expect(stream.writes).toEqual(["\x1b[r", "\x1b[40;1H\n"]);
  });
});

describe("defaults when the stream reports no size", () => {
  it("falls back to 24x80, the same default the rest of the CLI already assumes", () => {
    const stream: ScreenStream & { writes: string[] } = { writes: [], write: (text) => { stream.writes.push(text); return true; } };
    const screen = new PinnedScreen(stream);
    expect(screen.current.rows).toBe(24);
    expect(screen.current.columns).toBe(80);
  });
});
