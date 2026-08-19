import { renderBanner, renderTagline, type ColorDepth } from "./banner";
import { barChart, heatStrip, lineChart, plotSeries, scatterChart, waveLine } from "./charts";
import { renderChooser, INITIAL_CHOOSER_STATE, type ChooserItem } from "./chooser";
import { composeDefenderFrame, newDefenderState } from "./defender-screen";
import { renderCode, renderDiff, diffLines } from "./code-view";
import { renderDropup } from "./dropup";
import { renderExpandableList } from "./expandable";
import { ASCII_GLYPHS, UNICODE_GLYPHS, type GlyphSet } from "./glyphs";
import { renderMarkdown } from "./markdown";
import { renderPatch } from "./patch-view";
import { heading, keyValues, note, panel, rule, type SectionStyle } from "./sections";
import { INITIAL_TABLE_STATE, renderTable, tableHelpView } from "./table";
import { renderTabStrip } from "./tabs";
import { box, formatStatusLine, joinHorizontal, novaSpinnerFrame, paginator, progressBar, renderPromptBox, sparkline, stepProgress, table } from "./tui";
import { NO_COLOR_PALETTE } from "./theme";

/**
 * Every component, drawn once, so someone can look at them.
 *
 * The tests assert what a component *contains*; they cannot see that a border is one column short,
 * that a title collides with a badge at 40 columns, or that a chart is illegible without colour.
 * Those are the failures a component library actually has, and the only way to catch them is to
 * render everything and look — which is impractical unless the rendering is one command.
 *
 * So this is a screen, not a test: `nova --gallery`, and `nova --gallery --ascii --no-color` for the
 * fallbacks, which is where the breakage usually is. Everything is drawn at the width it is given,
 * because "does this survive a narrow terminal" is the question being asked.
 */

export type GalleryOptions = {
  width: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
};

const SAMPLE_PATCH = `diff --git a/src/parser.ts b/src/parser.ts
index 1111111..2222222 100644
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -10,7 +10,8 @@ export function parse(source: string) {
   const tokens = tokenize(source);
-  const total = tokens.length + 1;
-  if (total > limit) return null;
+  const total = tokens.length - 1;
+  if (total >= limit) throw new ParseError(source, total);
   return { tokens, total };
 }
`;

const SAMPLE_MARKDOWN = [
  "## What changed",
  "",
  "The parser now **throws** instead of returning `null`, because a silent `null` was",
  "being read as an empty document three call sites away.",
  "",
  "- `parse()` throws `ParseError`",
  "- `total` is off-by-one no longer",
  "",
  "```ts",
  "if (total >= limit) throw new ParseError(source, total);",
  "```",
].join("\n");

function section(title: string, style: SectionStyle, body: readonly string[]): string {
  return [heading(title, 2, style), ...body, ""].join("\n");
}

/** The whole catalog as one string, ready to print. */
export function renderGallery(options: GalleryOptions): string {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const depth = options.depth;
  const width = Math.max(24, Math.floor(options.width));
  const style: SectionStyle = { width, depth, glyphs };
  // Identity paint: the gallery is for looking at *shape*. Colour is exercised by the depth
  // argument the components take themselves, and a paint object that added its own would make the
  // no-colour variant a lie.
  const plain = (text: string) => text;
  const paint = { dim: plain, cyan: plain, green: plain, yellow: plain, bold: plain };
  const parts: string[] = [];

  parts.push(renderBanner({ depth, glyphs, width }), renderTagline("a coding agent that runs in your terminal", depth), "");

  parts.push(section("rules, headings, notes", style, [
    rule(style, { label: "labelled", tone: "accent" }),
    heading("level one", 1, style),
    heading("level two", 2, style),
    heading("level three", 3, style),
    note("a neutral note", style),
    note("something went wrong", style, "bad"),
    note("that worked", style, "good"),
    rule(style, { trailing: `3 files ${glyphs.middot} +12 -4` }),
  ]));

  parts.push(section("panels and boxes", style, [
    panel(["first line", "second line"], style, { title: "panel", badge: "+12 -4", tone: "accent" }),
    panel(["gutter only, no frame"], style, { title: "output", gutterOnly: true }),
    box(["a box with a title", "and a second row"], { depth, width, title: "you", titleColor: "green", glyphs }),
    box(["a box whose border carries the state"], { depth, width, title: "failed", titleColor: "red", borderColor: "red", glyphs }),
    box(["double border"], { depth, width, title: "double", glyphs, borderStyle: "double" }),
  ]));

  parts.push(section("key/value and tables", style, [
    keyValues([["provider", "anthropic"], ["model", "claude-opus-5"], ["workspace", "/home/you/project"]], style),
    table(["model", "input", "output"], [["opus-5", "$15.00", "$75.00"], ["sonnet-5", "$3.00", "$15.00"], ["haiku-4.5", "$0.80", "$4.00"]], { depth, width, glyphs }),
    renderTable(
      [{ title: "model" }, { title: "input", align: "right" }, { title: "output", align: "right" }],
      [
        ["claude-opus-5", "15.00", "75.00"],
        ["claude-sonnet-5", "3.00", "15.00"],
        ["claude-haiku-4.5", "0.80", "4.00"],
      ],
      { ...INITIAL_TABLE_STATE, selected: 1, sort: { column: 1, direction: "desc" } },
      { width, height: 6, paint, glyphs },
    ),
  ]));

  const chooserItems: ChooserItem<string>[] = [
    { label: "starry-night", hint: "the default", value: "a" },
    { label: "starry-dawn", hint: "light", value: "b" },
    { label: "nebula", hint: "purple", value: "c" },
    { label: "high-contrast", hint: "accessible", value: "d" },
  ];
  parts.push(section("choosers and menus", style, [
    renderChooser({ ...INITIAL_CHOOSER_STATE, selected: 1 }, chooserItems, { title: "theme", width, height: 6, paint, glyphs }),
    ...renderDropup([
      { command: "/diff", description: "what changed since the last checkpoint" },
      { command: "/undo", args: "[code|conversation]", description: "revert the last turn", chord: "Alt+Z" },
      { command: "/cost", description: "token and cost breakdown" },
    ], { width, selected: 0, paint, glyphs }),
    renderExpandableList([
      { id: 1, label: "written code", full: "", hidden: 40 },
      { id: 2, label: "command output", full: "", hidden: 210 },
    ], depth, glyphs),
    renderTabStrip([
      { id: 1, title: "parser", status: "running", unread: 0, active: true, model: "claude-opus-5" },
      { id: 2, title: "docs", status: "idle", unread: 3, active: false, model: "claude-haiku-4.5" },
      { id: 3, title: "release", status: "failed", unread: 12, active: false, model: "claude-sonnet-5", backend: "docker" },
    ], { width, glyphs, detail: true }),
  ]));

  parts.push(section("progress and status", style, [
    `spinner   ${Array.from({ length: 6 }, (_, index) => novaSpinnerFrame(index, glyphs)).join("  ")}`,
    `progress  ${progressBar(0.37, Math.min(40, width - 12), { depth, glyphs })}`,
    `steps     ${stepProgress(4, 9, { label: "plan", width: Math.min(24, width - 20), depth, glyphs })}`,
    `sparkline ${sparkline([3, 9, 4, 12, 7, 2, 14, 8], glyphs)}`,
    `pages     ${paginator(2, 6, { style: "dots", glyphs })}   ${paginator(2, 6)}`,
    formatStatusLine(
      { mode: "build", spinnerGlyph: novaSpinnerFrame(2, glyphs), elapsedMs: 12_400, toolCalls: 7, tokens: 24_000, cost: "$0.14", phase: "operation", operation: "run_command", steps: { done: 4, total: 9, label: "plan" } },
      width, depth, glyphs,
    ),
    ...(() => {
      const promptBox = renderPromptBox({ mode: "build", workspace: "~/project", width, depth, glyphs, status: `12.4s ${glyphs.middot} $0.14` });
      return [promptBox.top, `${promptBox.prefix}fix the failing parser test`, promptBox.bottom];
    })(),
  ]));

  const latency = [42, 38, 51, 47, 66, 61, 58, 72, 69, 64, 80, 77, 71, 66, 60, 55];
  parts.push(section("charts", style, [
    ...barChart([{ label: "read_file", value: 42 }, { label: "run_command", value: 18 }, { label: "edit_file", value: 9 }], { width: Math.min(60, width), depth, glyphs }),
    "",
    ...lineChart(latency, { width: Math.min(60, width), height: 5, depth, glyphs }),
    "",
    ...plotSeries([{ values: latency }, { values: latency.map((value) => value * 0.4 + 10) }], { width: Math.min(60, width), height: 5, depth, glyphs }),
    "",
    ...scatterChart(latency.map((value, index) => ({ x: index * index, y: value })), { width: Math.min(60, width), height: 5, depth, glyphs }),
    "",
    `waveline  ${waveLine(latency, { width: Math.min(40, width - 12), glyphs })}`,
    "",
    ...heatStrip([{ label: "critical", value: 3 }, { label: "high", value: 8 }, { label: "medium", value: 14 }], { width: Math.min(60, width), depth, glyphs }),
  ]));

  parts.push(section("defender triage", style, [
    ...composeDefenderFrame(
      {
        ...newDefenderState([
          { path: "src/config.ts", line: 42, kind: "AWS access key", masked: "AKIA\u20267Q2P", severity: "critical" },
          { path: "src/maps.ts", line: 7, kind: "Google API key", masked: "AIza\u2026kk31", severity: "high" },
          { path: "tests/fixtures.ts", line: 3, kind: "credential-looking assignment", masked: "pass\u2026word", severity: "medium" },
        ], width, 24),
        columns: width,
      },
      style,
    ),
  ]));

  parts.push(section("code, diffs and markdown", style, [
    renderCode("export function parse(source: string) {\n  return tokenize(source);\n}", style, { language: "ts", startLine: 10 }).text,
    renderDiff(diffLines("const total = tokens.length + 1;", "const total = tokens.length - 1;"), style).text,
    renderPatch(SAMPLE_PATCH, style, { title: "diff" }).text,
    renderMarkdown(SAMPLE_MARKDOWN, { width, depth, glyphs }),
  ]));

  return parts.join("\n");
}

/** The fallback matrix: the four combinations where rendering usually breaks. */
export function galleryVariants(width: number): Array<{ title: string; options: GalleryOptions }> {
  return [
    { title: `unicode · colour · ${width} columns`, options: { width, depth: "truecolor", glyphs: UNICODE_GLYPHS } },
    { title: `unicode · no colour · ${width} columns`, options: { width, depth: "none", glyphs: UNICODE_GLYPHS } },
    { title: `ascii · no colour · ${width} columns`, options: { width, depth: "none", glyphs: ASCII_GLYPHS } },
    { title: "unicode · colour · 40 columns", options: { width: 40, depth: "truecolor", glyphs: UNICODE_GLYPHS } },
  ];
}

/** Unused import guard: the palette is exported for callers that want the themed variant. */
export const GALLERY_PALETTE = NO_COLOR_PALETTE;
