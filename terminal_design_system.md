# Nova Terminal Design System

The rules Nova's terminal interface is built from, and the failures that produced each one.

Every rule here is load-bearing: it exists because something broke, and the fix is encoded as a test.
Where a rule cites a test, that test is the enforcement — change the rule and the suite fails.

---

## 0. The two surfaces

Nova draws on two surfaces, and confusing them is the single most common source of bugs.

| | **Transcript** (default) | **Screen** (`/workspace`, `/guide`) |
|---|---|---|
| model | append-only, prints ANSI to stdout | screen buffer, diffed and repainted |
| owns | one line at a time | every cell, until it exits |
| renderer | Nova's own (`sections.ts`, `markdown.ts`) | TermUI |
| scrollback | the terminal's, intact | none — the alt screen has no history |
| copy-paste | works | viewport only |
| pipes | works (`nova … > notes.md`) | refuses to open |
| startup cost | 0 ms | ~37 ms, paid on entry |

**Rule 0.1 — The transcript is the default and the fallback.** Anything the screen can do, the
transcript must be able to do worse. A screen is an enhancement, never the only path: `/guide` prints
when there is no TTY, `/workspace` says so rather than hanging.

**Rule 0.2 — Text you might keep goes to the transcript.** A named topic (`/guide tabs`), a diff, a
test report — these are things people quote, paste into issues and pipe to files. A screen takes them
away when it exits. Browsing goes to a screen; keeping goes to the transcript.

---

## 1. Architecture: pure model, thin screen

Every screen is two files.

```
workspace-model.ts    ← every decision. pure functions. no framework import.
workspace-screen.tsx  ← turns finished rows into widgets. nothing else.
```

**Rule 1.1 — The model imports nothing from the framework.** Selection, scrolling, filtering, what a
key means, and the composed frame are all pure functions of a snapshot. This is what makes them
testable by comparing values instead of by rendering a terminal and reading pixels back.

**Rule 1.2 — The screen file contains no logic.** If a `.tsx` file has an `if` that decides
*something about the application*, it belongs in the model. The `.tsx` may only map data to widgets.

**Why:** the framework is a 0.1.x dependency drawing a headline feature. Confining it to two small
files means a breaking release costs two files, not the interface.

**Enforcement:** `workspace-model.test.ts`, `guide-browser.test.ts` — 60+ tests, zero framework
imports.

---

## 2. Layout: compose frames, do not delegate

**Rule 2.1 — Build the frame as exactly `rows` rows of exactly `columns` width, then hand it over.**

```ts
export function composeFrame(snapshot): FrameRow[] {
  const rows: FrameRow[] = [];
  rows.push({ text: bar, bold: true });          // header
  for (let i = 0; i < height; i += 1) rows.push({ text: body[i] ?? "" });
  while (rows.length < snapshot.rows - 1) rows.push({ text: "" });   // pad
  rows.length = snapshot.rows - 1;                                   // clamp
  rows.push({ text: legend, dim: true });        // footer, always last
  return rows;
}
```

**The failure that produced this:** the workspace was first built as nested flex boxes — a header
box, a body box with `height`, a footer box. It rendered correctly with two lines of content and
**put the legend in the middle of the transcript** the moment a pane held more lines than fitted.
Independently sized boxes overlapped. Composing the frame makes that unrepresentable.

**Rule 2.2 — Pad *and* clamp.** Padding alone lets a short frame show the previous frame underneath.
Clamping alone lets a long frame push the footer off screen. Both, in that order, every time.

**Rule 2.3 — Every row is the same width.** Enforced as a test: the set of row widths must have
size 1. A ragged frame is how column separators bend.

**Enforcement:**
```ts
it("is exactly as wide as the window, on every row", () => {
  const widths = new Set(frame.map((row) => visibleWidth(row.text)));
  expect(widths.size).toBe(1);
});
it("puts the legend on the last row and nowhere else", () => { … });
```

**Rule 2.4 — Two columns are built as one string, not two boxes.**
`` `${pad(sidebarCell, sidebar)} │ ${pad(bodyLine, body)}` `` — arithmetic, not layout.

---

## 3. Wrapping and clipping

**Rule 3.1 — Wrappers take the measure they are given, with no floor.** `wrapText(text, width)` once
had `Math.max(20, width)` inside it; a caller asking for eight columns silently got twenty and the
bug was invisible in production. The caller owns the minimum.

**Rule 3.2 — Titles wrap. Commands wrap with a hanging indent. Prose wraps. Nothing clips silently.**

```
  /tab new fast --model
    claude-haiku-4-5-20251001
      a tab on a different model
```

A command clipped mid-flag (`--model claude-haiku-4-5-2025…`) is not something anyone can type, and
a narrow window is exactly where someone is reading the guide *because* they don't remember the
syntax.

**Rule 3.3 — Where the two-column form starves the explanation, stack instead.** Past half the panel
width, `input`/`effect` pairs stack onto two rows. Costs a row, keeps the sentence.

**Rule 3.4 — Clip escape-aware, and close the colour.** `clip()` in `sections.ts` counts visible
width and emits a reset; a naive `slice` cuts a colour sequence in half and bleeds it down the page.

---

## 4. Input: names *and* control characters

**Rule 4.1 — Accept both spellings of every control key.**

```ts
const isEscape = name === "escape" || name === "\x1b";
const isEnter  = name === "return" || name === "enter" || name === "\r" || name === "\n";
```

**The failure:** the in-memory test renderer *names* keys (`"escape"`, `"return"`); a real terminal
sends the *characters* (`0x1b`, `0x0d`). Matching only the names passed every unit test and left the
guide's search filter impossible to close on an actual keyboard.

**Rule 4.2 — TermUI reports the key name under `key.key`, not `key.name`.** Adapt at the boundary so
the model keeps readline's vocabulary:

```ts
useInput((input, key) => keyToAction({ name: key?.key, ctrl: key?.ctrl, shift: key?.shift }, input));
```

**Rule 4.3 — A text-entry mode swallows every printable key.** While a filter is open, `q` is a
letter. Otherwise typing "sandbox" fires four shortcuts, one of which quits.

**Rule 4.4 — Escape closes the *inner* thing first.** First Escape closes the filter; second leaves
the screen. Every editor has trained this.

**Rule 4.5 — Ctrl+C always exits, in every mode.**

---

## 5. Colour and theme

**Rule 5.1 — Renderers ask for *tones*, never colours.** `accent`, `good`, `bad`, `warn`,
`neutral` — never "cyan". This is why a theme can repaint the whole transcript without one call site
being edited.

**Rule 5.2 — `neutral` stays DIM under every theme.** It is a *weight*, not a colour. A theme that
recoloured it would give subordinate text a second voice competing with the first.

**Rule 5.3 — The palette carries both forms.**

| form | who wants it | example |
|---|---|---|
| escape code | the transcript | `\x1b[38;2;138;180;248m` |
| token value | TermUI (`parseColor`) | `#8ab4f8` |

Handing TermUI an already-escaped string prints `38;2;…` on screen. `Palette` carries `.tokens`
beside the resolved codes so neither surface has to convert.

**Rule 5.4 — Emit only what the terminal admits to.** A truecolor sequence is *printed*, not ignored,
by a 256-colour terminal. `colorCode(value, depth)` honours `ColorDepth` — there is no "send it and
hope".

**Rule 5.5 — Never paint a background in the transcript.** `--bg` and `--surface` are parsed and
carried, and nothing in the scrolling renderer uses them: painting a background fights the user's own
and leaves coloured bands on every line that scrolls. A screen owns its cells and may use them.

**Rule 5.6 — The format is TSS.** `@theme name { --primary: …; }`, both `--name` and `$name`
spellings, widget rules skipped rather than rejected. A theme written for a TermUI app is a valid
Nova theme, and themes written today survive whatever renders them tomorrow.

---

## 6. Glyphs

**Rule 6.1 — Capability is a first-class switch, like colour depth.** `GlyphSet` is resolved once
from the environment (`NOVA_GLYPHS`, `TERM`, Windows host checks, locale charset) and threaded
through every renderer.

**Rule 6.2 — Every unicode glyph has an ASCII twin in the same slot.** `✦`/`*`, `❯`/`>`, `╭`/`+`. A
renderer never reaches for a literal.

**Rule 6.3 — `--ascii` must produce output with no codepoint above 127. Anywhere.** Wordmark, stars,
spinner, borders, status line, prompt. Enforced end-to-end under a pty:

```ts
const nonAscii = [...banner].filter((c) => (c.codePointAt(0) ?? 0) > 127);
expect(nonAscii).toEqual([]);
```

---

## 7. The transcript's own rules

**Rule 7.1 — Never hold a `DECSTBM` scroll region.** A terminal saves scrolled-off lines to its
scrollback **only when the scrolling region is the whole screen**. Reserving two rows for a pinned
footer silently costs the session every line that scrolls past the top — the transcript looks
perfect and the history does not exist.

The status line lives in the flow instead (`StatusBar.renderLine`: erase, write, erase again).
`--pin` restores the fixed footer for anyone who prefers it, and says what it costs.

**Rule 7.2 — A region may be *borrowed*, never held.** The suggestion dropdown needs reserved rows;
it takes them while the user is typing (when nothing is printing), and gives them back on close.

**Rule 7.3 — Every write goes through a sink.** `nova.ts` addresses `out`, never `process.stdout`.
This is what makes a second concurrent piece of work possible at all: a tab that is not in front
records without printing.

Three deliberate exceptions, all documented at their call site: `hiddenQuestion`'s echo suppression,
the `--json` stdout choke point, and the pre-session settings prompts.

**Rule 7.4 — The terminal sink resolves `process.stdout.write` at call time.** A bound copy routes
around `--json`'s redirect and puts human prose into a machine-readable stream.

**Rule 7.5 — A menu erases its last frame.** Repaint-over-previous cleans every frame except the
final one, which is why an answered settings menu sat on screen. Count *rows*, not `\n`s — a wrapped
line occupies two.

---

## 8. Typographic hierarchy

Four levels. Nothing may invent a fifth.

| level | function | use |
|---|---|---|
| `rule()` | full-width divider, optionally labelled | separates **episodes** — one turn from the next |
| `heading()` | titled line, three weights | separates **topics** within an episode |
| `panel()` | bordered card | **quoted** content: a diff, code, a transcript excerpt |
| `note()` | indented dim line | everything **subordinate**: counts, hints, provenance |

**Rule 8.1 — Labels sit left, never centred.** A reader scanning for "where did the tests start" runs
their eye down the left edge; a centred label moves horizontally with its own length.

**Rule 8.2 — A rule never wraps.** Label and trailing text are clipped; trailing takes at most half.
A divider that wraps becomes two ragged lines — the one failure a separator cannot survive.

**Rule 8.3 — Panels clip, never re-wrap.** A panel quotes something already laid out; re-wrapping is
a lie about the thing being quoted.

**Rule 8.4 — Fold, never truncate.** Long output is folded with the whole of it kept and addressable
by number (`/expand 3`). Truncation destroys; folding defers.

---

## 9. TermUI: what actually works

Measured against `@termuijs/*@0.1.7`, not read from the docs.

### Works in the JSX + hooks model

| | notes |
|---|---|
| `Box`, `Text` | with `bold`, `dimColor`, `inverse`, `color` (hex or named) |
| `Sidebar` | renders items, badges and active highlight as a JSX element |
| `useState`, `useInput`, `useInterval` | hooks behave as documented |
| `renderApp(Component, props)` | `{title, fullscreen, exitKey}` are options; everything else is props |
| `@termuijs/testing` `render()` | `lastFrame()`, `pressKey()`, `unmount()` |

### Does **not** work in the JSX model

| | failure |
|---|---|
| `Markdown` | `Class constructor Markdown cannot be invoked without 'new'` |
| most of `@termuijs/ui` | imperative classes: `new Select(...)` + `app.events.on('key')` |

**Rule 9.1 — The widget catalogue is two libraries, not one.** Some widget classes are accepted by
the JSX runtime as components; the rest require the imperative `new App(root)` model with manual key
wiring. Probe before adopting — the docs do not distinguish them.

**Rule 9.2 — Typings describe the class side only.** As elements, widgets type-check against
`Partial<Style>` and reject `children`. Alias once per file with a comment; never scatter
suppressions:

```ts
type WidgetProps = Record<string, unknown> & { children?: unknown };
const Panel = Box as unknown as (props: WidgetProps) => unknown;
const Line  = Text as unknown as (props: WidgetProps) => unknown;
```

**Rule 9.3 — JSX comes from a per-file pragma.** The repository's `tsconfig.json` points JSX at React
for the web app. `/** @jsxImportSource @termuijs/jsx */` at the top of the file is what lets both
exist without either knowing about the other.

**Rule 9.4 — TermUI is `external` in the bundler and imported dynamically.** Inlining ~5 MB of
framework would put its parse cost on every `nova --version`. Declared in `dependencies`, excluded
from the bundle, loaded when a screen is actually opened. Verified: bundle 3.08 → 3.15 MB, startup
unchanged.

---

## 10. Fallback

**Rule 10.1 — Every screen has a text path, and the text path is chosen automatically.**

```
/guide            → screen if TTY and the import resolves; printed index otherwise
/guide <topic>    → always printed (Rule 0.2)
/workspace        → screen if TTY and the import resolves; a plain refusal otherwise
```

**Rule 10.2 — Failure to load the framework is not an error the user has to understand.** A missing
or broken `@termuijs/*` falls back silently where a fallback exists, and says one plain sentence
where it does not.

**Rule 10.3 — A screen returns the terminal exactly as it found it.** Pause readline, uninstall
shortcuts, exit the pinned region on the way in; resume, reinstall, re-enter and redraw the status
line in a `finally` on the way out. Shortcuts are *reinstalled*, not merely re-enabled — the
framework tears down the stdin listeners it borrowed.

---

## 10b. Lists that come from somewhere else

**Rule 10b.1 — A list of choices is the union of what you know and what the source reports.** The
model picker was built from the *price* catalog, so a model was only offerable if someone had
written down what it cost. That is backwards: providers ship models faster than any price table is
updated, and the missing ones are disproportionately the new ones people want.

**Rule 10b.2 — Show what you cannot price, and say so.** "I do not know what this costs" is true and
useful. Hiding the model is neither.

**Rule 10b.3 — Known order first, fetched order appended.** The known order was *chosen* — the
provider's default first — and a live list is alphabetical noise by comparison. A list people have
learned must not reshuffle because a provider shipped something.

**Rule 10b.4 — Never let a provider hold the prompt.** Every request is raced against a timeout,
every failure is a reported reason rather than an exception, and one provider failing must not cost
the others. Fetching happens in the background at startup and on demand with `refresh`.

**Rule 10b.5 — Cache with a TTL, write atomically, and treat a future timestamp as stale.** A
half-written cache read by the next session is a parse error at startup; a cache stamped in the
future is a clock that moved.

**Rule 10b.6 — Filter what would fail one turn later.** `text-embedding-3-large` in a menu of things
to talk to is a mistake offered to the user, and the error arrives one turn later from three layers
down.

**Rule 10b.7 — Do not double the version segment.** OpenAI-compatible gateways are configured with
the base *including* `/v1`, because that is what the official SDKs take. Appending `/v1/models`
blindly gives `/v1/v1/models`, which 404s in a way that looks like the provider being down.

---

## 10c. Menus

The chooser, the palette and the model picker are one menu wearing three sets of clothes. Each grew
its own arithmetic, which is how two of them wrapped on a narrow terminal while the third did not.

**Rule 10c.1 — A digit is a shortcut only where it cannot be text.** In a filterable list `5` must
narrow, not jump: `gpt-5.6` and `claude-4-5` are otherwise unfindable, and a cursor that moves
mid-word is the whole "the menu selected the wrong thing" report. Numbers stay the accessible path
in every menu that does not filter, and in a filtering one until the query starts.

**Rule 10c.2 — The number on screen is the number pressed.** Rows are numbered by position *in the
window*, and the key handler and the renderer share one `windowStart()`. They used to compute it
separately, so past the first screenful a digit jumped to a row that was not visible. A digit past
the live window height is ignored — pressing `9` in a four-row window must not teleport.

**Rule 10c.3 — Escape clears the filter before it cancels the menu.** Same rule as §4.4.

**Rule 10c.4 — Clip every row; never wrap one.** A wrapped row costs the repaint a line it did not
reserve, which is what leaves a stripe of the previous frame on screen. The label is clipped first
and the tail takes the remainder, so a long description cannot hide the label it belongs to.

**Rule 10c.5 — Clip before painting.** Cutting a coloured string mid-sequence bleeds that colour
down the page.

**Rule 10c.6 — Pad by visible width, never `.length`.** `日本語` is three characters and six
columns. A test that measures alignment must also count cells, or it reports a misalignment the
terminal never shows.

**Rule 10c.7 — The selection is clamped when it is used, not merely when it is moved.** A selection
left over from a longer list resolves to `undefined`, and an Enter that silently cancels is
indistinguishable from a broken menu.

**Rule 10c.8 — Width comes from the caller.** The renderers are pure; asking the process how wide it
is belongs at the call site.

**Rule 10c.9 — Re-read geometry before every frame.** Capture width/height only at open and a live
resize leaves the next paint using stale columns — rows wrap, numbers disagree with the window, and
the selection scrolls off screen. Menus take an optional `getSize()` and clamp their window height
to the current viewport on every keystroke.

**Rule 10c.10 — Respect the real terminal, including sub-20 columns.** A minimum floor of 20 was a
lie in embedded and split panes; clip to what the terminal actually has.

**Exception — palette Escape.** The command palette dismisses on the first Escape and hands the
typed query back via `onDismiss`, because it is often opened mid-line by `/` and Escape means "not
this menu" rather than "clear my filter". Chooser-style filterable lists still follow §10c.3.

---

## 11. Testing

Three levels, and each answers a question the others cannot.

### Unit — pure functions, string comparison
Layout, wrapping, key mapping, frame composition, parsing. Fast, exact, no framework.

### In-memory — `@termuijs/testing`
That the model's decisions reach a screen. *A component that computes the right page and renders an
empty box looks identical from the outside to one that works.*

### pty — the real binary under `node-pty`
That the CLI actually reaches any of it. Escape sequences, raw mode, SIGWINCH, terminal echo.

**Rule 11.1 — Assertions strip ANSI; waits must not.** `waitFor` runs against the raw buffer, so a
pattern must never straddle a colour boundary — `answer = 42` never appears contiguously because
syntax highlighting wraps `42` in its own escape. Wait on a span nothing colours; assert on stripped
text.

**Rule 11.2 — The terminal echoes typed input.** Waiting for `/nebula/` after typing `/theme nebula`
is satisfied by the keystrokes. Wait for something only the *response* prints — a colour code, a
rendered word.

**Rule 11.3 — Take the "since" marker after the answer, not before the request.** The prompt drawn
when a turn was submitted is still in the buffer and satisfies a prompt-wait immediately.

**Rule 11.4 — Send one key, wait, send the next.** Keystrokes written together arrive at the input
parser as one chunk; a test that assumes its own write order is testing its timing.

**Rule 11.5 — Quote phrases that survive wrapping.** A long quote straddles a line break in a narrow
column and fails for a reason that has nothing to do with the code.

**Rule 11.6 — Input reaching a turn is not input reaching the prompt.** Typed mid-turn it is echoed
and dropped. Wait for the prompt before sending a command.

**Rule 11.7 — Benchmark on the runtime you are comparing against.** A baseline recorded on node 24
compared against node 22 reported a fake 136% regression. Build `HEAD` in a worktree and compare
like for like.

---

## 12. Checklist for a new screen

1. Model file. Pure. No framework import. Snapshot type, actions, `keyTo…`, `apply…`, `compose…Frame`.
2. Tests for the model: frame height, uniform row width, footer position, key mapping in every mode,
   empty state, narrow window.
3. `.tsx`. Pragma. Widget aliases. `useState` + `useInput` + `useInterval`. Map rows to `<Line>`.
   No logic.
4. In-memory tests: content reaches the frame, keys reach the model, exits when asked.
5. Entry point in `nova.ts`: TTY check → dynamic import → `statusBar.clear()`, `screen?.exit()`,
   `uninstallShortcuts()`, `readline.pause()` → run → `finally` restore all four.
6. pty test: opens, does something, gives the terminal back, session still answers.
7. Register in `commands.ts`. Cover it in `guide.ts` — the coverage test fails otherwise.

---

## 13. What is deliberately not done

- **No alt-screen by default.** The transcript is the product.
- **No background painting in the transcript.** Rule 5.5.
- **No fifth hierarchy level.** Rule 8.
- **No imperative TermUI widgets** while the screens use hooks. Mixing the two models means holding
  widget instances across renders and wiring keys twice. Revisit when either the model or the
  library settles.
- **No model-id validation.** Providers ship new ids constantly; an allowlist rejects tomorrow's
  model. Providers *are* validated — a key either exists or it does not.
