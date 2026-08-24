#!/usr/bin/env bun
/**
 * A runnable fixed-layout window, so the design can be judged by using it.
 *
 * `fixed-layout.ts` and `fixed-screen.ts` are unit-tested to the point where their arithmetic is
 * hard to get wrong, but no test tells you whether scrolling *feels* right, whether the frame holds
 * still while output arrives, or whether the wheel overshoots. Those are the questions this answers,
 * and it answers them in the terminal the user actually has.
 *
 * Deliberately not part of the CLI. Nova's prompt still uses the flow layout, and wiring this in
 * means replacing readline with raw-mode input for the composer — a change worth making only after
 * someone has decided they want this. Until then, a script that borrows the same modules proves the
 * behaviour without touching the thing people rely on.
 *
 *   bun run tooling/dev/fixed-layout-demo.ts             # streams synthetic output at you
 *   bun run tooling/dev/fixed-layout-demo.ts --file X    # loads a real file instead
 *   bun run tooling/dev/fixed-layout-demo.ts --quiet     # no streaming; static content
 */
import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import {
  appendLines,
  newFixedLayout,
  renderFrame,
  resize,
  scroll,
  search,
  stepSearch,
  transcriptText,
  type FixedLayoutState,
} from "../../packages/nova-cli/src/fixed-layout";
import { FixedScreen, decodeFixedKey, fixedStatusLine, openInPager } from "../../packages/nova-cli/src/fixed-screen";

const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write("The fixed-layout demo needs a real terminal — it takes over the screen.\n");
  process.exit(2);
}

const file = argument("--file");
const quiet = process.argv.includes("--quiet");

/** Content with enough shape that scrolling and searching have something to land on. */
async function initialLines(): Promise<string[]> {
  if (file) return (await fs.readFile(file, "utf8")).split("\n");
  const lines: string[] = ["Nova fixed-layout demo", ""];
  for (let index = 1; index <= 300; index += 1) {
    if (index % 25 === 0) lines.push(`\u001b[31mTypeError: something went wrong at step ${index}\u001b[0m`);
    else if (index % 10 === 0) lines.push("");
    else lines.push(`${String(index).padStart(4)}  ${"the quick brown fox jumps over the lazy dog. ".repeat(index % 4 === 0 ? 3 : 1)}`);
  }
  return lines;
}

const CHROME = 3;
let state: FixedLayoutState = newFixedLayout({
  columns: process.stdout.columns ?? 80,
  rows: process.stdout.rows ?? 24,
  chrome: CHROME,
});
state = appendLines(state, await initialLines());

const screen = new FixedScreen(process.stdout, { mouse: true });
let searching: string | null = null;

function paint(): void {
  const frame = renderFrame(state);
  const columns = state.columns;
  const header = ` Nova — fixed layout demo${" ".repeat(Math.max(0, columns - 40))}q to quit `.slice(0, columns);
  const status = searching === null
    ? fixedStatusLine({ position: frame.position, following: frame.following, truncated: frame.truncated, columns })
    : `find: ${searching}`;
  const composer = searching === null ? "> (this row stands in for the composer)" : "";
  screen.paint([`\u001b[7m${header}\u001b[0m`, ...frame.body, composer.slice(0, columns), `\u001b[2m${status}\u001b[0m`]);
}

/** Restores the terminal on every path. A missed leave is a terminal the user has to reset by hand. */
function finish(code = 0): never {
  screen.leave();
  try {
    process.stdin.setRawMode(false);
  } catch {
    // Already restored, or never a TTY. Either way there is nothing left to undo.
  }
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => finish(0));
process.on("uncaughtException", (error) => {
  screen.leave();
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});

process.stdout.on("resize", () => {
  state = resize(state, process.stdout.columns ?? state.columns, process.stdout.rows ?? state.rows);
  paint();
});

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

function acceptSearchInput(chunk: string): void {
  for (const character of chunk) {
    if (character === "\r" || character === "\n") {
      state = search(state, searching ?? "");
      searching = null;
      break;
    }
    if (character === "\u001b") {
      searching = null;
      break;
    }
    if (character === "\u007f" || character === "\b") searching = (searching ?? "").slice(0, -1);
    else if (character >= " ") searching = (searching ?? "") + character;
  }
}

process.stdin.on("data", (chunk: string) => {
  // While the find prompt is open every key belongs to it, which is why this branch comes first.
  if (searching !== null) {
    // A PTY is a byte stream, not a key-event API: fast typing commonly coalesces the final text
    // and Enter into one data event (for example, "TypeError\r"). Process it character by
    // character so submission cannot accidentally become part of the query.
    acceptSearchInput(chunk);
    paint();
    return;
  }

  // The opener and typed query can arrive in one data event too. Treat `/TypeError\r` and
  // Alt+F followed immediately by text exactly like separate key events instead of dropping the
  // entire coalesced chunk as an unknown key.
  const searchPrefix = chunk.startsWith("/") ? 1 : chunk.startsWith("\u001bf") || chunk.startsWith("\u001bF") ? 2 : 0;
  if (searchPrefix > 0) {
    searching = "";
    acceptSearchInput(chunk.slice(searchPrefix));
    paint();
    return;
  }

  if (chunk === "q" || chunk === "\u0003") finish(0);

  const action = decodeFixedKey(chunk);
  if (!action) {
    // `/` opens find here because this demo has no composer to protect; the real CLI keeps every
    // bare letter as text and puts find on alt+f, which `decodeFixedKey` already handles.
    if (chunk === "/") {
      searching = "";
      paint();
    }
    return;
  }

  if (action.kind === "search") searching = "";
  else if (action.kind === "searchNext") state = stepSearch(state, 1);
  else if (action.kind === "searchPrev") state = stepSearch(state, -1);
  else if (action.kind === "openPager") {
    // Two programs both believing they own the screen is how a terminal ends up unusable.
    screen.leave();
    process.stdin.setRawMode(false);
    void openInPager(transcriptText(state), {
      environment: process.env,
      spawn: (command, args, input) => new Promise((resolve) => {
        const child = spawn(command, [...args], { stdio: ["pipe", "inherit", "inherit"] });
        child.stdin.end(input);
        child.on("close", (code) => resolve(code ?? 0));
        child.on("error", () => resolve(127));
      }),
    }).then(() => {
      process.stdin.setRawMode(true);
      screen.enter();
      paint();
    });
    return;
  } else if (action.kind !== "leave") {
    state = scroll(state, action);
  }
  paint();
});

screen.enter();
paint();

// Output arriving underneath the reader is the whole point of the follow rule, so the demo produces
// some — otherwise the most important behaviour here is the one nobody can see.
if (!quiet) {
  let tick = 0;
  setInterval(() => {
    tick += 1;
    state = appendLines(state, [`\u001b[2m[${new Date().toISOString().slice(11, 19)}]\u001b[0m streamed line ${tick}`]);
    paint();
  }, 900);
}
