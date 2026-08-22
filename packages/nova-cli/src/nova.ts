#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NovaAgent, type NovaEvent } from "@circuit-nova/nova-core/nova-cli/agent";
import { runAcpServer } from "./acp-server";
import { priceSessionModelTurns, readSessionModelTurns } from "./resumed-spend";
import { renderGallery } from "./gallery";
import { displayMask, fixObjective } from "./defender-screen";
import { CommandUsage, isEssential, navSignals, rankWithContext, renderAsks, renderEssentials, renderGroupedHelp, renderHint, renderRecovery, renderStarters, renderSuggestions, type NavContext } from "./navigation";
import { askModelForSuggestions, mergeModelSuggestions, type Suggestion as EngineSuggestion } from "@circuit-nova/nova-core/nova-cli/suggestions";
import type { ModelUsage } from "@circuit-nova/nova-core/providers/model";
import { NovaSessionDaemon, type DaemonApprovalRequest, type DaemonNotification, type NovaDaemonClient } from "@circuit-nova/nova-core/nova-cli/daemon";
import type { NovaMode, PermissionDecision } from "@circuit-nova/nova-core/nova-cli/permissions";
import { assessTaskSafety, type SafetyAssessment } from "@circuit-nova/nova-core/nova-cli/safety";
import { listSessions, loadSession, type SessionRecord } from "@circuit-nova/nova-core/nova-cli/session";
import { catalogPrices, describeProviders, PRICE_ENVIRONMENT_HINT, PROVIDER_IDS, resolveProvider, type ProviderId } from "@circuit-nova/nova-core/providers/agent-matrix";
import { convertTo, fromUnits, formatMoney, isCurrency, type Currency, type FxRate, type Money } from "@circuit-nova/nova-core/money";
import { createExaClient } from "@circuit-nova/nova-core/providers/exa";
import { downloadProject, DockerWorkspace, E2BWorkspace, LocalWorkspace, uploadProject, type NovaWorkspace } from "@circuit-nova/nova-core/nova-cli/backends";
import type { AgentRuntimeResult } from "@circuit-nova/nova-core/agent-runtime";
import { CostLedger } from "@circuit-nova/nova-core/nova-cli/cost";
import { EXIT_CODES, HeadlessEmitter, exitCodeForStatus } from "./headless";
import { buildModelCatalog, describePrice, matchModelQuery, modelsForProvider, parseModelCommand, type ModelChoice } from "./models";
import { buildPickerRows, type PickerResult } from "./model-picker";
import { INITIAL_TABLE_STATE, renderTable } from "./table";
import { buildCostTable, buildJobsTable, buildModelTable } from "./tables";
import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";
import { detectColorDepth, renderBanner, renderTagline } from "./banner";
import { box, CountdownTimer, formatCountdown, formatStatusLine, MarkdownStream, progressBar, PromptBox, PROMPT_PREFIX_COLUMNS, promptStatusRoom, renderPromptBox, ReplaceableBlock, sparkline, Spinner, SpringAnimator, StatusBar, table, wrapPlain } from "./tui";
import { dropupRowBudget, renderDropup, type DropupEntry } from "./dropup";
import { visibleWidth } from "./markdown";
import { PinnedScreen } from "./screen";
import { barChart, heatStrip, lineChart } from "./charts";
import { describeToolCall, summarizeToolResult } from "./transcript";
import { renderMarkdown } from "./markdown";
import { completeInput, inlineCompletion, isKnownCommand, parseModeCommand, renderCommandHelp, renderKeyboardShortcuts, suggestCommand, suggestionsFor } from "./commands";
import { KeyBindingRegistry, parseBindingOverrides } from "./keybindings";
import { installShortcuts, openChooser, openDefenderTriage, openModelPicker, openPalette, openTable, replaceLine, withBorrowedKeyboard } from "./shortcuts";
import { runChooser, type ChooserItem } from "./chooser";
import { doctorExitCode, renderDoctor, runDoctor } from "./doctor";
import { hostOf, providerBaseUrl } from "./endpoints";
import { fetchDailyFxRate, resolveCurrencyPreference, type FxLookupFailure } from "./local-currency";
import { classifyNetworkError } from "./network";
import { NOVA_CLI_VERSION, runSelfUpdate } from "./update";
import { MODEL_FIELD_PROVIDER, SETTING_FIELDS, loadSettings, mergedEnvironment, runSettingsMenu, saveSettings, settingsFile, type NovaSettings, type SettingChoice, type SettingKey, type SettingsPrompts } from "./settings";
import { loadHistory, saveHistory } from "./history";
import { renderTabStrip, parseTabCommand, SEQUENTIAL_TABS_NOTE, shortModel, WorkspaceController } from "./tabs";
import { OutputRouter, TabSink, replayLines, terminalStream } from "./output";
import { renderPatch } from "./patch-view";
import { fetchProviderModels, fetchableProviders, isCacheFresh, loadLiveModels, mergeModelLists, readModelCache } from "@circuit-nova/nova-core/providers/model-fetch";
import { JobStream, WatchRegistry, sandboxWarning } from "./job-stream";
import { PaneActivity, tabPanes, type WorkspaceSnapshot } from "./workspace-model";
import { explainScreenRefusal, withFullScreen, type ScreenCapabilities, type TerminalControls } from "./screen-host";
import { findTopic, parseGuideCommand, renderGuideIndex, renderGuideTopic, renderWholeGuide, searchTopics } from "./guide";
import { DEFAULT_THEME_NAME, NO_COLOR_PALETTE, buildPalette, detectPreferredTheme, findBuiltinTheme, parseColor, parseThemeCommand, type Palette, type Rgb } from "./theme";
import { discoverThemes, findTheme, themeDirectory } from "./theme-files";
import { buildWanderPrompt, gatherWanderEvidence, parseWanderCommand, renderWanderResults, wanderJobObjective } from "./wander";
import { WANDER_LAB_FILES } from "@circuit-nova/nova-core/wander";
import {
  appendJobLog,
  cancelJob,
  enqueueJob,
  finishJob,
  getJob,
  isTerminal,
  jobLogPath,
  listJobs,
  newJobId,
  readJobLog,
  resolveJobApproval,
} from "@circuit-nova/nova-core";
import { runJobWorkerForever, workerId } from "./job-worker";
import { parseAttachCommand, parseDetachCommand, parseJobsCommand } from "./jobs-command";
import { BILLING_NOT_CONFIGURED, parsePayCommand, renderBalance, renderCheckout, renderPaymentOutcome, renderTopUpQuote } from "./pay";
import { BillingError, billingFromEnvironment, newIdempotencyKey, waitForPayment } from "@circuit-nova/nova-core/nova-cli/billing";
import { IMPLICIT_SKILL_PROVIDER_ID } from "@circuit-nova/nova-core";
import { renderTools } from "./tools-command";
import { removeRecording, startRecording, transcribeAudio } from "./voice";
import { controlLabel, resolveControlLanguage, type ControlLanguage } from "./i18n";
import { UNICODE_GLYPHS, resolveGlyphs, type GlyphSet } from "./glyphs";
import { GUTTER, heading, note, panel, rule, type SectionStyle } from "./sections";
import { describeChange, diffLines, diffStat, renderFileChange } from "./code-view";
import { parseTestOutput, renderTestReport } from "./test-report";
import { ExpandableStore, expandHint, parseExpandCommand, renderExpandableList } from "./expandable";
import {
  addMemory,
  clearMemories,
  describeAdded,
  forgetMemory,
  loadMemories,
  memoryFile,
  memoryPromptBlock,
  parseMemoryCommand,
  recallMemories,
  recalledMemoryKey,
  replaceMemory,
  renderMemories,
  type MemoryEntry,
} from "./memory";
import {
  parseHistoryCommand,
  relativeTime,
  renderHistoryList,
  renderHistoryUsage,
  renderReplay,
  searchHistory,
  summarizeSession,
  type HistoryCommand,
  type HistoryEntry,
} from "./chat-history";
import { applyPacing, describePace, exceedsPace, paceBadge, parsePaceCommand, parsePaceFlag, remainingCooldown, type PaceLevel } from "./pacing";
import { CliStateHistory } from "./state-history";

/**
 * Nova CLI — the terminal front end.
 *
 * Everything that decides what the agent may do lives in `lib/nova-cli`; this file only reads
 * input, renders output, and asks the human when the agent needs permission. Keeping the boundary
 * there is what allows a second front end (an editor extension, an HTTP server in OpenCode's
 * shape) to be added later without re-litigating any of the safety behaviour.
 */

const RESET = "[0m";

/**
 * Whether output is going somewhere that can render colour and be drawn on.
 *
 * `banner.ts` has always honoured this and `style` never did, so piping Nova's output still wrote
 * escape codes into whatever was reading it. Both now answer to the same switch.
 */
let colorEnabled = false;
let liveTerminal = false;

const wrap = (code: string) => (value: string) => (colorEnabled ? `${code}${value}${RESET}` : value);

/**
 * The palette in force. Replaced whenever a theme is chosen, which is why `role` below reads it
 * through a getter rather than closing over a code: a `/theme` typed mid-session has to change the
 * next line printed, not the next session started.
 */
let palette: Palette = NO_COLOR_PALETTE;
const role = (pick: () => string, fallback: string) => (value: string) => {
  if (!colorEnabled) return value;
  return `${pick() || fallback}${value}${RESET}`;
};

/**
 * Colour, by the job it does.
 *
 * The four colour names are kept as they were — a hundred and fifty call sites say `style.cyan` —
 * but each now resolves through the theme's corresponding *role*, which is what lets a theme change
 * the whole transcript without any of those call sites being touched. `dim` and `bold` stay literal:
 * they are weights, not colours, and a theme that recoloured them would give Nova's subordinate text
 * a second voice competing with its first.
 */
const style = {
  dim: wrap("\x1b[2m"),
  bold: wrap("\x1b[1m"),
  // Not themed: the "this call leaves the sandbox" mark is a rare, informational blast-radius
  // signal, not part of the transcript's usual colour vocabulary a theme should be free to recolour.
  magenta: wrap("\x1b[35m"),
  cyan: role(() => palette.primary, "\x1b[36m"),
  green: role(() => palette.success, "\x1b[32m"),
  yellow: role(() => palette.warning, "\x1b[33m"),
  red: role(() => palette.error, "\x1b[31m"),
  accent: role(() => palette.accent, "\x1b[33m"),
};

/**
 * The four colours and one weight every menu, list and table renderer is handed.
 *
 * Named once here because three surfaces now want the same object and each was building its own
 * literal — and a renderer given `bold` by one caller and not another paints its selected row
 * differently on two screens for no reason a reader could discover.
 */
const surfacePaint = { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow, bold: style.bold };

/** Where a piece of work actually runs: this machine, a throwaway remote sandbox, or a container. */
export type SandboxBackend = "local" | "e2b" | "docker";

/** How a tab's location reads in prose — the answer to "where are these edits landing?". */
export function describeLocation(backend: SandboxBackend): string {
  if (backend === "e2b") return "in a remote E2B sandbox";
  if (backend === "docker") return "in a local container";
  return "on this machine";
}

type ParsedArgs = {
  mode: NovaMode;
  /** Speak the Agent Client Protocol on stdio instead of running a terminal session. */
  acp: boolean;
  /** Draw every UI component once and exit, for looking at rendering rather than behaviour. */
  gallery: boolean;
  prompt: string | null;
  resume: string | null;
  historyCommand: HistoryCommand | null;
  listSessions: boolean;
  listProviders: boolean;
  doctor: boolean;
  update: boolean;
  checkUpdate: boolean;
  settings: boolean;
  estimateOnly: boolean;
  updateYes: boolean;
  packageManager: string | undefined;
  version: boolean;
  root: string;
  help: boolean;
  /**
   * Where files are written: this machine, a throwaway remote E2B sandbox, or a local Docker
   * container — the last being the option for keeping work off the working tree without sending it
   * to a third party, which is the only isolation some environments will accept.
   */
  backend: SandboxBackend;
  /** Image for `--sandbox docker`. Overridable because no single image suits every project's toolchain. */
  dockerImage: string;
  /** Seed the sandbox with the local project instead of starting empty. */
  upload: boolean;
  /** Sandbox image to start, by workspace preset id. */
  preset: string | undefined;
  sandboxMinutes: number;
  /** Session ceiling in the display currency; the agent stops rather than spending past it. */
  budget: number | undefined;
  provider: string | undefined;
  model: string | undefined;
  currency: Currency | undefined;
  country: string | undefined;
  language: string | undefined;
  /** Explicit task-level consent for non-interactive sensitive work; tool gates still apply. */
  allowSensitive: boolean;
  /**
   * How fast the agent is allowed to spend.
   *
   * A pace, not a cap — `--budget` is the cap. This bounds how much work one turn may do before it
   * has to come back and report, which is the difference between a surprise and a decision.
   */
  pace: PaceLevel;
  /**
   * Force the ASCII glyph set regardless of what the environment claims.
   *
   * The detection in `glyphs.ts` is a heuristic over `LANG` and `TERM`, and a heuristic that gets it
   * wrong leaves someone reading `?` where a status mark should be. This is the escape hatch, and it
   * is a flag rather than only an environment variable because the person who needs it is looking at
   * broken output right now.
   */
  ascii: boolean;
  /** Theme name from `--theme`; absent means the terminal's own preference decides. */
  theme: string | undefined;
  /**
   * Pin the status footer to the bottom of the window.
   *
   * Off by default, and that default is a bug fix rather than a preference. The footer is held there
   * with `DECSTBM`, and a terminal only pushes lines into its scrollback when the scrolling region
   * is the *whole* screen — so reserving two rows for a footer silently cost the session every line
   * that scrolled past the top. Nothing could be scrolled back to, which is precisely what people
   * reported. The footer is worth having, but not at that price, so it is now something you ask for.
   */
  pin: boolean;
  /**
   * Machine-readable output: JSONL on stdout, human text on stderr, a stable exit code.
   *
   * Implies a single turn. A REPL that emits JSONL has nobody to read it, and the approval prompt
   * it would need is exactly what headless callers cannot answer.
   */
  json: boolean;
};

/** Shape of the ids `newSessionId` mints, e.g. `20260808T001720Z-2ubjpz`. */
const SESSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

/**
 * Image for `--sandbox docker` when neither `--docker-image` nor `DOCKER_CODING_IMAGE` says
 * otherwise. A plain Debian-slim base rather than a Nova-specific image: it exists on every Docker
 * install's reach, and a default that silently fails to pull is worse than a plain one that works.
 */
const DEFAULT_DOCKER_IMAGE = "debian:stable-slim";

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const acpRequested = argv[0] === "acp" || argv.includes("--acp");
  const updateRequested = argv[0] === "update" || argv.includes("--update") || argv.includes("--check-update");
  const settingsRequested = argv[0] === "settings" || argv.includes("--settings");
  const historyRequested = argv[0] === "history";
  const parsed: ParsedArgs = {
    mode: "build", prompt: null, resume: null, historyCommand: null, listSessions: false, listProviders: false, doctor: false,
    update: updateRequested, checkUpdate: false, updateYes: false, packageManager: undefined, version: false, settings: settingsRequested, estimateOnly: false,
    root: process.cwd(), help: false, pace: "off", ascii: false, theme: undefined, pin: false,
    acp: acpRequested,
    gallery: argv[0] === "gallery" || argv.includes("--gallery"),
    backend: "local", dockerImage: DEFAULT_DOCKER_IMAGE, upload: false, preset: undefined, sandboxMinutes: 30, budget: undefined, provider: undefined, model: undefined, currency: undefined, country: undefined, language: undefined, allowSensitive: false, json: false,
  };
  const rest: string[] = [];

  for (let index = argv[0] === "update" || argv[0] === "settings" || argv[0] === "acp" || argv[0] === "gallery" || historyRequested ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" || argument === "-p") parsed.mode = "plan";
    else if (argument === "--auto" || argument === "-y") parsed.mode = "auto";
    else if (argument === "--build") parsed.mode = "build";
    else if (argument === "--defender") parsed.mode = "defender";
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--version" || argument === "-v") parsed.version = true;
    else if (argument === "--settings") parsed.settings = true;
    else if (argument === "--acp") parsed.acp = true;
    else if (argument === "--gallery") parsed.gallery = true;
    else if (argument === "--estimate") parsed.estimateOnly = true;
    else if (argument === "--allow-sensitive") parsed.allowSensitive = true;
    else if (argument === "--json" || argument === "--headless") parsed.json = true;
    else if (argument === "--ascii" || argument === "--no-unicode") parsed.ascii = true;
    else if (argument === "--pin") parsed.pin = true;
    else if (argument === "--no-pin") parsed.pin = false;
    else if (argument === "--theme") {
      // A bare --theme takes the next word only when it looks like a theme name rather than the
      // start of the request, the same rule --sandbox and --slow already follow.
      const next = argv[index + 1];
      if (next && !next.startsWith("-") && /^[A-Za-z0-9_-]+$/.test(next)) { parsed.theme = next; index += 1; }
    }
    else if (argument === "--slow" || argument === "--pace") {
      // `--slow` on its own means the obvious thing; a value selects how slow.
      const level = parsePaceFlag(argv[index + 1]);
      if (level) { parsed.pace = level; index += 1; } else parsed.pace = "gentle";
    }
    else if (argument === "--update") parsed.update = true;
    else if (argument === "--check-update") { parsed.update = true; parsed.checkUpdate = true; }
    else if (argument === "--check" && updateRequested) parsed.checkUpdate = true;
    else if (argument === "--yes" && updateRequested) parsed.updateYes = true;
    else if (argument === "--package-manager" && updateRequested) { parsed.packageManager = argv[index + 1]; index += 1; }
    else if (argument === "--sessions") parsed.listSessions = true;
    else if (argument === "--providers") parsed.listProviders = true;
    else if (argument === "--doctor") parsed.doctor = true;
    else if (argument === "--resume") {
      // Only swallow the next word when it is actually a session id. Otherwise `nova --resume "fix
      // the test"` silently treats the request as an id, resumes nothing, and drops into the REPL.
      const next = argv[index + 1];
      if (next && (next === "latest" || SESSION_ID.test(next))) { parsed.resume = next; index += 1; }
      else parsed.resume = "latest";
    }
    else if (argument === "--cwd") { parsed.root = path.resolve(argv[index + 1] ?? "."); index += 1; }
    else if (argument === "--sandbox") {
      const value = argv[index + 1];
      // `--sandbox` on its own means the obvious thing; a value selects explicitly.
      if (value === "local" || value === "e2b" || value === "docker") { parsed.backend = value; index += 1; } else parsed.backend = "e2b";
    }
    else if (argument === "--upload") parsed.upload = true;
    else if (argument === "--image") { parsed.preset = argv[index + 1]; index += 1; }
    else if (argument === "--sandbox-minutes") { parsed.sandboxMinutes = Number(argv[index + 1] ?? 30); index += 1; }
    else if (argument === "--docker-image") { parsed.dockerImage = argv[index + 1] ?? DEFAULT_DOCKER_IMAGE; index += 1; }
    else if (argument === "--budget" || argument === "--max-rwf") { parsed.budget = Number(argv[index + 1] ?? 0) || undefined; index += 1; }
    else if (argument === "--provider") { parsed.provider = argv[index + 1]; index += 1; }
    else if (argument === "--model") { parsed.model = argv[index + 1]; index += 1; }
    else if (argument === "--currency") {
      const value = (argv[index + 1] ?? "").toUpperCase();
      if (isCurrency(value)) parsed.currency = value;
      index += 1;
    }
    else if (argument === "--location" || argument === "--country") { parsed.country = argv[index + 1]?.toUpperCase(); index += 1; }
    else if (argument === "--language" || argument === "--lang") { parsed.language = argv[index + 1]; index += 1; }
    else rest.push(argument);
  }
  if (historyRequested) parsed.historyCommand = parseHistoryCommand(`/history ${rest.join(" ")}`);
  else if (rest.length > 0) parsed.prompt = rest.join(" ");
  return parsed;
}

// A function, not a constant: it is built after `configureRendering` has learned whether the
// destination can render colour at all, which a module-level template literal would predate.
function helpText(language: ControlLanguage = "en", shortcuts: ReadonlyMap<string, string> = new Map()): string {
  // The module-level glyph set, which `configureRendering` has already resolved by the time this
  // is called — the reason this is a function rather than a constant.
  const star = glyphs.star;
  // Marked rather than reordered. This page is grepped and piped as often as it is read, so the
  // rows have to stay where they were; what changes is that a few of them are now findable.
  const mark = (command: string) => (isEssential(command) ? `${star} ` : "  ");
  return `
${style.bold("nova")} — a coding agent in your terminal

${style.bold("Start here")}
  ${star} nova settings           Paste an API key. Nothing runs until one is saved.
  ${star} nova                    Start a session, then just describe what you want
  ${star} nova --resume           Pick up the last session where it stopped
  ${star} /help                   Inside a session: everything you can do
  ${star} /undo                   Inside a session: take back the last turn's changes
  ${style.dim(`Everything below is here when you need it — these five are the ones you need first.`)}

${style.bold("Running it")}
  nova                      Start an interactive session
  nova "add a health check" Run one request and exit
  nova --plan               Plan mode: read and reason, never write
  nova --auto               Auto mode: ordinary edits apply; sensitive actions ask
  nova --defender           Defender mode: find and fix real security issues, every change still asks
  nova --allow-sensitive    Approve a flagged task preflight (tool guards still apply)
  nova --json "task"        One turn, JSONL on stdout for another program to read
  nova --resume [id]        Continue a previous session ("latest" by default)
  nova --sessions           List sessions in this project
  nova history [search Q]   Browse or search history without starting a model
  nova history status       Check the native index and portable fallback
  nova --cwd <dir>          Work in a different project root
  nova update               Check, confirm, and install the latest Nova CLI
  nova --update             Alias for nova update
  nova update --check       Check for an update without installing it
  nova update --yes         Update without an interactive confirmation
  nova --version            Print the installed CLI version

${style.bold("Where the files go")}
  nova acp                  Speak the Agent Client Protocol on stdio (for editors)
  nova gallery              Draw every UI component once, to see how this terminal renders it
  nova --sandbox            Work in a remote E2B sandbox, not on this machine
  nova --sandbox docker     Work in a local Docker container instead of a remote one
  nova --docker-image IMG   Image for --sandbox docker (or set DOCKER_CODING_IMAGE)
  nova --sandbox --upload   ...seeded with a copy of this project
  nova --image <preset>     Sandbox image to use (default: general)
  nova --sandbox-minutes N  Sandbox lifetime (default 30)

${style.bold("Model")}
  nova --provider <name>    ${PROVIDER_IDS.join(" | ")}
  nova --model <id>         Model to run (defaults to the provider's)
  /model                    Pick a model from a list, with prices, keeping the transcript
  /model <name>             Switch straight to one, e.g. /model opus
  nova --providers          Show which providers are configured, and what is missing
  nova --doctor             Test every endpoint Nova needs and name the one that fails
  nova settings             Configure keys, URLs, models, pricing and voice input

${style.bold("Cost")}
  nova --location EG        Select a country (auto-detected from your locale by default)
  nova --currency EGP       Select any supported ISO display currency
  nova --budget N           Approve and enforce a cap in the display currency
  nova --slow               Spend at a slower pace: fewer model rounds, smaller replies
  nova --slow strict        Slower still, with a pause between turns
  /slow [on|strict|off]     Change the pace mid-session
  nova --estimate "task"    Show a token/cost forecast without calling the model
  /cost                     Token and cost breakdown for this session

${style.bold("Memory and history")}
  # we use bun, not npm     Remember a fact for every future session in this project
  /memory                   Everything remembered, project and personal, with numbers
  /memory add --user <fact> Remember something about you rather than about this project
  /memory forget N          Drop one entry
  /history                  Past conversations in this project
  /history search <text>    Find one by what you asked for
  /history <id>             Read a past conversation back
  /history resume           Pick one up where it stopped
  /history status           Show whether native indexed history or JSON fallback is active

${style.bold("Reading the transcript")}
  /expand [N|all|list]      Unfold written code, a test run, or a long result
  nova --ascii              Draw with plain ASCII when the terminal mangles symbols
  nova --theme nebula       Start in a named theme (/theme list shows them all)
  nova --pin                Pin the status line to the bottom row. Costs the terminal's
                            scrollback: a reserved footer means scrolled-off lines are
                            never saved, so this is off unless you ask for it.
                            (or set NOVA_GLYPHS=ascii)

${style.bold("Headless output")}
  With --json, stdout carries one JSON object per line and nothing else; everything
  a person would read goes to stderr. Exit codes are stable:
    0 completed   1 failed    2 usage         3 blocked
    4 unverified  5 approval  6 limit hit     7 cancelled

${style.bold("In a session")}  ${style.dim(`(${star} marks the ones to learn first)`)}
${renderCommandHelp(language, shortcuts, { mark })}
`;
}

/**
 * Everything that can occupy the last rows of the screen, and therefore has to be closed or
 * cleared before anything else prints there.
 *
 * `markdown` holds a partial assistant line, `toolLine` holds a tool call awaiting its result,
 * and `statusBar` holds the spinner. They are module state for the same reason `renderEvent` is a
 * module function: the renderer is one thing with one screen, and threading three cursors through
 * every call site is how the two of them fall out of step.
 *
 * `screen` is undefined outside a real interactive TTY session — a one-shot `nova "..."` run, a
 * pipe, `--estimate` — every one of which prints a few lines and exits, where a pinned footer would
 * be pure overhead with nothing to keep separately scrolled from. `statusBar`'s own erase-above-
 * cursor redraw stays the fallback for exactly that case; `screen`, when present, takes over
 * instead — `statusBar.clear()`'s calls elsewhere stay in place and are simply harmless no-ops once
 * nothing is ever drawn through it.
 */
/**
 * Every line this file prints, addressed to a sink rather than to the process.
 *
 * The renderers below are module state because there is one screen; `out` is module state for the
 * same reason and one more: it is the seam that makes a second piece of work *possible*. Until the
 * writes went through here, a tab that was not in front had nowhere to put its output except on top
 * of the tab that was — which is why `tabs.ts` had to call itself sequential. Re-pointing this once
 * per tab switch is the whole of the mechanism.
 *
 * `statusBar`, `spinner` and `screen` are deliberately *not* routed: they are the pinned furniture
 * of the terminal itself — one status bar, one spinner, describing whatever is in front — rather
 * than transcript content belonging to a piece of work.
 */
const out = new OutputRouter(terminalStream);
const statusBar = new StatusBar();
const toolLines = new ReplaceableBlock(out);
let markdown = new MarkdownStream(out, "none");
let spinner: Spinner | undefined;
let screen: PinnedScreen | undefined;
/**
 * The characters and the colour depth this terminal was found to support.
 *
 * Module state for the same reason `markdown` and `statusBar` are: there is one screen, and a
 * renderer that has to be told what it can draw at every call site is a renderer where one call
 * site will eventually be told wrong. `configureRendering` sets both from the environment once.
 */
let glyphs: GlyphSet = UNICODE_GLYPHS;
let renderDepth: ReturnType<typeof detectColorDepth> = "none";
/** Folded blocks from this session, addressable by `/expand`. */
const expandables = new ExpandableStore();

/** Wrapping width for prose: the pinned screen's golden-ratio-capped measure, or the raw terminal otherwise. */
function contentWidth(): number {
  return screen?.current.contentWidth ?? (process.stdout.columns ?? 80);
}
const activity: { awaitingFirstDelta: boolean; toolCalls: number; tokens: number; phase: "thinking" | "operation"; operation?: string; steps?: { done: number; total: number; label?: string } } = {
  awaitingFirstDelta: false,
  toolCalls: 0,
  tokens: 0,
  phase: "thinking",
};
/**
 * Announced calls awaiting their result, by call id, so each can be rewritten where it sits.
 *
 * The arguments are held alongside the line handle because the *result* is where the transcript
 * shows what a write actually contained — by then the call event is long gone, and re-reading the
 * file to find out would be both a round trip and a different answer.
 */
const pendingCalls = new Map<string, {
  line: number;
  detail: string;
  name: string;
  arguments: Record<string, unknown>;
  effect: "none" | "workspace" | "external";
  /** Part of a batch fired while another call was still open — drawn with a connecting bar. */
  lane: boolean;
}>();
/** Paths successfully written or edited this turn, for the "files modified" footer. */
let touchedFiles = new Set<string>();

/** Points the renderer at the colour depth, glyph repertoire and terminal the session actually has. */
export function configureRendering(
  depth: ReturnType<typeof detectColorDepth>,
  live: boolean = Boolean(process.stdout.isTTY),
  glyphSet: GlyphSet = UNICODE_GLYPHS,
  themePalette: Palette = NO_COLOR_PALETTE,
): void {
  colorEnabled = depth !== "none";
  liveTerminal = live;
  glyphs = glyphSet;
  renderDepth = depth;
  palette = themePalette;
  markdown = new MarkdownStream(out, depth, contentWidth, live, glyphSet);
}

/** The width/depth/glyph triple every section renderer takes, from the live terminal. */
function sectionStyle(): SectionStyle {
  return { width: contentWidth(), depth: renderDepth, glyphs, palette };
}

function endStreamedLine(): void {
  markdown.end();
}

/** Drops the block and the calls it held, once something else owns the bottom of the screen. */
function forgetToolLines(): void {
  toolLines.forget();
  pendingCalls.clear();
}

/**
 * Composes one tool line: a mark, the tool's blast-radius glyph, the tool, what it was called
 * with, and how it went. `lane` swaps the two-space indent for a connecting bar when this call is
 * part of a batch fired concurrently with others still in flight, so the batch reads as one group
 * of lanes rather than a coincidence of adjacent lines.
 */
function toolLineText(mark: string, name: string, detail: string, summary: string, effect: "none" | "workspace" | "external", lane: boolean): string {
  const indent = lane ? style.dim(glyphs.boxVertical) : " ";
  const effectGlyph = effect === "workspace" ? style.yellow(glyphs.effectWorkspace) : effect === "external" ? style.magenta(glyphs.effectExternal) : "";
  const head = `${indent} ${mark}${effectGlyph ? ` ${effectGlyph}` : ""} ${style.cyan(name)}`;
  const middle = detail ? `  ${detail}` : "";
  const tail = summary ? style.dim(` · ${summary}`) : "";
  return `${head}${middle}${tail}`;
}

/**
 * The user's own request, once it stops being typed and starts being a turn.
 *
 * Only called for text that actually becomes a turn — a slash command is a UI action, not a
 * message, the same distinction a real chat client draws by never bubbling `/mute` into the log as
 * if someone had said it aloud. Once the pinned footer owns the input row (see `screen` above), this
 * is the *only* place the user's own words reach the transcript at all: readline's echo now lands on
 * a row that gets cleared for the next prompt, not one that scrolls into history.
 *
 * Drawn as a bubble titled "you", matching the input bar it was typed into, so the transcript reads
 * as two speakers rather than as a log with an occasional bolded line in it.
 */
function renderUserTurn(text: string): string {
  return renderUserMessage(text, renderDepth, contentWidth(), glyphs, palette.borderStyle);
}

/**
 * How much of a long block is printed before the rest is folded behind `/expand`.
 *
 * A third of a short terminal, so a single tool result can never push the answer it belongs to off
 * the top of the screen — the failure that makes people scroll back instead of reading forward.
 */
const FOLD_AFTER_LINES = 14;

/**
 * Prints a block that may be too long, folding the tail and offering it by number.
 *
 * The whole text is kept, never discarded: the point of folding rather than truncating is that the
 * detail is one word away instead of gone.
 */
function writeFoldable(label: string, rendered: { text: string; hidden: number; full: string }): void {
  out.write(`${rendered.text}\n`);
  if (rendered.hidden > 0) {
    const id = expandables.add(label, rendered.full, rendered.hidden);
    out.write(`${GUTTER}${expandHint(id, rendered.hidden, renderDepth, glyphs)}\n`);
  }
}

/**
 * The code a `write_file` or `edit_file` call carried, shown under its tool line.
 *
 * Read from the *call's own arguments*: that is what was sent, it costs no round trip to a possibly
 * remote sandbox to fetch it back, and it is the only version guaranteed to be the one this line is
 * reporting on.
 */
function renderWrittenCode(toolName: string, args: Record<string, unknown>): void {
  const path = typeof args.path === "string" ? args.path : "";
  if (!path) return;
  const style_ = sectionStyle();
  if (toolName === "write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    if (content === "") return;
    writeFoldable(path, renderFileChange({ path, kind: "write", content }, style_, { maxLines: FOLD_AFTER_LINES }));
    return;
  }
  const before = typeof args.oldText === "string" ? args.oldText : "";
  const after = typeof args.newText === "string" ? args.newText : "";
  if (before === "" && after === "") return;
  writeFoldable(path, renderFileChange({ path, kind: "edit", before, after }, style_, { maxLines: FOLD_AFTER_LINES }));
}

/**
 * A command's output, as a test report when it is one and as folded output when it is not.
 *
 * The distinction is worth drawing because the two are read completely differently: nobody reads
 * test output top to bottom, they look for the failures — so a run that parses is re-laid-out into
 * sections, and anything else is shown as it came, folded, exactly as a terminal would.
 */
function renderCommandOutput(content: string): void {
  const style_ = sectionStyle();
  const report = parseTestOutput(content);
  if (report) {
    const rendered = renderTestReport(report, style_, { expandHint: "/expand for the raw output" });
    out.write(`${rendered}\n`);
    // The raw output is kept regardless of whether the report folded anything: a parser that read
    // the run slightly wrong is exactly when someone wants the original, and by then the process
    // that produced it is gone.
    const lines = content.split("\n").length;
    const id = expandables.add(`${report.framework} output`, content.replace(/\n$/, ""), lines);
    out.write(`${GUTTER}${expandHint(id, lines, renderDepth, glyphs)}\n`);
    return;
  }
  const body = content.replace(/\n$/, "").split("\n");
  // One or two lines of output already fit on the tool line's own summary; printing them again
  // below it would be the same words twice.
  if (body.length <= 2) return;
  const shown = body.slice(0, FOLD_AFTER_LINES);
  writeFoldable("command output", {
    text: panel(shown, style_, { title: "output", gutterOnly: true }),
    hidden: Math.max(0, body.length - FOLD_AFTER_LINES),
    full: panel(body, style_, { title: "output", gutterOnly: true }),
  });
}

/**
 * readline runtime state that `@types/node` leaves untyped. The current line, its input stream,
 * and the closed flag all exist on the interface at runtime (readline is written in plain JS).
 */
type ReadlineInternals = {
  input: NodeJS.ReadableStream;
  closed: boolean;
  line: string;
};

/**
 * What a submitted message looks like in the transcript: a chat bubble, sized to its content and
 * labelled with the speaker, matching the input bar that produced it.
 *
 * The echo is not redundant with what the user just typed. The input bar lives on a fixed footer
 * row that the next message overwrites, so without this the transcript would be a record of the
 * assistant talking to itself — every reply present, nothing it was replying to.
 */
export function renderUserMessage(
  text: string,
  depth: ReturnType<typeof detectColorDepth>,
  width: number,
  glyphSet: GlyphSet = UNICODE_GLYPHS,
  borderStyle: "round" | "single" | "double" | "none" = "round",
): string {
  // Wrapped per line rather than as one blob: a pasted stack trace or a numbered list is a shape
  // the sender chose, and reflowing it into a paragraph destroys the thing that made it readable.
  const body = text.split("\n").flatMap((line) => wrapPlain(line, Math.max(8, width - 6)));
  return box(body, { depth, width, title: "you", titleColor: "green", glyphs: glyphSet, borderStyle });
}

/**
 * How long a turn must last before it is worth animating.
 *
 * A cached or refused turn can be over in tens of milliseconds, and drawing a spinner frame for it
 * only to erase it reads as a flicker rather than as feedback. Below what a person registers as a
 * pause, so a real turn still starts animating immediately as far as anyone can tell.
 */
const SPINNER_START_DELAY_MS = 200;

export function renderEvent(event: NovaEvent): void {
  // Every event clears the spinner before printing. If the spinner is still running its next tick
  // redraws the bar underneath whatever just printed, so feedback continues through a whole run of
  // tool calls rather than only filling the first gap.
  statusBar.clear();

  if (event.type === "runtime" && event.event.type === "assistant_delta") {
    // The first delta of a turn is the one moment worth a header: it is where a reader's eye needs
    // to land to tell "the assistant is now speaking" apart from the tool lines and the user's own
    // request above it. Every delta after the first is the same reply continuing, not a new one.
    if (activity.awaitingFirstDelta) out.write(`\n${style.dim(glyphs.star)} ${style.bold("Nova")}\n`);
    // The model is visibly talking now, so animation yields the row to streamed Markdown.
    // This may be the first answer of the turn or the answer after a tool operation. Tool calls
    // restart the spinner even after earlier prose, so every new visible delta owns the screen and
    // must stop animation before writing.
    activity.awaitingFirstDelta = false;
    spinner?.stop();
    forgetToolLines();
    markdown.push(event.event.text);
    return;
  }

  // Anything else prints on its own row, so a half-written assistant line is closed off first.
  const wasStreaming = markdown.active;
  markdown.end();
  if (wasStreaming) forgetToolLines();

  if (event.type === "checkpoint") {
    forgetToolLines();
    out.write(style.dim(`  ${glyphs.elbow} checkpoint ${event.checkpoint.tree.slice(0, 8)}\n`));
    return;
  }
  if (event.type === "compaction") {
    forgetToolLines();
    out.write(style.dim(`  ${glyphs.elbow} compacted context (${event.messagesBefore} → ${event.messagesAfter} messages)\n`));
    return;
  }

  const runtime = event.event;
  if (runtime.type === "model_turn") {
    // Silent by design: every call this turn announces itself below, so a "thinking (3 tool
    // calls)" line would only restate what the next three lines are about to say.
    activity.tokens += runtime.usage.inputTokens + runtime.usage.outputTokens;
    return;
  }
  if (runtime.type === "tool_call") {
    const detail = describeToolCall(runtime.toolName, runtime.arguments);
    // A second call announced while the first is still open makes both part of one concurrent
    // batch — retroactively mark the still-open ones too, so the whole group reads as a lane
    // rather than the first line looking like an unrelated call that happened to be nearby.
    const lane = pendingCalls.size > 0;
    if (lane) {
      for (const [id, entry] of pendingCalls) {
        if (entry.lane || entry.line < 0) continue;
        const text = toolLineText(style.dim(glyphs.pending), entry.name, style.dim(entry.detail), "", entry.effect, true);
        if (toolLines.update(entry.line, text)) pendingCalls.set(id, { ...entry, lane: true });
      }
    }
    // Announcing then rewriting needs a cursor. Piped, the announcement would be a duplicate line
    // nobody can erase, so only the completed line below is printed.
    const line = liveTerminal ? toolLines.append(toolLineText(style.dim(glyphs.pending), runtime.toolName, style.dim(detail), "", runtime.effect, lane)) : -1;
    pendingCalls.set(runtime.toolCallId, { line, detail, name: runtime.toolName, arguments: runtime.arguments, effect: runtime.effect, lane });
    activity.phase = "operation";
    activity.operation = runtime.toolName;
    // A model can stream an explanation and then begin a long command. The first delta stopped
    // the thinking animation; restart it here so the operation never becomes silent dead air.
    spinner?.start();
    return;
  }
  if (runtime.type === "tool_result") {
    activity.toolCalls += 1;
    // Read from the structured result rather than from the rendered checklist: the counter must
    // not depend on how the list happens to be printed.
    const items = Array.isArray(runtime.data?.items) ? runtime.data.items as Array<{ status?: string }> : undefined;
    if (items) {
      activity.steps = items.length > 0
        ? { done: items.filter((item) => item.status === "done").length, total: items.length, label: "plan" }
        : undefined;
    }
    const mark = runtime.isError ? style.red(glyphs.cross) : style.green(glyphs.check);
    const summary = summarizeToolResult(runtime.toolName, runtime.content, runtime.isError);
    // The announcement and the outcome are the same line, rewritten where it already sits. Reads
    // parallel-safe calls correctly too: several are announced before the first result returns, so
    // the line to rewrite is usually not the last one printed.
    const pending = pendingCalls.get(runtime.toolCallId);
    const completed = toolLineText(mark, runtime.toolName, style.dim(pending?.detail ?? ""), summary, runtime.effect, pending?.lane ?? false);
    if (pending === undefined || pending.line < 0 || !toolLines.update(pending.line, completed)) {
      out.write(`${completed}\n`);
    }
    pendingCalls.delete(runtime.toolCallId);

    // Output too large for the transcript did not vanish — say where it went, in the same place the
    // truncated tail used to be, so "the rest of it" is a path rather than a loss.
    if (runtime.artifact) {
      const artifact = runtime.artifact;
      out.write(style.dim(`  ${glyphs.elbow} ${artifact.lines.toLocaleString()} lines kept in ${artifact.path}\n`));
    }

    // The detail belongs *under* the line that announced it. Anything printed here ends the
    // rewritable block — the tool lines above are no longer the bottom of the screen, and touching
    // them afterward would erase whatever went in between.
    // Only the block is forgotten, never the pending map: a call still in flight keeps the
    // arguments its own result will need, and simply prints its completed line fresh instead of
    // rewriting one that is no longer at the bottom of the screen.
    if (!runtime.isError && pending) {
      if (runtime.toolName === "write_file" || runtime.toolName === "edit_file") {
        toolLines.forget();
        renderWrittenCode(runtime.toolName, pending.arguments);
        // Feeds the end-of-turn "files modified" footer.
        const path = typeof pending.arguments.path === "string" ? pending.arguments.path : undefined;
        if (path) touchedFiles.add(path);
      } else if (runtime.toolName === "run_command") {
        toolLines.forget();
        renderCommandOutput(runtime.content);
      }
    }

    const stillRunning = pendingCalls.values().next().value as { name: string } | undefined;
    if (stillRunning) {
      activity.phase = "operation";
      activity.operation = stillRunning.name;
    } else {
      // The next provider iteration begins immediately after the final result. There is no
      // separate "model request started" event, so this transition keeps that reasoning visible.
      activity.phase = "thinking";
      activity.operation = undefined;
    }
    return;
  }
}

/**
 * The setup view: what works, what is missing, and the exact variable that fixes it.
 */
export function renderProviders(environment: Record<string, string | undefined>, depth: ReturnType<typeof detectColorDepth>): string {
  // The banner honours NO_COLOR; this view has to as well, or `nova --providers > setup.txt`
  // writes escape codes into the file someone is about to read.
  const paint = (text: string, apply: (value: string) => string) => (depth === "none" ? text : apply(text));
  const statuses = describeProviders(environment);
  const rows: string[][] = [];

  for (const status of statuses) {
    const mark = status.configured ? paint(glyphs.check, style.green) : paint(glyphs.circleEmpty, style.dim);
    const detail = status.configured
      ? paint(`${status.model} · pricing: ${status.pricing}`, style.dim)
      // `nova settings` leads: it stores the key for next time, where an exported variable lives
      // only as long as the shell does. The variable name still appears, for CI and containers.
      : paint(`nova settings, or set ${status.missing.join(" and ")}`, style.yellow);
    rows.push([mark, status.label, detail]);
  }
  const exaConfigured = Boolean(environment.EXA_API_KEY?.trim());
  rows.push([
    exaConfigured ? paint(glyphs.check, style.green) : paint(glyphs.circleEmpty, style.dim),
    "Exa search",
    exaConfigured ? paint("web_search enabled", style.dim) : paint("nova settings, or set EXA_API_KEY", style.yellow),
  ]);
  const lines: string[] = [table(["", "provider", "status"], rows, { depth, glyphs })];

  const unpriced = statuses.filter((status) => status.configured && status.pricing === "unknown");
  if (unpriced.length > 0) {
    lines.push("");
    lines.push(paint(`  No published price for ${unpriced.map((status) => status.model).join(", ")} — costs show as unknown.`, style.dim));
    lines.push(paint(`  Set ${PRICE_ENVIRONMENT_HINT} to price it.`, style.dim));
  }
  if (!environment.NOVA_FX_RWF_PER_USD) {
    lines.push(paint("  Set NOVA_FX_RWF_PER_USD to show USD-priced models in RWF.", style.dim));
  }
  return lines.join("\n");
}

/**
 * Exchange rates, from configuration only.
 *
 * Deliberately not fetched: a CLI that silently calls a rates API turns every cost display into a
 * network dependency, and a stale-but-known rate is more auditable than a fresh-but-invisible one.
 * `NOVA_FX_RWF_PER_USD=1320` is the whole interface, and the rate's date is recorded beside it so
 * a historical figure can be reconciled later.
 */
/**
 * Builds the `choose` half of `SettingsPrompts` from a readline.
 *
 * Defined once and used by all three ways into settings — first run, `nova settings`, `/settings` —
 * because a menu that navigates differently depending on how you opened it is the specific thing
 * this is meant to stop.
 */
function settingsChooser(readline: Interface): NonNullable<SettingsPrompts["choose"]> {
  return (request) => openChooser(
    { readline, input: process.stdin, output: process.stdout },
    request.items.map((item) => ({ ...item })),
    {
      title: request.title,
      ...(request.filter ? { filter: true } : {}),
      ...(request.initialIndex === undefined ? {} : { initialIndex: request.initialIndex }),
      height: 12,
      // The real terminal, so rows are clipped rather than wrapped onto lines the repaint does
      // not know it drew.
      width: process.stdout.columns ?? 80,
      glyphs,
      paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
    },
  );
}

export function readFxRates(environment: Record<string, string | undefined>): FxRate[] {
  const genericRate = Number(environment.NOVA_FX_RATE);
  const genericFrom = environment.NOVA_FX_FROM?.trim().toUpperCase();
  const genericTo = environment.NOVA_FX_TO?.trim().toUpperCase();
  const configured: FxRate[] = [];
  if (Number.isFinite(genericRate) && genericRate > 0 && genericFrom && genericTo && isCurrency(genericFrom) && isCurrency(genericTo) && genericFrom !== genericTo) {
    configured.push({
      from: genericFrom,
      to: genericTo,
      rate: genericRate,
      asOf: environment.NOVA_FX_ASOF?.trim() || new Date().toISOString().slice(0, 10),
      source: environment.NOVA_FX_SOURCE?.trim() || "NOVA_FX_RATE",
    });
  }
  const rate = Number(environment.NOVA_FX_RWF_PER_USD);
  if (Number.isFinite(rate) && rate > 0 && !configured.some((candidate) => candidate.from === "USD" && candidate.to === "RWF")) {
    configured.push({
      from: "USD",
      to: "RWF",
      rate,
      asOf: environment.NOVA_FX_ASOF?.trim() || new Date().toISOString().slice(0, 10),
      source: environment.NOVA_FX_SOURCE?.trim() || "NOVA_FX_RWF_PER_USD",
    });
  }
  return configured;
}

/**
 * The approval gate, as a person experiences it.
 *
 * `signal` reaches in for the *current turn's* abort signal at ask-time, not construction-time:
 * one prompt function is built per agent and lives across many turns, while an `AbortSignal` is
 * single-use. Ctrl+C during a normal tool loop cancels via `agent.cancel()`, a flag the runtime
 * only checks between steps — but a pending `readline.question()` here is not a step the runtime
 * is looping over, so that flag alone leaves it blocked forever on an answer nobody can give
 * anymore. Aborting the question is what actually returns control to the prompt.
 */
/** What a pending `write_file`/`edit_file` approval would actually change — no file read needed: `write_file` carries its whole new content, `edit_file` carries the exact before/after snippet. */
function renderApprovalPreview(preview: DaemonApprovalRequest["preview"]): string | undefined {
  if (!preview) return undefined;
  const rendered = preview.toolName === "write_file"
    ? renderFileChange({ path: preview.path, kind: "write", content: preview.content }, sectionStyle(), { maxLines: FOLD_AFTER_LINES })
    : renderFileChange({ path: preview.path, kind: "edit", before: preview.oldText, after: preview.newText }, sectionStyle(), { maxLines: FOLD_AFTER_LINES });
  return rendered.text;
}

export function createApprovalPrompt(readline: Interface, interactive: boolean, signal: () => AbortSignal | undefined) {
  return async ({ summary, safety, preview }: { summary: string; safety?: SafetyAssessment; preview?: DaemonApprovalRequest["preview"] }): Promise<PermissionDecision> => {
    // Without a terminal there is nobody to ask, and a prompt written to a pipe would either hang
    // or read the next line of piped input as an answer. Denying is the only honest result — and
    // it is reported, so the run does not look like the model simply chose not to act.
    if (!interactive) {
      out.write(`\n  ${style.yellow("!")} Nova needs approval to ${style.bold(summary)}, but stdin is not a terminal.\n`);
      out.write(`    ${style.dim("Re-run with --auto to pre-approve workspace edits.")}\n`);
      return "deny_always";
    }
    // A tool call can arrive before the model emits visible text. In that case the TUI spinner is
    // still redrawing the last row and can overwrite the first approval question unless it is
    // explicitly stopped here.
    activity.awaitingFirstDelta = false;
    spinner?.stop();
    statusBar.clear();
    endStreamedLine();
    out.write(`\n  ${style.yellow("?")} Nova wants to ${style.bold(summary)}\n`);
    // What you approve is what gets executed — see the exact change before answering, not just
    // the one-line summary. Reuses the same renderer the post-write receipt already shows, built
    // straight from the call's own arguments, so nothing here can differ from what actually runs.
    const previewText = renderApprovalPreview(preview);
    if (previewText) out.write(`${previewText}\n`);
    if (safety?.sensitive) out.write(`    ${style.yellow("Safety guard:")} ${safety.reasons.join(", ")}\n`);
    let answer: string;
    try {
      answer = (await readline.question(`    ${style.dim("[y]es / [n]o / [a]lways / [d]eny always: ")}`, { signal: signal() })).trim().toLowerCase();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        out.write(style.yellow("\n  interrupted — treating as denied\n"));
        return "deny";
      }
      throw error;
    }
    if (answer === "a" || answer === "always") return "allow_always";
    if (answer === "d") return "deny_always";
    if (answer === "n" || answer === "no") return "deny";
    return answer === "" || answer === "y" || answer === "yes" ? "allow" : "deny";
  };
}

/** Sensitive objectives are acknowledged before estimation, model contact, or sandbox effects. */
export async function confirmSensitiveTask(
  readline: Interface,
  interactive: boolean,
  assessment: SafetyAssessment,
  explicitlyAllowed = false,
): Promise<boolean> {
  if (!assessment.sensitive) return true;
  const detail = assessment.reasons.join(", ");
  if (explicitlyAllowed) {
    out.write(`  ${style.yellow("Safety guard:")} ${detail} — task preflight approved by --allow-sensitive.\n`);
    return true;
  }
  if (!interactive) {
    out.write(`  ${style.yellow("Safety guard blocked this task:")} ${detail}.\n`);
    out.write(`    ${style.dim("Review it, then re-run with --allow-sensitive. Sensitive tool operations remain separately gated.")}\n`);
    return false;
  }
  statusBar.clear();
  const answer = (await readline.question(`  ${style.yellow("Safety review:")} ${style.bold(detail)}. Continue? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/** Confirms the one bounded amount the session may spend before any sandbox or model is started. */
export async function confirmSpendingCap(readline: Interface, interactive: boolean, renderedCap: string): Promise<boolean> {
  // A non-interactive caller supplied --budget in the command itself; that explicit argument is
  // the approval. Prompting a pipe would hang or consume the task text as an answer.
  if (!interactive) return true;
  statusBar.clear();
  const answer = (await readline.question(`  ${style.yellow("?")} Approve a session spend cap of ${style.bold(renderedCap)}? ${style.dim("[Y/n]: ")}`)).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

/** Ctrl+D/EOF is a normal way to leave a terminal program, never an application failure. */
export function isReadlineExit(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || /aborted with ctrl\+d|readline was closed/i.test(error.message));
}

/** Reads a secret through readline without echoing pasted credentials to the terminal or history. */
async function hiddenQuestion(readline: Interface, question: string): Promise<string> {
  process.stdout.write(`${question}${style.dim("[input hidden] ")}`);
  const stdout = process.stdout as typeof process.stdout & { write: typeof process.stdout.write };
  const original = stdout.write;
  try {
    stdout.write = (() => true) as typeof process.stdout.write;
    const answer = await readline.question("");
    // readline records answers automatically. A hidden value must not become visible again when
    // the user presses Up, nor reach the persistent prompt history file.
    const history = (readline as Interface & { history?: string[] }).history;
    if (history) {
      for (let index = history.length - 1; index >= 0; index -= 1) if (history[index] === answer) history.splice(index, 1);
    }
    return answer;
  } finally {
    stdout.write = original;
    original.call(process.stdout, "\n");
  }
}

/**
 * `ModelPriceCatalog` for the runtime's own runaway guard, from the ledger's `TokenPrices`.
 *
 * The two exist for different readers. `TokenPrices` is what the ledger and the display report
 * are built on — currency-aware, dated, converted for a human. `ModelPriceCatalog` is a bare
 * integer rate `NovaAgent` compares a running total against before every provider call, and it has
 * always used a coarser unit than the ledger by design: an approved cap switches to full
 * currency-micros precision so the runtime can clamp accurately against a real promise made to the
 * user, while the common case (no explicit cap) uses whole-currency-units-per-million as a loose
 * backstop, because a guard rail nobody configured should be generous rather than surprising.
 */
/**
 * What a model field in the settings menu should offer, asked of the provider itself.
 *
 * A model id is the one setting whose valid answers Nova cannot know: they belong to the provider,
 * they change with no release of Nova, and the key needed to ask for them has — by the time this
 * field is opened — just been typed into the field above. So this asks, using the settings as they
 * stand in the menu rather than as they were saved, which is what makes "paste a key, then pick a
 * model" work in one visit instead of two.
 *
 * The catalog stays underneath: it is what knows prices, and it is the whole list when there is no
 * key yet or the provider cannot be reached. The fetch only ever widens it, and never blocks on
 * more than one provider — the one whose field is open.
 */
async function modelChoicesForSettingsField(
  field: SettingKey,
  settings: NovaSettings,
  processEnvironment: Record<string, string | undefined>,
  display: Currency,
  rates: readonly FxRate[],
): Promise<readonly SettingChoice[]> {
  const provider = MODEL_FIELD_PROVIDER[field];
  if (!provider) return [];
  // The in-progress menu values win over the process environment, so a key pasted a moment ago is
  // the key this asks with.
  const environment = mergedEnvironment(settings, processEnvironment);
  const known = modelsForProvider(provider);
  const fetched = await fetchProviderModels(provider, environment, globalThis.fetch as never).catch(() => null);
  const models = mergeModelLists(known, fetched?.models);

  return models.map((model) => {
    const prices = catalogPrices(provider, model);
    return {
      value: model,
      label: model,
      // Named rather than left blank: a model this build has no rate for is perfectly usable, and
      // saying so is different from saying nothing — the cost report will say the same thing later.
      description: prices
        ? describePrice(prices, display, (amount) => convertTo(amount, display, rates))
        : "no published rate — costs will show as unknown",
    };
  });
}

function modelPriceCatalogFor(prices: { inputPerMillion: number; outputPerMillion: number } | undefined, exact: boolean) {
  if (!prices) return { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 };
  return exact
    ? { inputRwfPerMillionTokens: prices.inputPerMillion, outputRwfPerMillionTokens: prices.outputPerMillion }
    : { inputRwfPerMillionTokens: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)), outputRwfPerMillionTokens: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)) };
}

/**
 * Launches a job's worker as its own detached process.
 *
 * Detached and unreferenced, so it outlives this terminal closing — the entire point of a durable
 * job is that it does not depend on the process that queued it. Its own stdio is redirected to the
 * job's log file rather than inherited, since there is nobody left to read a shared stdout once
 * this process exits, and inheriting it would tie the child's lifetime to a pipe that goes away
 * with the parent.
 */
async function spawnJobWorker(root: string, jobId: string): Promise<number | undefined> {
  const { spawn } = await import("node:child_process");
  const { openSync, mkdirSync } = await import("node:fs");
  const logFile = jobLogPath(root, jobId);
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [process.argv[1], "--nova-job-worker", root, jobId], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: root,
    });
    child.unref();
    return child.pid;
  } finally {
    const { closeSync } = await import("node:fs");
    closeSync(fd);
  }
}

/**
 * The process a spawned job runs as.
 *
 * Everything above `main()` in this file assumes a person is at a terminal: a readline loop, a
 * status bar, approval prompts. None of that exists here — this branch runs the same `NovaAgent`
 * loop headlessly and reports through the job store instead of the screen, which is the entire
 * difference between a foreground turn and a background one.
 */
async function runJobWorkerProcess(root: string, jobId: string): Promise<number> {
  const savedSettings = await loadSettings(process.env as Record<string, string | undefined>);
  const environment = mergedEnvironment(savedSettings, process.env as Record<string, string | undefined>);
  const resolved = resolveProvider(environment, {});
  if ("error" in resolved) {
    await appendJobLog(root, jobId, `✗ ${resolved.error}`).catch(() => undefined);
    await finishJob(root, jobId, workerId(), "failed", { error: resolved.error }).catch(() => undefined);
    return 1;
  }

  let cancel: (() => void) | undefined;
  // /jobs cancel sends SIGTERM to this pid; a live turn needs the same clean interrupt Ctrl+C gives
  // an interactive one, not the process simply vanishing mid-write.
  const onSignal = () => cancel?.();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const outcome = await runJobWorkerForever({
      root,
      jobId,
      provider: resolved.provider,
      prices: modelPriceCatalogFor(resolved.prices, false),
      search: createExaClient(environment),
      onAgentReady: (agent) => { cancel = () => agent.cancel(); },
    });
    return outcome.outcome === "failed" ? 1 : 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}

async function main(): Promise<number> {
  // A closed pipe (`nova --help | head`, `nova --providers | less -F`) is not an error. Without
  // this, the write throws EPIPE and the CLI dies with a stack trace the user never asked for.
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });

  // Not a normal invocation — this is the detached process a job spawns for itself. Dispatched
  // ahead of `parseArgs` because its argument shape (a root and a job id, no flags) is nothing
  // like an interactive session's.
  if (process.argv[2] === "--nova-job-worker") {
    const [, , , root, jobId] = process.argv;
    if (!root || !jobId) {
      process.stderr.write("Internal: --nova-job-worker requires <root> <jobId>\n");
      return 1;
    }
    return runJobWorkerProcess(root, jobId);
  }

  const args = parseArgs(process.argv.slice(2));
  const processEnvironment = process.env as Record<string, string | undefined>;
  let savedSettings = await loadSettings(processEnvironment);
  const environment = mergedEnvironment(savedSettings, processEnvironment);
  const stateHistory = new CliStateHistory(args.root, environment);
  let language = resolveControlLanguage(args.language ?? environment.NOVA_LANGUAGE ?? environment.LANG);
  // Before anything prints. `--help`, `--providers` and `--sessions` all return long before the
  // interactive path configures rendering, and every one of them draws marks and rules — a terminal
  // that cannot render them should get the ASCII forms from the very first line, not from the point
  // a session happens to start.
  const earlyDepth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
  // Built-ins only at this point: the on-disk themes live under the project root, and `--help` and
  // friends must not pay for a directory scan they will never use the result of.
  configureRendering(
    earlyDepth,
    Boolean(process.stdout.isTTY),
    args.ascii ? resolveGlyphs({ ...environment, NOVA_GLYPHS: "ascii" }) : resolveGlyphs(environment),
    buildPalette(
      findBuiltinTheme(args.theme ?? detectPreferredTheme(environment)) ?? findBuiltinTheme(DEFAULT_THEME_NAME)!,
      earlyDepth,
    ),
  );
  if (args.help) {
    // Cheap and side-effect-free — resolving the static binding table against overrides — so
    // building one here beats threading the interactive session's own registry all the way down to
    // a path that runs before that registry, or a session at all, exists.
    const shortcuts = new KeyBindingRegistry(parseBindingOverrides(environment.NOVA_KEYS), environment).shortcutLabels();
    out.write(helpText(language, shortcuts));
    return 0;
  }

  if (args.version) {
    out.write(`nova ${NOVA_CLI_VERSION}\n`);
    return 0;
  }

  if (args.gallery) {
    // Drawn at the real terminal's width and glyph set, because the point is to see what this
    // terminal does with it — the ASCII and no-colour forms are reached with --ascii and NO_COLOR,
    // which are the same switches a real session honours.
    out.write(`${renderGallery({
      width: Math.max(24, (process.stdout.columns ?? 80) - 1),
      depth: earlyDepth,
      glyphs: args.ascii ? resolveGlyphs({ ...environment, NOVA_GLYPHS: "ascii" }) : resolveGlyphs(environment),
    })}\n`);
    return 0;
  }

  // Before anything that could print: from here on stdout is a protocol channel, and one stray
  // human-readable byte on it is a parse error the client cannot recover from.
  if (args.acp) {
    return runAcpServer({
      input: process.stdin,
      write: (line) => process.stdout.write(line),
      environment: processEnvironment,
      defaultRoot: args.root,
      mode: args.mode,
    });
  }

  if (args.update) {
    const result = await runSelfUpdate({
      checkOnly: args.checkUpdate,
      yes: args.updateYes,
      packageManager: args.packageManager,
      environment: process.env as Record<string, string | undefined>,
    });
    return result.code;
  }

  if (args.settings) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write("Nova settings needs an interactive terminal. Environment variables remain supported for automation.\n");
      return 1;
    }
    const settingsReadline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      savedSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => settingsReadline.question(question),
        askSecret: (question) => hiddenQuestion(settingsReadline, question),
        write: (text) => process.stdout.write(text),
        choose: settingsChooser(settingsReadline),
      }, {
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, "USD", []),
      });
    } catch (error) {
      settingsReadline.close();
      if (isReadlineExit(error)) {
        out.write(style.dim("\nSettings cancelled — no changes were saved.\n"));
        return 0;
      }
      throw error;
    }
    const file = await saveSettings(savedSettings, processEnvironment);
    settingsReadline.close();
    out.write(`Settings saved to ${file}. Environment variables override saved values.\n`);
    return 0;
  }

  if (args.listProviders) {
    out.write(`${renderProviders(environment, detectColorDepth(environment, Boolean(process.stdout.isTTY)))}\n`);
    return 0;
  }

  if (args.doctor) {
    const environment = process.env as Record<string, string | undefined>;
    const depth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
    const probes = await runDoctor(environment);
    process.stdout.write(`${renderDoctor(probes, depth)}\n`);
    return doctorExitCode(probes);
  }

  if (args.listSessions) {
    const indexed = await stateHistory.sessions(20);
    const sessions = indexed
      ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
      : await listSessions(args.root);
    if (sessions.length === 0) out.write("No sessions in this project yet.\n");
    for (const session of sessions) {
      out.write(`${style.cyan(session.id)}  ${new Date(session.updatedAt).toLocaleString()}  ${session.title}\n`);
    }
    await stateHistory.close();
    return 0;
  }

  if (args.historyCommand) {
    const command = args.historyCommand;
    const style_ = sectionStyle();
    if (command.kind === "invalid") {
      process.stderr.write(`${command.reason}\n`);
      return EXIT_CODES.usage;
    }
    if (command.kind === "status") {
      await stateHistory.refresh();
      const status = await stateHistory.status();
      if (status.mode === "native") {
        out.write(`native SQLite + FTS5: ${status.indexed ? "current" : "ready"}\n`);
        if (status.report) out.write(`${status.report.sessions} sessions, ${status.report.documents} searchable documents, ${status.report.failures.length} source failures\n`);
      } else {
        out.write(`portable JSON history: active\n${status.reason ?? "native state engine unavailable"}\n`);
      }
      await stateHistory.close();
      return 0;
    }
    if (command.kind === "show") {
      const record = await loadSession(args.root, command.id);
      if (!record) {
        process.stderr.write(`No session ${command.id}. Run nova history to list them.\n`);
        return EXIT_CODES.usage;
      }
      out.write(`${renderReplay(record, style_, command.turns === undefined ? {} : { turns: command.turns })}\n`);
      return 0;
    }
    if (command.kind === "resume") {
      process.stderr.write(`Use nova --resume${command.id ? ` ${command.id}` : ""} to continue a session.\n`);
      return EXIT_CODES.usage;
    }

    const historyEntries = async (): Promise<HistoryEntry[]> => {
      const indexed = await stateHistory.sessions(30);
      const listed = indexed
        ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
        : await listSessions(args.root, 30);
      return (await Promise.all(listed.map(async (summary) => {
        const record = await loadSession(args.root, summary.id);
        return record ? summarizeSession(record) : null;
      }))).filter((entry): entry is HistoryEntry => entry !== null);
    };

    if (command.kind === "search") {
      const nativeHits = await stateHistory.search(command.query, 20);
      const found = nativeHits
        ? (await Promise.all(nativeHits.map(async (hit): Promise<HistoryEntry | null> => {
            const record = await loadSession(args.root, hit.sessionId);
            return record ? { ...summarizeSession(record), evidence: { source: hit.source, snippet: hit.snippet, why: hit.why } } : null;
          }))).filter((entry): entry is HistoryEntry => entry !== null)
        : searchHistory(await historyEntries(), command.query);
      out.write(`${heading(`"${command.query}" ${glyphs.middot} ${found.length} match${found.length === 1 ? "" : "es"}`, 2, style_)}\n`);
      out.write(`${renderHistoryList(found, style_)}\n`);
    } else {
      {
        const entries = await historyEntries();
        out.write(`${renderHistoryList(entries, style_)}\n`);
        const usage = renderHistoryUsage(entries, style_);
        if (usage) out.write(`${usage}\n`);
      }
    }
    await stateHistory.close();
    return 0;
  }

  /**
   * Headless mode claims stdout for JSONL, and gives the human stream to stderr.
   *
   * Done by redirecting the process stream rather than by routing each of the hundred existing
   * `process.stdout.write` calls, because the guarantee has to hold for output this file does not
   * own: a warning from a dependency, a line added later by someone who has not read this comment.
   * One choke point makes "stdout is only ever JSONL" structural instead of a convention.
   */
  let writeRecord: ((line: string) => void) | null = null;
  if (args.json) {
    if (!args.prompt) {
      process.stderr.write("--json runs a single turn: pass the request, for example nova --json \"fix the failing tests\".\n");
      return EXIT_CODES.usage;
    }
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    writeRecord = (line) => { realStdoutWrite(line); };
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) =>
      (process.stderr.write as (...args: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
    // Escape codes aimed at a terminal are noise in a log file, and the spinner would redraw over
    // the diagnostics it shares the stream with.
    environment.NO_COLOR = "1";
  }

  let resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
  // Nothing configured yet is the ordinary first run, not an error. Exporting a key into the shell
  // leaves it in shell history and dies with the shell; Nova already stores keys itself, so the
  // first run offers that instead of printing a variable name and quitting. Automation still gets
  // the message-and-exit path, because a prompt no one can answer is a hang.
  // Never in headless mode: an interactive menu has nobody to answer it when a program is driving.
  if ("error" in resolved && !args.json && !args.provider && !args.model && process.stdin.isTTY && process.stdout.isTTY) {
    out.write(`${style.yellow("Nova is not configured yet.")} Add a provider key below — it is saved for next time, so you never need to export it.\n`);
    const setupReadline = createInterface({ input: process.stdin, output: process.stdout });
    try {
      savedSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => setupReadline.question(question),
        askSecret: (question) => hiddenQuestion(setupReadline, question),
        write: (text) => process.stdout.write(text),
        choose: settingsChooser(setupReadline),
      }, {
        focus: "providers",
        // The whole point of first run: the key was pasted one field ago, so the model field can
        // be a list of what that key actually reaches rather than an id to be recalled and typed.
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, "USD", []),
      });
      const file = await saveSettings(savedSettings, processEnvironment);
      out.write(style.dim(`Settings saved to ${file}.\n`));
    } catch (error) {
      if (!isReadlineExit(error)) throw error;
      out.write(style.dim("\nSetup cancelled.\n"));
    } finally {
      setupReadline.close();
    }
    // The freshly saved values have to reach the same merged view every later read uses, or the
    // key the user just typed would be invisible for the rest of this process.
    for (const field of SETTING_FIELDS) delete environment[field.key];
    Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
    language = resolveControlLanguage(args.language ?? environment.NOVA_LANGUAGE ?? environment.LANG);
    resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
  }
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Nova is not configured.")} ${resolved.error}\n`);
    process.stderr.write(`Run ${style.cyan("nova settings")} to save a key without exporting one.\n`);
    return args.json ? EXIT_CODES.usage : 1;
  }
  let { provider: model, spec, prices } = resolved;
  let resolvedModelId = resolved.model;

  // Display currency: explicit flags/configuration, then a coarse locale country, then the
  // provider's own currency. Accounting remains in the provider currency with the dated rate
  // attached to every converted report.
  const preference = resolveCurrencyPreference({ currency: args.currency, country: args.country, environment, providerCurrency: prices?.currency ?? "USD" });
  let display = preference.currency;
  const rates = readFxRates(environment);
  let localCurrencyWarning: string | null = null;
  if (prices && display !== prices.currency) {
    const configured = rates.some((rate) => (rate.from === prices!.currency && rate.to === display) || (rate.to === prices!.currency && rate.from === display));
    const fxFailures: FxLookupFailure[] = [];
    if (!configured && environment.NOVA_FX_OFFLINE !== "true") {
      const daily = await fetchDailyFxRate(prices.currency, display, undefined, (failure) => fxFailures.push(failure));
      if (daily) rates.push(daily);
    }
    const convertible = rates.some((rate) => (rate.from === prices!.currency && rate.to === display) || (rate.to === prices!.currency && rate.from === display));
    if (!convertible) {
      const tried = fxFailures.map((failure) => `${failure.host}: ${failure.diagnosis.message}`).join(" ");
      if (args.budget) {
        process.stderr.write(`${style.red("Cannot enforce the approved budget.")} No ${prices.currency}→${display} exchange rate is available${tried ? ` — the automatic lookup failed (${tried})` : ""}.\n`);
        process.stderr.write(`  ${style.dim(`Continue offline with a manual rate: set NOVA_FX_RWF_PER_USD=1320 (or NOVA_FX_FROM/NOVA_FX_TO/NOVA_FX_RATE), or keep costs in the provider currency with --currency ${prices.currency}. Run nova --doctor to see exactly which endpoint is failing.`)}\n`);
        return 1;
      }
      localCurrencyWarning = `No current ${prices.currency}→${display} rate was available${tried ? ` (${tried})` : ""}; costs remain in ${prices.currency}.`;
      display = prices.currency;
    }
  }
  if (args.budget && !prices) {
    process.stderr.write(`${style.red("Cannot enforce the approved budget.")} This model has no configured price. Configure its rate or omit --budget.\n`);
    return 1;
  }

  const readline = createInterface({
    input: process.stdin,
    output: process.stdout,
    // Reads the cached project listing below, so completion never blocks on a filesystem walk.
    // Built per keystroke rather than cached: the catalog depends on `environment`, which a
    // `/settings` edit mutates mid-session, and a stale list would keep offering a provider whose
    // key was just removed. It is a walk over a literal table, not IO.
    completer: (line: string) => completeInput(line, projectFiles, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model)),
    history: (await loadHistory(environment)).reverse(),
    historySize: 200,
    removeHistoryDuplicates: true,
  });
  // Runtime-only readline state — see `ReadlineInternals`: the typed surface leaves these out.
  const rl = readline as unknown as Interface & ReadlineInternals;
  // Warmed once the workspace exists and refreshed after each turn, since a turn can create files.
  let projectFiles: string[] = [];
  const refreshProjectFiles = () => {
    // Only the REPL completes anything, so a one-shot run should not pay for a project walk.
    if (!interactive) return;
    void workspace.glob("**/*").then((files) => { projectFiles = files; }).catch(() => undefined);
  };
  const interactive = Boolean(process.stdin.isTTY);

  // Feature keys are a convenience over the command table, so they are built from it and every one
  // of them submits the command it stands for. Conflicts are reported now rather than discovered
  // later as a key that quietly does nothing.
  const keys = new KeyBindingRegistry(parseBindingOverrides(environment.NOVA_KEYS), environment);
  // Set when Alt+B fires mid-turn. `turnActive`/`agent` are declared further down this function,
  // but nothing can invoke this closure before then — a keypress only ever arrives once the loop
  // below is already running.
  let detachRequested = false;
  // Held as options rather than installed inline, because the workspace screen has to give the
  // keyboard back to a *fresh* installation when it closes: it takes stdin for itself while it is
  // open, and a listener installed before that is one the framework has since torn down.
  const shortcutOptions = {
    readline, input: process.stdin, output: process.stdout, registry: keys,
    canSuggest: () => !turnActive,
    onIntercept: (command: string) => {
      if (command !== "/detach" || !turnActive) return false;
      detachRequested = true;
      agent.cancel();
      return true;
    },
  };
  let uninstallShortcuts = interactive ? installShortcuts(shortcutOptions) : () => {};
  const installShortcutsAgain = (): void => {
    if (interactive) uninstallShortcuts = installShortcuts(shortcutOptions);
  };
  // The status bar and spinner draw over the current line and redraw in place — meaningless
  // (and corrupting) output when either end of the pipe is not a real terminal.
  const ttyMode = interactive && !args.json && Boolean(process.stdout.isTTY);
  const depth = detectColorDepth(environment, !args.json && Boolean(process.stdout.isTTY));
  const sessionGlyphs = args.ascii ? resolveGlyphs({ ...environment, NOVA_GLYPHS: "ascii" }) : resolveGlyphs(environment);
  /**
   * The theme this session paints with, now including any the project or the user wrote.
   *
   * A name that matches nothing is reported rather than substituted silently: a theme that does not
   * exist is nearly always a typo, and quietly rendering in something else makes the typo invisible.
   */
  let themeName = args.theme ?? detectPreferredTheme(environment);
  let activeTheme = await findTheme(themeName, args.root, environment);
  if (!activeTheme && args.theme) {
    out.write(style.yellow(`  No theme named "${args.theme}" — using ${DEFAULT_THEME_NAME}. /theme list shows what there is.\n`));
  }
  if (!activeTheme) {
    activeTheme = await findTheme(DEFAULT_THEME_NAME, args.root, environment);
    themeName = DEFAULT_THEME_NAME;
  }
  const applyTheme = (theme: { name: string; tokens: Parameters<typeof buildPalette>[0]["tokens"] }): void => {
    themeName = theme.name;
    configureRendering(depth, !args.json && Boolean(process.stdout.isTTY), sessionGlyphs, buildPalette(theme as Parameters<typeof buildPalette>[0], depth));
  };
  configureRendering(depth, !args.json && Boolean(process.stdout.isTTY), sessionGlyphs,
    activeTheme ? buildPalette(activeTheme, depth) : NO_COLOR_PALETTE);
  let mode = args.mode;
  /** The spending pace, changeable mid-session with `/slow`. */
  let pace: PaceLevel = args.pace;
  /**
   * What Nova has been asked to remember, read once at startup and re-read whenever `/memory`
   * changes it. Held in memory because it is consulted on every turn and edited rarely.
   */
  let memories: MemoryEntry[] = await loadMemories(args.root, environment);

  /**
   * Every return point tears down the same three things, in the same order — reassigned once
   * `unbindSigint` exists (below) rather than duplicated, so an exit path added later can't forget
   * one. A scroll region left set when the process exits is inherited by the user's own shell
   * afterward, which reads as the terminal being broken until they notice and reset it themselves.
   */
  let exitCleanly = () => { screen?.exit(); uninstallShortcuts(); readline.close(); };

  const approvedBudget = args.budget ? fromUnits(args.budget, display) : undefined;
  if (approvedBudget && !await confirmSpendingCap(readline, interactive, formatMoney(approvedBudget))) {
    out.write(style.yellow("  Spending not approved — no sandbox or model was started.\n"));
    exitCleanly();
    return 0;
  }

  /**
   * Somewhere for a tab's work to happen.
   *
   * Was a single workspace built once for the whole session; it is now a factory, because a tab is
   * allowed to run somewhere else. "Run this one in a throwaway sandbox and that one against my
   * checkout" is the thing a control panel is for, and it is only a factory call away once the
   * construction stops being a straight line through `main`.
   *
   * Each remote workspace is a *separate* sandbox with its own lifetime, so closing a tab stops
   * paying for exactly that one. Errors are returned rather than thrown: a tab that cannot start a
   * sandbox must report why and leave the session alone, where the startup path used to be entitled
   * to exit the process.
   */
  type WorkspaceRequest = { backend: SandboxBackend; upload?: boolean; dockerImage?: string; preset?: string; announce?: boolean };
  const createWorkspace = async (request: WorkspaceRequest): Promise<{ workspace: NovaWorkspace } | { error: string }> => {
    const announce = (text: string) => { if (request.announce !== false) out.write(style.dim(`${text}\n`)); };
    const minutes = Math.max(1, Math.min(args.sandboxMinutes, 60));

    if (request.backend === "e2b") {
      // Imported here, not at the top: a local-only session should never load the E2B SDK, which is
      // what lets the published package treat it as an optional dependency.
      const { findWorkspacePreset } = await import("@circuit-nova/nova-core/sandbox-templates");
      const { createE2BProvider } = await import("@circuit-nova/nova-core/providers/factory");
      const preset = findWorkspacePreset(request.preset ?? args.preset);
      const sandbox = createE2BProvider(environment, preset.templateAlias);
      if (!sandbox) return { error: "Remote sandboxes need E2B. Set E2B_API_KEY (and E2B_CODING_TEMPLATE for a custom image)." };
      announce(`Starting an E2B sandbox (${preset.label}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `nova_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        return { error: `E2B could not start: ${error instanceof Error ? error.message : String(error)}` };
      }
      const created = new E2BWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        // Stopped rather than suspended: a CLI session that ends has no next step to resume into,
        // and a sandbox left paused keeps costing the user something they cannot see.
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  sandbox ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    if (request.backend === "docker") {
      // Same late import as E2B above, for the same reason: a local session should not pay to load
      // a backend it will never use.
      const { createDockerProvider } = await import("@circuit-nova/nova-core/providers/factory");
      const image = request.dockerImage || args.dockerImage || environment.DOCKER_CODING_IMAGE;
      // The flag wins over the environment variable, but either can name the image.
      const sandbox = createDockerProvider({ ...environment, DOCKER_CODING_IMAGE: image });
      if (!sandbox) return { error: "Could not start a Docker sandbox. Pass --docker-image or set DOCKER_CODING_IMAGE." };
      announce(`Starting a Docker container (${image}, ${minutes}m)…`);
      let session;
      try {
        session = await sandbox.createSandbox({ taskId: `nova_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
      } catch (error) {
        // Docker missing, daemon not running, or image not pullable — all of them land here, and all
        // of them are worth saying plainly rather than as an unhandled rejection stack.
        return { error: `Docker could not start: ${error instanceof Error ? error.message : String(error)}. Check that Docker is installed and running, and that the image exists.` };
      }
      const created = new DockerWorkspace({
        sandbox,
        sandboxId: session.sandboxId,
        workspaceRoot: "/workspace/repo",
        onDispose: (id) => sandbox.stopSandbox(id),
      });
      announce(`  container ${session.sandboxId} — files stay there, not on this machine`);
      if (request.upload ?? args.upload) {
        const uploaded = await uploadProject(created, args.root);
        announce(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}`);
      }
      return { workspace: created };
    }

    return { workspace: new LocalWorkspace(args.root) };
  };

  let workspace: NovaWorkspace;
  {
    const started = args.estimateOnly
      ? { workspace: new LocalWorkspace(args.root) }
      : await createWorkspace({ backend: args.backend });
    if ("error" in started) {
      process.stderr.write(`${style.red(started.error)}\n`);
      exitCleanly();
      return 1;
    }
    workspace = started.workspace;
  }

  refreshProjectFiles();

  let ledger = new CostLedger({
    prices,
    display,
    rates,
    catalog: PRICE_CATALOG,
    ...(approvedBudget ? { budget: approvedBudget } : {}),
  });

  /**
   * Tells the current tab's ledger what the session being resumed has already spent.
   *
   * Without this a budget is a per-process cap wearing a per-session label: the ledger the cap is
   * checked against starts this process at zero, so every resume hands back the whole allowance.
   * Rebuilt from the session's event journal rather than read off the record — see
   * `resumed-spend.ts` for why the record's own running total is not a currency. Reads `ledger`
   * and `prices` at call time rather than capturing them, because switching tabs replaces both.
   */
  const carryResumedSpend = async (record: SessionRecord): Promise<void> => {
    const turns = await readSessionModelTurns(args.root, record.id).catch((error: unknown) => {
      // A journal that fails its integrity check is a reason to distrust the figure, not to
      // invent one. Say so: a budget silently starting over is the failure this exists to prevent.
      out.write(style.yellow(`  Could not read this session's earlier spend (${error instanceof Error ? error.message : String(error)}); the budget below counts only this run.\n`));
      return null;
    });
    if (!turns || turns.length === 0) return;
    const { spent, unpriced } = priceSessionModelTurns(turns, {
      display,
      rates,
      // The catalog first, since it knows what each model the session actually used costs; the
      // current session's own rate card only as a fallback for a model it has never heard of.
      pricesFor: (model) => catalogPrices(spec.id, model) ?? (model === resolvedModelId ? prices : undefined),
    });
    if (unpriced.length > 0) {
      out.write(style.yellow(`  No published rate for ${unpriced.join(", ")}; this session's earlier spend is counted as at least what is shown.\n`));
    }
    if (spent && spent.micros > 0) ledger.carryForward(record.id, spent);
  };

  // Read at ask-time by `createApprovalPrompt`, not captured once: it is replaced every turn (an
  // `AbortSignal` is single-use) but the prompt function itself is built once per agent and must
  // keep seeing whichever turn is currently running.
  let currentTurnAbort: AbortController | undefined;
  const approvalPrompt = createApprovalPrompt(readline, interactive, () => currentTurnAbort?.signal);
  const handleDaemonNotification = (notification: DaemonNotification) => {
    // `turn_started`/`turn_finished`/`session_opened` exist for a client with no other way to know
    // a turn's outcome; this CLI already gets that from `client.send()`'s own return value, so only
    // the event stream needs forwarding here.
    if (notification.type !== "agent_event") return;
    const event = notification.event;
    if (event.type === "runtime" && event.event.type === "assistant_delta") streamedAnswer = true;
    headless?.agentEvent(event);
    renderEvent(event);
  };
  /**
   * One coordinator owns every live agent this process creates.
   *
   * Tabs, mode swaps and model swaps each become a daemon client rather than a directly-held
   * `NovaAgent`, which is what makes this process's sessions reachable the same way a desktop
   * window's or an IDE's are — through `NovaSessionDaemon`, not through a second, parallel way of
   * constructing an agent that the daemon knows nothing about.
   */
  const daemon = new NovaSessionDaemon();
  /**
   * Builds an agent for a tab.
   *
   * The overrides exist because a tab may not be running what the session is: its own model, its
   * own prices, its own machine. Defaulted to the locals so every existing call site — a mode
   * switch, a `/clear`, a resume — keeps meaning "rebuild the tab I am in".
   */
  const openClient = async (
    record?: SessionRecord,
    runtime: { provider?: typeof model; prices?: typeof prices; workspace?: NovaWorkspace } = {},
  ): Promise<NovaDaemonClient> => {
    const client = daemon.connect({
      onNotification: handleDaemonNotification,
      // The daemon's approval type is the flattened cross-boundary shape; the terminal prompt reads
      // `summary`, `safety` and (for a pending write/edit) `preview` off it.
      approve: (request) => approvalPrompt({ summary: request.summary, safety: request.safety, preview: request.preview }),
    });
    await client.open(({ onEvent, approve }) => new NovaAgent({
      root: args.root,
      model: runtime.provider ?? model,
      // The runtime keeps its own integer-unit ceiling as a runaway guard; the ledger below owns the
      // real, currency-aware budget. Feeding it the provider's own per-million rates keeps that guard
      // proportionate to actual spend instead of to a unit nobody configured.
      prices: modelPriceCatalogFor(runtime.prices ?? prices, Boolean(approvedBudget)),
      // The pace's limits are the runtime's own budget fields, merged over the approved cap rather
      // than replacing it: slowing down must never quietly raise a ceiling the user approved.
      budgets: applyPacing(
        approvedBudget && (runtime.prices ?? prices) ? { maxRwf: convertTo(approvedBudget, (runtime.prices ?? prices)!.currency, rates)?.micros ?? approvedBudget.micros } : {},
        pace,
      ),
      mode,
      workspace: runtime.workspace ?? workspace,
      approve,
      search: createExaClient(environment),
      onExpense: (expense) => ledger.recordExpense(expense),
      onEvent,
    }), record);
    return client;
  };
  // Human rendering still runs in headless mode — its output is the stderr diagnostic stream —
  // so a person watching a piped run sees the same narration a caller's parser ignores.
  const headless = writeRecord ? new HeadlessEmitter(writeRecord) : null;
  let agent = await openClient();

  /**
   * One workspace, several pieces of work.
   *
   * Each tab owns its own agent, cost ledger, mode — and its own output sink. Switching swaps the
   * three locals the rest of this loop already reads, and re-points `out` at the incoming tab.
   * Threading a tab handle through every call site instead would touch every line below without
   * changing what any of them do.
   *
   * The sink is what makes a tab a *place* rather than a saved setting: what a tab printed stays
   * addressable after you leave it, so coming back can show where you were instead of an empty
   * screen and a prompt.
   */
  /**
   * Everything that makes one tab a different piece of work from another.
   *
   * Model, provider and workspace joined `agent`/`ledger`/`mode` here because a control panel whose
   * every panel runs the same model in the same place is just a list. A tab on Sonnet against this
   * checkout and a tab on an open model in a throwaway sandbox are the case this exists for, and
   * they are only different if these travel with the tab rather than with the session.
   *
   * `ownsWorkspace` marks the tabs that started their own sandbox. The session's original workspace
   * is shared — closing the tab that happens to hold it must not dispose the thing every other tab
   * is still using — while a sandbox a tab started is a sandbox a tab stops paying for.
   */
  type TabPayload = {
    agent: NovaDaemonClient;
    ledger: CostLedger;
    mode: NovaMode;
    sink: TabSink;
    provider: typeof model;
    spec: typeof spec;
    prices: typeof prices;
    modelId: string;
    backend: SandboxBackend;
    workspace: NovaWorkspace;
    ownsWorkspace: boolean;
  };

  /** What the strip and the workspace show about a tab, from what only this file knows. */
  const describeTab = (payload: TabPayload) => ({
    model: payload.modelId,
    backend: payload.backend,
    cost: payload.ledger.displayTotal ? formatMoney(payload.ledger.displayTotal) : "",
  });
  const tabs = new WorkspaceController<TabPayload>();

  /**
   * How much of a tab's own transcript is reprinted when you return to it.
   *
   * Enough to re-establish where the work was, not so much that switching tabs buries the thing you
   * switched in order to do. The full record is still in the tab's sink; this is the reminder.
   */
  const REPLAY_LINES = 12;

  /** Writes the shared locals back into the tab being left, and takes it off the terminal. */
  const stashActiveTab = (): void => {
    const current = tabs.active;
    current.payload.agent = agent;
    current.payload.ledger = ledger;
    current.payload.mode = mode;
    current.payload.provider = model;
    current.payload.spec = spec;
    current.payload.prices = prices;
    current.payload.modelId = resolvedModelId;
    current.payload.workspace = workspace;
    current.payload.sink.setLive(false);
  };

  /**
   * Makes a tab the one in front: its state becomes the shared locals, and its sink becomes the
   * address every write in this file resolves to.
   */
  const enterTab = (tab: { title: string; payload: TabPayload }, options: { replay?: boolean } = {}): void => {
    ({ agent, ledger, mode, workspace } = tab.payload);
    model = tab.payload.provider;
    spec = tab.payload.spec;
    prices = tab.payload.prices;
    resolvedModelId = tab.payload.modelId;
    tab.payload.sink.setLive(true);
    out.route(tab.payload.sink);
    if (options.replay) replayTab(tab);
  };

  /**
   * Reprints the tail of a tab's transcript on return.
   *
   * Printed *through* the sink like anything else, so the replay itself becomes part of that tab's
   * record — a tab's history stays a truthful account of what its screen has shown, rather than a
   * log that quietly disagrees with the terminal.
   */
  function replayTab(tab: { title: string; payload: TabPayload }): void {
    const replay = replayLines(tab.payload.sink.log, REPLAY_LINES);
    if (replay.lines.length === 0) return;
    const above = replay.omitted + replay.dropped;
    out.write(`${rule(sectionStyle(), {
      label: tab.title,
      tone: "accent",
      ...(above > 0 ? { trailing: `${above} earlier lines above` } : {}),
    })}\n`);
    for (const line of replay.lines) out.write(`${line}\n`);
  }

  const firstSink = new TabSink(terminalStream, { live: true });
  tabs.adopt(path.basename(args.root) || "nova", {
    agent, ledger, mode, sink: firstSink,
    provider: model, spec, prices, modelId: resolvedModelId,
    backend: args.backend, workspace, ownsWorkspace: false,
  });
  out.route(firstSink);

  const switchTab = (id: number): boolean => {
    if (tabs.active.id === id) return Boolean(tabs.find(id));
    stashActiveTab();
    const next = tabs.activate(id);
    if (!next) {
      // Nothing was switched to, so the tab that was just stashed is still the one in front.
      enterTab(tabs.active);
      return false;
    }
    enterTab(next, { replay: true });
    return true;
  };
  /** Whether this session has already explained that a background tab is paused rather than working. */
  let explainedTabs = false;

  const showTabs = () => {
    // Detail on: once tabs can differ in model and location, which is which is the only thing the
    // strip is actually being read for.
    const strip = renderTabStrip(tabs.views(describeTab), { width: contentWidth(), glyphs, detail: true });
    if (strip) out.write(`  ${style.dim(strip)}\n`);
  };

  /**
   * What the pinned footer shows between turns: not the spinner's "thinking" line, which only
   * exists while one is active, but the quieter facts worth having pinned at rest — mode, the tab
   * strip when there is more than one, and the running total. Redrawn once per prompt cycle (see
   * the loop below) rather than pushed from every command that could change one of these, the same
   * way a real status bar settles on its next natural repaint instead of being wired to every
   * mutation site.
   */
  const idleStatusLine = (): string => {
    const strip = tabs.size > 1 ? `${renderTabStrip(tabs.views(describeTab), { width: screen?.current.columns ?? 80, glyphs })} ${glyphs.middot} ` : "";
    const cost = ledger.displayTotal ? formatMoney(ledger.displayTotal) : "cost unknown";
    const badge = pace === "off" ? "" : ` ${style.yellow(paceBadge(pace, glyphs))}`;
    const remembered = memories.length > 0 ? ` ${style.dim(`${glyphs.middot} ${memories.length} remembered`)}` : "";
    return `${strip}${style.cyan(mode)}${badge} ${style.dim(`${glyphs.middot} ${cost}`)}${remembered}`;
  };

  /**
   * The idle line, on whichever footer this session has.
   *
   * With `--pin` it goes to the reserved row; without one it is drawn by `StatusBar`, which erases
   * and redraws itself in place — the same information, at the cost of living in the flow of the
   * transcript rather than above it, and with the terminal's own scrollback left intact.
   */
  /**
   * How a full-screen view borrows the terminal. One definition, used by every screen, because the
   * six steps have to happen in the same order every time and a missed one leaves a dead prompt.
   */
  const terminalControls = (): TerminalControls => ({
    clearStatus: () => statusBar.clear(),
    releaseScreen: () => screen?.exit(),
    uninstallShortcuts: () => uninstallShortcuts(),
    installShortcuts: () => installShortcutsAgain(),
    pauseInput: () => readline.pause(),
    resumeInput: () => readline.resume(),
    restoreScreen: () => { screen?.enter(); showIdleStatus(); },
  });

  const screenCapabilities = (): ScreenCapabilities => ({
    interactive: interactive && Boolean(process.stdout.isTTY),
    columns: process.stdout.columns ?? 80,
    rows: process.stdout.rows ?? 24,
  });

  /**
   * Opens a file in the built-in editor and writes it back if it was saved.
   *
   * Reads and writes through the workspace rather than `node:fs`, so `/edit` works identically
   * against a remote sandbox — the same rule every tool follows. The file is only written when the
   * editor reports a save, so quitting really is a discard.
   */
  const editFile = async (target: string): Promise<void> => {
    let existing = "";
    try {
      existing = (await workspace.readFile(target, {})).content;
    } catch (error) {
      // A missing path is a new file, which is the ordinary way `nano somefile` is used. Anything
      // else — a directory, a permission error — is reported rather than silently starting blank.
      const message = error instanceof Error ? error.message : String(error);
      if (!/not found|ENOENT|no such file/i.test(message)) {
        out.write(style.yellow(`  Cannot open ${target}: ${message}\n`));
        return;
      }
    }
    let saved: string | undefined;
    const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
      const { runEditorScreen } = await import("./editor-screen");
      saved = await runEditorScreen({
        columns: process.stdout.columns ?? 80,
        rows: process.stdout.rows ?? 24,
        path: target,
        content: existing,
        palette,
      });
    });
    if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); return; }
    if (saved === undefined) { out.write(style.dim(`  ${target} left unchanged.\n`)); return; }
    if (saved === existing) { out.write(style.dim(`  ${target} saved with no changes.\n`)); return; }
    const result = await workspace.writeFile(target, saved);
    out.write(style.green(`  Saved ${result.path} (${result.bytesWritten} bytes).\n`));
  };

  /**
   * Models the providers themselves report, over and above the ones this build was compiled with.
   *
   * Held for the session and filled on first use, so completion and the picker widen without any
   * of them paying for a request. A failure leaves it empty, which is exactly the behaviour the
   * CLI had before fetching existed.
   */
  let liveModels: Partial<Record<ProviderId, string[]>> = {};

  /**
   * Fills `liveModels`, from cache when it is fresh and from the providers otherwise.
   *
   * Never called at startup. A CLI that reaches the network before drawing its first prompt is a
   * CLI whose launch time depends on someone else's DNS, and the only thing the request buys is a
   * longer list in a menu that may never be opened. The cache is read at startup — that is free —
   * and the request happens the first time the list is actually wanted.
   */
  const refreshLiveModels = async (options: { refresh?: boolean } = {}): Promise<{ errors: string[] }> => {
    const providers = fetchableProviders(environment, PROVIDER_IDS);
    if (providers.length === 0) return { errors: [] };
    const loaded = await loadLiveModels(providers, environment, options);
    if (Object.keys(loaded.models).length > 0) liveModels = loaded.models;
    return {
      errors: loaded.errors
        // Ollama needs no key, so it is always "configured" and is always asked — a free probe of
        // localhost that costs nothing when nothing is listening. Reporting that refusal is a
        // different matter: to everyone not running Ollama it is a warning about a provider they
        // have never heard of, printed every time they ask to see the model list. It is only worth
        // saying when they pointed Nova at an Ollama server and it did not answer.
        .filter((error) => error.provider !== "ollama" || Boolean(environment.OLLAMA_BASE_URL?.trim()))
        .map((error) => `${error.provider}: ${error.error}`),
    };
  };
  // Free: a cache hit widens completion and the picker with no request at all. A miss simply means
  // the first `/models` pays for the fetch.
  {
    const cached = await readModelCache(environment);
    if (isCacheFresh(cached)) liveModels = cached!.models;
  }

  /**
   * The input bar's three rows, composed against the screen's live geometry.
   *
   * `status` is whatever the footer should currently be saying — the idle cost line between turns,
   * the spinner's activity line during one. It rides on the box's top border rather than on a row
   * of its own, which is what keeps the chat-style bar to one row more than the plain status line
   * it replaces.
   */
  const promptWidth = () => screen?.current.columns ?? process.stdout.columns ?? 80;

  const promptFrame = (status: string) =>
    renderPromptBox({ mode, workspace: where, depth, width: promptWidth(), status, glyphs, borderStyle: palette.borderStyle });

  /**
   * The inline input bar, for the sessions that do not pin a footer — which is almost all of them,
   * since pinning costs the terminal's scrollback and is therefore off unless asked for.
   *
   * Without this the default session had no bar at all: `showStatus` fell through to a plain status
   * line and the prompt to a bare `nova ›`. The chat-app box existed only under `--pin`, which is
   * exactly backwards — the polish was reserved for the configuration almost nobody runs.
   */
  const promptBox = new PromptBox(out, {
    depth,
    glyphs,
    borderStyle: palette.borderStyle,
    columns: promptWidth,
  });
  /** True when the inline bar owns the bottom rows: a real TTY that is not holding a region. */
  const inlineBar = (): boolean => ttyMode && screen !== undefined && !screen.pinned;

  /** How wide a status line may be to fit on the bar's top border beside the title. */
  const statusRoomFor = (width: number) => promptStatusRoom(mode, where, width, glyphs);

  /**
   * Repaints the footer with a new status, leaving the input line alone.
   *
   * Both borders are redrawn, not just the top: on a resize the bottom border has moved to a row
   * that previously held transcript, and only the caller of this knows the layout changed.
   */
  const showStatus = (status: string): void => {
    if (screen?.pinned) {
      const frame = promptFrame(status);
      screen.renderStatus(frame.top);
      screen.renderPromptBottom(frame.bottom);
    } else if (inlineBar() && !turnActive) {
      // Between turns the inline bar carries the status on its own top border, so a separate
      // status line would say the same thing twice, one row apart. Mid-turn there is no bar drawn
      // — the activity line is the only status there is — and `statusBar` remains the right home.
      statusBar.clear();
    } else if (ttyMode) statusBar.renderLine(status);
  };

  const showIdleStatus = (): void => showStatus(idleStatusLine());

  /**
   * Jobs whose output is flowing into this session without owning the prompt.
   *
   * A watched job writes into a sink of its own, so it keeps producing while you work on something
   * else, and `/watch show` prints what it has said. That is the difference from `/attach`, which
   * is still here and still the way to *answer* a job — an approval is a question for a person, and
   * a question nobody is looking at is worse than a blocking prompt.
   */
  const watched = new WatchRegistry();

  const startWatching = async (id: string, objective: string): Promise<void> => {
    if (watched.has(id)) { out.write(style.dim(`  already watching ${id}\n`)); return; }
    const sink = new TabSink(terminalStream);
    const stream = new JobStream({
      root: args.root,
      id,
      sink,
      readLog: (root, jobId, fromByte) => readJobLog(root, jobId, fromByte),
      readState: async (root, jobId) => {
        const job = await getJob(root, jobId);
        return job ? { status: job.status, ...(job.pendingApproval ? { pendingApproval: { summary: job.pendingApproval.summary } } : {}) } : undefined;
      },
      format: (line) => `${style.dim(`${id.slice(-6)} ${glyphs.boxVertical}`)} ${line}`,
      onApproval: (summary) => {
        // Written to the session, not to the job's own sink: an approval nobody reads is a job
        // stopped forever, so this is the one thing a background stream is allowed to interrupt with.
        out.write(`  ${style.yellow("approval needed")} ${style.dim(`${glyphs.middot} ${id}`)} ${summary}\n`);
        out.write(`  ${style.dim(`/attach ${id} to answer it`)}\n`);
      },
      onFinished: (status) => {
        out.write(`  ${status === "completed" ? style.green(status) : style.yellow(status)} ${style.dim(`${glyphs.middot} job ${id}`)} ${style.dim(`${glyphs.middot} /watch show ${id}`)}\n`);
      },
    });
    watched.add(id, { stream, sink, objective, startedAt: Date.now() });
    stream.start();
  };

  /** Enqueues a fresh (non-continuation) job and starts its worker — the shared tail of `/jobs run` and `/detach <task>`. */
  const startBackgroundJob = async (objective: string) => {
    // Said every time, because it changes where code executes: a job worker builds its own local
    // workspace and does not inherit this session's sandbox.
    const warning = sandboxWarning(tabs.size > 0 ? tabs.active.payload.backend : args.backend);
    if (warning) out.write(`  ${style.yellow(warning)}\n`);
    const id = newJobId();
    const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id) });
    await spawnJobWorker(args.root, job.id);
    // Watched from the moment it starts. A job you have to remember to subscribe to is a job whose
    // first minute — the part that usually explains the rest — is the part nobody ever sees.
    await startWatching(job.id, objective);
    return job;
  };

  if (args.estimateOnly) {
    if (!args.prompt) {
      process.stderr.write("Pass the task to estimate, for example: nova --estimate \"fix the failing tests\"\n");
      await agent.dispose();
      exitCleanly();
      return 1;
    }
    out.write(`${ledger.formatPrediction(await agent.estimate(args.prompt))}\n`);
    await agent.dispose();
    exitCleanly();
    return 0;
  }

  if (args.resume) {
    const indexed = args.resume === "latest" ? await stateHistory.sessions(1) : null;
    const id = args.resume === "latest"
      ? indexed?.[0]?.sessionId ?? (await listSessions(args.root, 1))[0]?.id
      : args.resume;
    const record = id ? await loadSession(args.root, id) : null;
    if (record) {
      // The daemon resumes at construction, not in place — swap the fresh client already opened
      // above for one opened against the resumed record, the same handoff every mode/model switch
      // below performs.
      await agent.relinquish();
      agent = await openClient(record);
      await carryResumedSpend(record);
      out.write(style.dim(`Resumed ${record.id} — ${record.title}\n`));
      // Where the conversation actually got to, not just its id. A resumed session that opens on
      // an empty screen asks the user to trust that a transcript they cannot see is loaded, and
      // the usual next move — scroll back to check — has nothing to scroll to.
      //
      // Only when this run will actually stop at a prompt. A replay is orientation for someone
      // about to type; in front of a one-shot answer it is preamble nobody is waiting for, and
      // `nova --resume "…"` from a terminal is still a one-shot even though the terminal is real.
      if (interactive && !args.prompt) out.write(`${renderReplay(record, sectionStyle(), { turns: 2 })}\n`);
    } else if (args.resume === "latest") {
      out.write(style.yellow("No matching session; starting a new one.\n"));
    } else {
      // An explicit id is a request for *that* conversation. Starting a fresh one instead looks
      // identical for the first few seconds and then diverges silently — the work lands in a new
      // session while the user believes they are adding to the old one. A mistyped id is far
      // cheaper to be told about now.
      process.stderr.write(`${style.red(`No session ${args.resume} in this project.`)} Run nova --sessions to list them.\n`);
      await agent.dispose();
      await stateHistory.close();
      exitCleanly();
      return EXIT_CODES.usage;
    }
  }

  // Ctrl-C interrupts the turn rather than the process, so a long tool loop can be stopped
  // without losing the session that produced it.
  let turnActive = false;
  let exitRequested = false;
  const handleSigint = () => {
    if (turnActive) {
      agent.cancel();
      // `agent.cancel()` alone only flips a flag `BoundedAgentRuntime` checks between steps. If
      // this turn is actually blocked inside the approval prompt's `readline.question()` — not a
      // step the runtime loop is between — nothing else would ever unblock it.
      currentTurnAbort?.abort();
      activity.awaitingFirstDelta = false;
      spinner?.stop();
      statusBar.clear();
      out.write(style.yellow("\n  interrupted — finishing the current tool call\n"));
      return;
    }
    // Nothing is running, so this is the prompt. A half-typed message must survive a stray
    // Ctrl+C: every other REPL (bash, python, node) clears the line here rather than quitting,
    // and losing a paragraph you were still composing to one keystroke is the worst possible
    // reading of "I changed my mind". Only an already-empty line means the session itself.
    const pending = (readline as { line?: string }).line ?? "";
    if (pending !== "") {
      // Kill to the start of the line and then to the end, so the line clears whole wherever the
      // cursor happened to sit. Both are ordinary `rl.write(null, key)` calls — the public API —
      // rather than a reach into readline's private redraw internals.
      readline.write(null, { ctrl: true, name: "u" });
      readline.write(null, { ctrl: true, name: "k" });
      return;
    }
    exitRequested = true;
    exitCleanly();
  };
  // Node's readline puts a TTY into raw mode, which disables the kernel's own ISIG handling — so a
  // real Ctrl+C keypress in an interactive session never reaches the process as an OS signal at
  // all; readline reads the byte itself and re-emits it as the *interface's* own "SIGINT" event.
  // `process`'s "SIGINT" only fires for a genuine external signal (`kill -INT`, a piped/non-TTY
  // run). Both are registered so either source reaches the same handler.
  const bindSigint = () => { process.on("SIGINT", handleSigint); readline.on("SIGINT", handleSigint); };
  const unbindSigint = () => { process.off("SIGINT", handleSigint); readline.off("SIGINT", handleSigint); };
  bindSigint();
  exitCleanly = () => { unbindSigint(); watched.stopAll(); screen?.exit(); uninstallShortcuts(); readline.close(); };

  /** Set when the turn about to run is a wander lab, so its results chart is printed once, after it. */
  let wanderRunning = false;
  /** Which commands this session has reached for, so suggestions stop offering what you already use. */
  const usage = new CommandUsage();
  /** Findings the last `/scan` reported, so defender work can be offered when there is some. */
  let lastScanFindings: number | undefined;
  /**
   * How the last turn went wrong, if it did — kept apart from `lastTurnStatus`, which starts at
   * "failed" so that a process that dies before its first turn exits non-zero. Reading that for a
   * *suggestion* would open every session by offering a way out of a failure that never happened.
   */
  let lastFailure: { status: NavContext["lastStatus"]; message: string } | null = null;
  /**
   * The runtime's stop reason as the protocol's turn status.
   *
   * They agree on every value but one — the runtime calls a paused approval "needs_approval" — and
   * the suggestion rules speak the protocol's vocabulary, since the desktop reaches them through
   * the same names.
   */
  const failureStatus = (status: AgentRuntimeResult["status"]): NavContext["lastStatus"] =>
    status === "needs_approval" ? "waiting_approval" : status;

  /**
   * Where this session actually is, for anything that has to decide what to offer.
   *
   * Read fresh at every use rather than kept as state: every field here already lives somewhere
   * that owns it — the ledger, the tab controller, the watch registry — and a second copy would be
   * one more thing to keep in step, which is exactly how a "smart" suggestion starts describing a
   * session that ended two turns ago.
   */
  const navContext = (): NavContext => ({
    mode,
    turns: ledger.history.length,
    changedFiles: touchedFiles.size,
    openTodos: agent.todos.filter((item) => item.status !== "done").length,
    runningJobs: watched.size,
    tabs: tabs.size,
    sandbox: agent.workspaceKind !== "local",
    providerConfigured: true,
    hasSpend: Boolean(ledger.displayTotal?.micros),
    ...(lastScanFindings === undefined ? {} : { openFindings: lastScanFindings }),
    ...(ledger.budgetFraction === undefined ? {} : { budgetFraction: ledger.budgetFraction }),
    ...(lastFailure ? { lastStatus: lastFailure.status, lastError: lastFailure.message } : {}),
    recent: usage.recent,
  });
  /**
   * One ambient line, printed where a command had nothing of its own to say.
   *
   * Interactive only, and silent when the rules have nothing left to teach — a session that has
   * already reached for everything relevant gets its empty result back unadorned, which is the
   * point at which a hint would have become a tic.
   */
  const writeHint = (): void => {
    if (!interactive) return;
    const hint = renderHint(navContext(), sectionStyle());
    if (hint) out.write(`${hint}\n`);
  };
  /** Whether the extra model pass is on. A setting, read once, defaulting to off. */
  const suggestModel = (environment.NOVA_SUGGEST_MODEL ?? "").trim().toLowerCase() === "on";

  /** Two usages as one, so a turn's cost line covers everything that turn actually spent. */
  const addModelUsage = (left: ModelUsage, right: ModelUsage): ModelUsage => ({
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
  });

  /**
   * One small, tool-less call to the session's own model for a couple of extra suggestions.
   *
   * Never throws and never blocks the transcript on a failure: a suggestion is the least important
   * thing on screen, and a session must not see an error because the hint line could not think of
   * anything. The usage comes back with them so the caller can bill it to the turn it belongs to.
   */
  const modelSuggestions = async (
    request: string,
    summary: string,
  ): Promise<{ suggestions: EngineSuggestion[]; usage?: ModelUsage }> => {
    let usage: ModelUsage | undefined;
    const suggestions = await askModelForSuggestions(
      {
        complete: async ({ messages, maxOutputTokens }) => {
          const turn = await model.complete({
            messages: messages.map((message) => ({ role: message.role, content: message.content })),
            tools: [],
            maxOutputTokens,
            safetyIdentifier: agent.sessionId,
          });
          usage = turn.usage;
          return { content: turn.content };
        },
      },
      navSignals(navContext()),
      { lastRequest: request, lastSummary: summary },
    );
    return usage ? { suggestions, usage } : { suggestions };
  };

  let streamedAnswer = false;
  /** The last turn's terminal status, which headless mode turns into the process exit code. */
  let lastTurnStatus: AgentRuntimeResult["status"] = "failed";
  /** When the last turn finished, for the pace's cooldown. */
  let lastTurnEndedAt: number | undefined;
  /**
   * Whether this thread has already been told what Nova remembers.
   *
   * Sent once per thread, not once per turn: the conversation carries it forward, so re-sending the
   * same paragraph every turn would bill the user for it every turn. Reset whenever the set changes
   * or the thread does, which are exactly the two moments the model's copy goes stale.
   */
  // Recall is incremental within a thread: a topic change can pull in newly relevant knowledge,
  // while facts already present in the conversation are never billed twice.
  const recalledMemoryKeys = new Set<string>();
  const runTurn = async (request: string): Promise<boolean> => {
    headless?.turnStart(request);
    streamedAnswer = false;
    if (screen) {
      screen.parkInTranscript();
      // The bubble already carries its own "you" label on the box border — a rule printed above
      // it duplicated that label as a second, redundant divider (a leftover from before the two
      // terminal UIs were merged into one). One clearly delimited speaker marker, not two.
      out.write(`${renderUserTurn(request)}\n`);
    }

    // The pace's quiet time, spent before anything is sent. A pause after the *previous* turn is
    // where a person notices the agent misunderstood them; a pause after this one would be too late.
    const cooldown = remainingCooldown(pace, lastTurnEndedAt);
    if (cooldown > 0) {
      const totalCooldown = cooldown;
      const label = (remaining: number, fill: number) =>
        style.dim(`  ${paceBadge(pace, glyphs)} ${glyphs.middot} pausing [${progressBar(fill, 12, { depth: renderDepth, glyphs })}] ${formatCountdown(remaining)} before the next turn`);
      const handle = toolLines.append(label(cooldown, 1));
      // Two clocks, not one: CountdownTimer stays the second-by-second source the text reads from
      // (a bar's own physics has no business deciding what a person reads as "6s"), while the bar's
      // fill eases toward whatever fraction that implies on its own, faster cadence — so the shrink
      // reads as continuous motion between each second's change instead of only the number moving.
      let remainingNow = cooldown;
      const bar = new SpringAnimator(1, (fill) => toolLines.update(handle, label(remainingNow, fill)), { intervalMs: 60 });
      await new Promise<void>((resolve) => {
        new CountdownTimer(cooldown, (remaining) => {
          remainingNow = remaining;
          bar.retarget(Math.max(0, Math.min(1, remaining / totalCooldown)));
        }, () => {
          remainingNow = 0;
          bar.snapTo(0);
          forgetToolLines();
          resolve();
        }).start();
      });
    }
    const taskSafety = assessTaskSafety(request);
    if (mode !== "plan" && !await confirmSensitiveTask(readline, interactive, taskSafety, args.allowSensitive)) {
      out.write(style.yellow("  Task cancelled before the model was contacted.\n"));
      return false;
    }
    if (ledger.exhausted) {
      out.write(`${style.red("Budget spent.")} ${ledger.budgetWarning()}\n`);
      return false;
    }
    if (approvedBudget && prices) {
      const spent = ledger.displayTotal?.micros ?? 0;
      const remainingDisplay: Money = { currency: approvedBudget.currency, micros: Math.max(0, approvedBudget.micros - spent) };
      const remainingProvider = convertTo(remainingDisplay, prices.currency, rates);
      if (!remainingProvider) {
        out.write(`${style.red("Cannot continue safely — the approved cap cannot be converted to the provider currency.")}\n`);
        return false;
      }
      agent.setModelSpendLimit(remainingProvider.micros);
    }
    try {
      const prediction = await agent.estimate(request);
      out.write(style.dim(`  ${ledger.formatPrediction(prediction)}\n`));
      // The pace asks about a turn that looks expensive *before* it starts, which is the only
      // moment the answer is still cheap. Skipped without a terminal: there is nobody to ask, and a
      // pace is a preference, not a guard that should turn into a refusal in automation.
      if (interactive && exceedsPace(pace, prediction)) {
        statusBar.clear();
        const answer = (await readline.question(
          `  ${style.yellow(paceBadge(pace, glyphs))} this turn looks large. Run it? ${style.dim("[Y/n]: ")}`,
        )).trim().toLowerCase();
        if (answer !== "" && answer !== "y" && answer !== "yes") {
          out.write(style.dim("  skipped — nothing was sent to the model\n"));
          return false;
        }
      }
    } catch (error) {
      out.write(style.yellow(`  Could not estimate this turn: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    const started = Date.now();
    // Per-turn counters, and a clean markdown state: an unclosed code fence from the last answer
    // must not colour this one as code.
    activity.toolCalls = 0;
    activity.tokens = 0;
    activity.phase = "thinking";
    activity.operation = undefined;
    activity.steps = undefined;
    touchedFiles = new Set();
    forgetToolLines();
    markdown.reset();
    if (ttyMode) {
      activity.awaitingFirstDelta = true;
      const fields = () => ({
        mode,
        spinnerGlyph: spinner!.glyph,
        elapsedMs: Date.now() - started,
        toolCalls: activity.toolCalls,
        tokens: activity.tokens,
        cost: ledger.displayTotal ? formatMoney(ledger.displayTotal) : "cost unknown",
        phase: activity.phase,
        operation: activity.operation,
        // The agent's own plan, counted. Present only once it has one — an X-of-Y with nothing
        // behind it is worse than no counter at all.
        steps: activity.steps,
        badge: paceBadge(pace, glyphs),
      });
      // A pinned footer redraws its own fixed row and never needs the erase-above-cursor dance
      // `StatusBar` does — that class stays the renderer for every session without one.
      //
      // The activity line goes onto the input bar's top border, the same row the idle line uses, so
      // the box stays whole for the length of the turn instead of losing its lid the moment work
      // starts. It gets the border's inner width rather than the terminal's: `formatStatusLine`
      // drops segments to fit what it is given, and handing it the full width would have it fit a
      // row that the corners and title have already spent part of.
      spinner = new Spinner(() => screen?.pinned
        ? showStatus(formatStatusLine(fields(), statusRoomFor(screen.current.columns), depth, glyphs))
        : statusBar.render(fields(), depth, glyphs), 120, glyphs, SPINNER_START_DELAY_MS);
      spinner.start();
    }
    turnActive = true;
    currentTurnAbort = new AbortController();
    try {
      // A small lexical recall runs locally for each request. It adds only memories not already in
      // this thread, preserving the prompt prefix and avoiding the fixed cost of sending the whole
      // memory file to every conversation regardless of subject.
      const recalled = recallMemories(memories, request, { exclude: recalledMemoryKeys });
      for (const entry of recalled.entries) recalledMemoryKeys.add(recalledMemoryKey(entry));
      const preamble = memoryPromptBlock(recalled.entries);
      const result = await agent.send(preamble ? `${preamble}\n${request}` : request);
      // `agent.send` has atomically saved the canonical snapshot and closed the turn's journal at
      // this point. Rebuild in the background so `/history` is instant after ordinary work; the
      // service coalesces this with a history command if the user asks before replay finishes.
      stateHistory.markDirty();
      void stateHistory.refresh();
      activity.awaitingFirstDelta = false;
      spinner?.stop();
      statusBar.clear();
      endStreamedLine();

      // On a non-completed status the runtime's summary explains the *stop*, not the work — so
      // printing it alone throws away everything the agent actually said. Observed on a real run
      // that wrote a working script: the answer vanished behind "needs verification". But the
      // summary for `needs_verification` specifically already embeds that same text ("The agent
      // reported: ..."), and a streamed answer is already on screen either way — printing it raw
      // *as well* in either case put the same paragraph on screen two or three times over.
      const spoken = [...result.messages].reverse().find(
        (message) => message.role === "assistant" && !("toolCalls" in message) && message.content.trim(),
      );
      const spokenText = spoken?.content.trim();
      // A provider that cannot stream reaches here with the whole answer at once. It gets the same
      // markdown treatment the streamed path gives it, so the two are indistinguishable on screen.
      const asMarkdown = (text: string) => renderMarkdown(text, { width: contentWidth(), depth });
      // A provider that never streamed never printed the "✦ Nova" header renderEvent's first-delta
      // branch owns — this is the one other place a reply begins, so it owns the header here.
      if (!streamedAnswer) out.write(`\n${style.dim(glyphs.star)} ${style.bold("Nova")}\n`);
      if (result.status !== "completed" && spokenText && !streamedAnswer && !result.summary.includes(spokenText)) {
        out.write(`\n${asMarkdown(spokenText)}\n`);
      }
      // When the answer streamed, it is already on screen — reprinting it verbatim is noise.
      if (!(result.status === "completed" && streamedAnswer)) {
        out.write(`\n${result.status === "completed" ? asMarkdown(result.summary) : style.yellow(result.summary)}\n`);
      }

      if (touchedFiles.size > 0) {
        out.write(`${panel([...touchedFiles].sort(), sectionStyle(), { title: "files modified", tone: "good" })}\n`);
      }

      // A finished lab grades every claim it kept, and the grades are the finding. Read from the
      // structured file the lab writes rather than from its prose, and shown only when the run that
      // just ended was a wander — the file lingers in the project afterwards, and reprinting last
      // week's chart under an unrelated turn would be a lie about what just happened.
      if (wanderRunning) {
        wanderRunning = false;
        const graded = await agent.readFile(WANDER_LAB_FILES.results).catch(() => null);
        const chart = graded ? renderWanderResults(graded.content, sectionStyle(), contentWidth()) : null;
        if (chart) out.write(`${chart}\n`);
      }

      const turn = ledger.record({
        usage: result.usage,
        iterations: result.iterations,
        toolCalls: result.toolCallsExecuted,
        elapsedMs: Date.now() - started,
      });
      // The turn's own closing rule. A transcript without one is a single column in which the end
      // of an answer and the start of the next question look identical.
      out.write(`${rule(sectionStyle(), {
        label: result.status,
        tone: result.status === "completed" ? "good" : "warn",
        trailing: ledger.formatTurn(turn),
      })}\n`);
      const warning = ledger.budgetWarning();
      if (warning) out.write(`  ${style.yellow(warning)}\n`);
      // A turn ending is the one moment a person is deciding what to do next, so this is where the
      // suggestions go: what the situation calls for, with the reason attached, plus — only when
      // the situation was quiet enough to leave room — one thing about Nova worth knowing.
      // Suppressed once they have used it: a hint you have taken is not a hint.
      lastFailure = result.status === "completed" ? null : { status: failureStatus(result.status), message: result.summary };
      // The optional model pass, off unless someone turned it on. Its cost is folded into *this*
      // turn's usage rather than recorded as a turn of its own: it is part of what answering this
      // request cost, and a phantom turn in `/cost` would misreport both the count and the shape of
      // the session's spend. It can only ever propose things to ask for, never actions to run.
      const asks: { suggestions: EngineSuggestion[]; usage?: ModelUsage } =
        suggestModel ? await modelSuggestions(request, result.summary) : { suggestions: [] };
      if (asks.usage) result.usage = addModelUsage(result.usage, asks.usage);
      const next = renderSuggestions(navContext(), sectionStyle(), { limit: 2, hints: true });
      if (next && interactive) out.write(`${next}\n`);
      if (asks.suggestions.length > 0 && interactive) {
        const rendered = renderAsks(mergeModelSuggestions([], asks.suggestions, { maxModel: 2 }), sectionStyle());
        if (rendered) out.write(`${rendered}\n`);
      }
      lastTurnStatus = result.status;
      headless?.turnEnd({
        status: result.status,
        summary: result.summary,
        iterations: result.iterations,
        toolCalls: result.toolCallsExecuted,
        usage: result.usage,
        cost: ledger.displayTotal ? formatMoney(ledger.displayTotal) : null,
        elapsedMs: Date.now() - started,
      });
      refreshProjectFiles(); // a turn can create files, and the next mention should complete them
    } catch (error) {
      activity.awaitingFirstDelta = false;
      spinner?.stop();
      statusBar.clear();
      endStreamedLine();
      const message = error instanceof Error ? error.message : String(error);
      // The runtime enforces the cap by throwing, which on its own reaches the user as a bare
      // internal sentence: no amount, no cap, no way forward. Name it for what it is.
      if (/exceeds the reserved model budget/i.test(message) && args.budget) {
        out.write(`\n${style.yellow(`Stopped at the ${formatMoney(fromUnits(args.budget, display))} cap for this request.`)}\n`);
        out.write(style.dim(`  Raise it with --budget, or ask for something smaller.\n`));
        lastTurnStatus = "iteration_limit";
        lastFailure = { status: "iteration_limit", message };
        const recovery = renderRecovery(navContext(), sectionStyle());
        if (recovery && interactive) out.write(`${recovery}\n`);
        headless?.error(`Stopped at the approved cap for this request.`, { status: "iteration_limit" });
        return false;
      }
      // A raw transport error ("fetch failed", "getaddrinfo ENOTFOUND …") reads as "the internet
      // is broken", which is usually wrong — it is one endpoint failing. Name the host, the
      // failure class, and the next step; anything that is not a network fault prints as before.
      const diagnosis = classifyNetworkError(error, {
        host: hostOf(providerBaseUrl(environment, spec.id)),
        purpose: `the model API (${spec.label})`,
      });
      if (diagnosis) {
        out.write(`${style.red("error")} ${diagnosis.message}\n`);
        if (diagnosis.hint) out.write(`  ${style.dim(diagnosis.hint)}\n`);
      } else {
        out.write(`${style.red("error")} ${message}\n`);
      }
      // An error says what broke; this says what to do about it. The rules only speak when they
      // recognise the failure — an invented next step after a real error costs a detour to
      // discover it was a guess, which is worse than the silence it replaced.
      lastFailure = { status: "failed", message };
      const recovery = renderRecovery(navContext(), sectionStyle());
      if (recovery && interactive) out.write(`${recovery}\n`);
      lastTurnStatus = "failed";
      headless?.error(message, { status: "failed" });
      return false;
    } finally {
      turnActive = false;
      currentTurnAbort = undefined;
      lastTurnEndedAt = Date.now();
    }
    return true;
  };

  if (args.prompt) {
    // Announced before any work, so a consumer knows what it is reading before the first event.
    headless?.session({
      sessionId: agent.sessionId,
      root: args.root,
      provider: spec.id,
      model: resolvedModelId,
      mode,
      workspace: agent.workspaceLabel,
    });
    const ran = await runTurn(args.prompt);
    // A one-shot run against a sandbox would otherwise leave the work unreachable, so it is
    // offered back before the sandbox goes away.
    if (ran && workspace.kind === "e2b") {
      const destination = path.resolve(args.root, "nova-pull");
      const pulled = await downloadProject(workspace, destination);
      out.write(style.dim(`  pulled ${pulled.written.length} files into ${destination}\n`));
    }
    await agent.dispose();
    await stateHistory.close();
    exitCleanly();
    // Headless callers get the specific outcome; the human path keeps its long-standing 0/1.
    return args.json ? exitCodeForStatus(lastTurnStatus) : (ran ? 0 : 1);
  }

  if (!interactive) {
    process.stderr.write(`${style.red("No terminal attached.")} Pass a request as an argument to run a single turn: nova "your request".\n`);
    exitCleanly();
    return 1;
  }

  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);
  const bannerOptions = {
    width: process.stdout.columns ?? 80,
    depth,
    glyphs,
    subtitle: `${mode} ${glyphs.middot} ${spec.label} ${resolvedModelId} ${glyphs.middot} ${where}`,
    // Seeded per session, so the sky is stable while you are looking at it.
    seed: Date.now() & 0xffff,
  };
  if (depth === "none") {
    out.write(`${renderBanner(bannerOptions)}\n`);
  } else {
    // The sky settles in rather than arriving lit — the wordmark itself never dims (see
    // `banner.ts`), so the one thing a person needs to read first is legible from the very first
    // frame, and only the stars around it are what spring up to full brightness.
    //
    // Safe where the dropdown's row animation was not, and for a reason worth stating: every frame
    // here occupies the *same* rows. `renderBanner` returns a fixed number of lines whose widths do
    // not depend on `intensity` — it changes colour, never geometry — so the redraw erases exactly
    // the rows it reprints and nothing scrolls. Animating a fixed frame is repainting; animating a
    // frame's size is scrolling, and only one of those is reversible.
    const bannerBlock = new ReplaceableBlock(out);
    for (const line of renderBanner({ ...bannerOptions, intensity: 0 }).split("\n")) bannerBlock.append(line);
    await new Promise<void>((resolve) => {
      const animator: SpringAnimator = new SpringAnimator(0, (value) => {
        bannerBlock.updateAll(renderBanner({ ...bannerOptions, intensity: value }).split("\n"));
        if (animator.settled) resolve();
      }, { intervalMs: 50 });
      animator.retarget(1);
    });
    bannerBlock.forget(); // committed to scrollback; nothing may rewrite it again
  }
  // `/guide` sits on the opening line beside `/help`, because the two answer different questions —
  // one lists what you can type, the other explains what any of it is for — and a manual nobody is
  // told about is a manual nobody reads.
  out.write(`${renderTagline(`  /help ${controlLabel(language, "help")} ${glyphs.middot} /guide ${controlLabel(language, "guide")} ${glyphs.middot} /exit ${controlLabel(language, "exit")} ${glyphs.middot} # ${controlLabel(language, "remember")}`, depth)}\n`);
  out.write(style.dim(`  costs: ${display}${preference.countryCode ? ` ${glyphs.middot} location ${preference.countryCode}` : ""} ${glyphs.middot} ${preference.source === "location" ? "auto-detected" : preference.source}\n`));
  if (localCurrencyWarning) out.write(`${style.yellow(`  ${localCurrencyWarning}`)}\n`);
  if (!args.budget) {
    out.write(`${style.yellow(`  No session spend cap set ${glyphs.middot} use --budget N to approve and enforce one.`)}\n`);
    // Named beside the cap it is not: someone reading that line is thinking about spending, and
    // this is the other half of the answer.
    if (pace === "off") out.write(style.dim(`  ${glyphs.middot} /slow paces spending without capping it\n`));
  }
  if (pace !== "off") out.write(style.dim(`  ${paceBadge(pace, glyphs)} ${glyphs.middot} fewer model rounds per turn; /slow off to lift it\n`));
  if (memories.length > 0) out.write(style.dim(`  ${glyphs.middot} ${memories.length} remembered fact${memories.length === 1 ? "" : "s"} in play ${glyphs.middot} /memory to see them\n`));
  if (!prices) {
    out.write(`${style.yellow(`  No price configured for ${resolvedModelId} ${glyphs.middot} costs will show as unknown.`)}\n`);
    out.write(`${style.dim(`  Set ${PRICE_ENVIRONMENT_HINT}, or run nova --providers.`)}\n`);
  }
  // An empty prompt under a banner says the tool is ready without saying what it is ready for.
  // Only for a session someone is about to type into: a `--prompt` run already knows what it wants,
  // and a pipe has nobody to read them.
  if (interactive && !args.prompt) {
    const starters = renderStarters(navContext(), sectionStyle(), path.basename(args.root));
    if (starters) out.write(`\n${starters}\n`);
    // Under the starters, because "what could I ask" comes before "how do I take it back" — but
    // only just: the second question is the one that makes the first safe to answer.
    const essentials = renderEssentials(navContext(), sectionStyle());
    if (essentials) out.write(`${essentials}\n`);
  }

  /**
   * The footer goes up after the banner, not before — the banner is the top of the transcript, not
   * chrome that belongs pinned. Only for a real interactive TTY: a one-shot `--prompt` run, a pipe,
   * or `--estimate` prints a few lines and exits, where a scroll region would be pure overhead with
   * nothing to keep separately scrolled from before it is torn down again a moment later.
   */
  // `NOVA_PIN` exists so the choice can live in a shell profile rather than in every invocation.
  const pinFooter = args.pin || (environment.NOVA_PIN ?? "") !== "" && environment.NOVA_PIN !== "0";
  if (ttyMode) {
    // Always constructed, because the suggestion dropdown needs its geometry either way; only the
    // *holding* of the scroll region — the part that costs scrollback — is what `--pin` buys.
    screen = new PinnedScreen(process.stdout, { holdRegion: pinFooter });
    screen.enter();
    showIdleStatus();
    process.stdout.on("resize", () => {
      screen?.resize();
      showIdleStatus();
    });

    /**
     * True navigation for the dropdown: borrows the keyboard exactly the way the full palette and
     * model picker already do (`withBorrowedKeyboard`), so Up/Down move a real highlighted
     * selection instead of falling through to readline's own history navigation — which is what
     * used to happen, since two independent listeners both saw the same keystroke with no way for
     * one to tell the other "I've got this one".
     *
     * Deliberately does not accept typed characters while browsing (`filter: false`): the line
     * itself is never touched here, so there is nothing to reconcile afterward. Escape, or any key
     * that is not a navigation key, ends browsing with `rl.line` exactly as the user left it —
     * pressing a letter to keep narrowing "exits browse mode and that key still lands", not "gets
     * eaten". Accepting a row submits it through the *pending* `question()` via `rl.write`, the
     * same public API a real Enter keypress would drive — nothing here reaches into readline's
     * private state.
     */
    const browseSuggestions = async (line: string, suggestions: readonly { command: string; args?: string; description: string }[]): Promise<void> => {
      if (!screen) return;
      // A model-argument suggestion's own `command` is the bare model id ("claude-sonnet-5"), not
      // a runnable line — reattach whatever prefix was actually typed ("/model ") so accepting one
      // submits the full command, not the id alone read as a chat message.
      const modelPrefix = /^\/models?\s+/.exec(line)?.[0];
      const items: ChooserItem<string>[] = suggestions.map((entry) => ({
        value: modelPrefix ? `${modelPrefix}${entry.command}` : entry.command,
        label: entry.args ? `${entry.command} ${entry.args}` : entry.command,
        description: entry.description,
      }));
      const host = { readline, input: process.stdin, output: process.stdout };
      const chosen = inlineBar()
        ? await browseDropup(host, items.map((item) => item.value), suggestions)
        : await withBorrowedKeyboard(host, undefined, (keys, paint) => runChooser(keys, items, paint, {
          width: process.stdout.columns ?? 80,
          height: items.length,
          filter: false,
          paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow },
          glyphs,
        }), { paint: (frame: string) => screen?.renderSuggestions(frame.split("\n")), erase: () => screen?.clearSuggestions() });
      if (!chosen) return;
      // The accepted row is a *whole* line, not a completion of the partial one: it already carries
      // its leading "/" and, for a model argument, the "/model " prefix that was typed. Writing it
      // onto a line that still holds "/a" submits "/a/auto" — the reported "//auto" is just this
      // with a one-character prefix. `replaceLine` is the same line-clearing a bound shortcut does
      // before submitting, and it is shared rather than repeated so both agree about the cursor.
      replaceLine(rl, chosen);
      rl.write("\n");
    };

    /**
     * Arrow-key selection inside the dropup the user is already looking at.
     *
     * Deliberately not `runChooser`. The chooser renders best-match-first top-down, which is right
     * for a menu that opens downward and wrong here: the dropup deliberately puts its best match on
     * the *bottom* row, against the prompt. Handing the chooser these rows would flip the list the
     * moment an arrow key was pressed, so the row under the user's eye when they reached for Up is
     * not the row that ends up selected. Repainting through `showDropup` instead means browsing and
     * reading are the same list, in the same order, with a cursor added.
     *
     * The direction mapping follows from that reversal and is not a bug: Up moves *up the screen*,
     * which is away from the prompt and therefore toward later entries in rank order.
     */
    const browseDropup = async (
      host: { readline: typeof readline; input: NodeJS.ReadStream; output: NodeJS.WriteStream },
      values: readonly string[],
      suggestions: readonly { command: string; args?: string; description: string }[],
    ): Promise<string | undefined> => withBorrowedKeyboard(host, undefined, async (keyStream) => {
      let selected = 0;
      showDropup(suggestions, selected);
      for await (const { key } of keyStream) {
        const name = key.name;
        if (name === "escape" || (key.ctrl && name === "c")) return undefined;
        if (name === "return" || name === "enter" || name === "tab") return values[selected];
        if (name === "up") selected = Math.min(values.length - 1, selected + 1);
        else if (name === "down") selected = Math.max(0, selected - 1);
        // Any other key ends browsing without eating the keystroke's meaning: the user has gone back
        // to typing, and the list becomes something they are reading again rather than driving.
        else return undefined;
        showDropup(suggestions, selected);
      }
      return undefined;
    }, { paint: () => undefined, erase: () => clearDropup() });
    let browsing = false;

    /**
     * Hands a set of rows to the prompt box and repairs whatever moving the bar disturbed.
     *
     * The repair sequence is the fiddly part, and its order is forced rather than chosen. When the
     * row count changes the box erases its whole block — the input row included — so:
     *
     * 1. `readline.prompt(true)` redraws the prompt prefix and the typed line, restoring the row the
     *    user is actually editing. It must come first, because readline's own refresh ends with an
     *    `ED 0` that would wipe anything already drawn below the input row.
     * 2. Only then is the closing border redrawn, into the row that `ED 0` just cleared.
     *
     * Doing these the other way round draws a border and immediately erases it, which reads as the
     * bar losing its bottom edge at random — the exact symptom `dropBorder` was written for, arriving
     * from a second direction.
     */
    const applyDropup = (lines: readonly string[]): void => {
      const status = idleStatusLine();
      const { moved } = promptBox.setSuggestions(lines, { mode, workspace: where, status });
      if (!moved) return;
      readline.prompt(true);
      promptBox.restoreBottomBorder(mode, where, status);
    };

    const clearDropup = (): void => { if (promptBox.suggestionRows > 0) applyDropup([]); };

    const showDropup = (suggestions: readonly { command: string; args?: string; description: string }[], selected?: number): void => {
      const columns = process.stdout.columns ?? 80;
      const entries: DropupEntry[] = suggestions.map((entry) => ({
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        description: entry.description,
        ...(chordFor.get(entry.command) ? { chord: chordFor.get(entry.command)! } : {}),
      }));
      applyDropup(renderDropup(entries, {
        width: columns,
        maxRows: dropupRowBudget(process.stdout.rows ?? 24, entries.length),
        ...(selected === undefined ? {} : { selected }),
        glyphs,
        paint: { dim: style.dim, cyan: style.cyan, green: style.green },
      }));
    };

    /**
     * The suggestion dropdown, repainted from whatever is on the line.
     *
     * Driven off keypresses rather than off a wrapper around input, because readline owns the line
     * and this must not: the buffer is read after each key and never written to. `setImmediate`
     * defers to readline's own handler, which is registered first — reading `line` synchronously
     * would see the state from before the keystroke and leave the list one character stale.
     */
    /**
     * Whether the inline dropup can safely draw right now.
     *
     * The list is painted with cursor motions measured *from the input row*, so it is correct only
     * while the cursor is actually on that row. A line long enough to wrap has pushed the cursor
     * down onto the closing border, and every upward count would then land one row short and
     * overwrite the bar instead of the list. Suggestions only ever appear for a single `/word`, so
     * this refuses in a case that essentially cannot arise — on a terminal narrow enough to wrap a
     * command name, the honest answer is no list rather than a corrupted bar.
     */
    const dropupSafe = (line: string): boolean =>
      promptBox.isDrawn && PROMPT_PREFIX_COLUMNS + visibleWidth(line) < (process.stdout.columns ?? 80);

    /** The chord label to show beside a suggested command, so the list teaches its own shortcuts. */
    const chordFor = keys.shortcutLabels();

    /**
     * The suggestion list, repainted from whatever is on the line.
     *
     * Driven off keypresses rather than off a wrapper around input, because readline owns the line
     * and this must not: the buffer is read after each key and never written to. `setImmediate`
     * defers to readline's own handler, which is registered first — reading `line` synchronously
     * would see the state from before the keystroke and leave the list one character stale.
     *
     * Two renderers, one per bar. A pinned footer has reserved rows and `PinnedScreen` addresses
     * them absolutely, which is correct *because* the region holds the bar on a known row. The
     * inline bar has no such row, so it uses the dropup, which measures upward from the cursor and
     * therefore finds the bar wherever the transcript has left it. That relative measurement is the
     * whole fix: the old code simply declined to draw anything inline, which is why the default
     * session — nearly every session, since pinning costs scrollback — had ghost text and no list.
     */
    const paintSuggestions = (_str: string | undefined, key: { name?: string } | undefined) => setImmediate(() => {
      if (turnActive || browsing) return;
      const line = (readline as { line?: string }).line ?? "";
      const suggestions = suggestionsFor(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));

      if (inlineBar()) {
        if (suggestions.length === 0 || !dropupSafe(line)) { clearDropup(); return; }
        if (key?.name === "up" || key?.name === "down") {
          browsing = true;
          browseSuggestions(line, suggestions).catch(() => undefined).finally(() => { browsing = false; });
          return;
        }
        showDropup(suggestions);
        return;
      }

      if (suggestions.length === 0) { screen?.clearSuggestions(); return; }
      if (key?.name === "up" || key?.name === "down") {
        browsing = true;
        // Errors here must not become an unhandled rejection that takes the process down mid-turn
        // over what is, worst case, a dropdown that failed to open — the keyboard would already
        // have been restored by `withBorrowedKeyboard`'s own `finally`, so falling back to the
        // ordinary passive dropdown next keystroke is a full recovery, not a degraded state.
        browseSuggestions(line, suggestions).catch(() => undefined).finally(() => { browsing = false; });
        return;
      }
      const width = Math.max(...suggestions.map((entry) => entry.command.length + (entry.args ? entry.args.length + 1 : 0)));
      screen?.renderSuggestions(suggestions.map((entry) => {
        const head = entry.args ? `${entry.command} ${entry.args}` : entry.command;
        return `  ${style.cyan(head.padEnd(width + 2))}${style.dim(entry.description)}`;
      }));
    });
    /**
     * The greyed-out rest of the command, painted after the cursor as you type.
     *
     * What replaces the dropdown for the inline bar. It writes *after* the cursor and puts the
     * cursor straight back, so readline's idea of where it is never changes and the row count never
     * changes either — the two things that made the reserved-row dropdown unsafe here.
     *
     * Erasing to end of line first is what keeps a shrinking suggestion from leaving its own tail
     * behind (`/mode` back to `/mod` would otherwise strand the old `l`). Anything still on screen
     * at submit is wiped by `promptBox.erase`, which already clears these rows whole.
     */
    const paintGhost = () => setImmediate(() => {
      if (turnActive || browsing || !promptBox.isDrawn) return;
      const line = (readline as { line?: string }).line ?? "";
      const cursor = (readline as { cursor?: number }).cursor ?? line.length;
      // Only at the end of the line: a completion offered from the middle would be describing text
      // the cursor is not actually about to extend.
      if (cursor !== line.length) { out.write("\x1b7\x1b[K\x1b8"); return; }
      const { suffix, alternatives } = inlineCompletion(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));
      const hint = suffix === "" ? "" : `${style.dim(suffix)}${alternatives > 0 ? style.dim(`  +${alternatives}`) : ""}`;
      out.write(`\x1b7\x1b[K${hint}\x1b8`);
    });

    /** Right arrow at the end of the line takes the offer, the way fish and every browser bar do. */
    const acceptGhost = (_str: string | undefined, key: { name?: string; ctrl?: boolean; meta?: boolean } | undefined) => {
      if (!key || key.name !== "right" || key.ctrl || key.meta) return;
      if (turnActive || browsing || !promptBox.isDrawn) return;
      const line = (readline as { line?: string }).line ?? "";
      const cursor = (readline as { cursor?: number }).cursor ?? 0;
      if (cursor !== line.length) return; // mid-line, the arrow means "move right"
      const { suffix } = inlineCompletion(line, buildModelCatalog(environment, undefined, liveModels).choices.map((choice) => choice.model));
      if (suffix !== "") readline.write(suffix);
    };

    process.stdin.on("keypress", paintSuggestions);
    process.stdin.on("keypress", paintGhost);
    process.stdin.on("keypress", acceptGhost);
  }

  /**
   * Re-reads the display currency from settings, and makes the session actually use it.
   *
   * Setting your location is only worth doing if the next number you read is in your money. The
   * preference is resolved once at startup, so without this a location saved in `/settings` would
   * be correct in the file, correct on the next launch, and invisible for the rest of the session
   * the user changed it in — which reads as the setting not working.
   *
   * A command-line `--currency` still wins: it is this run's explicit instruction, and a saved
   * preference should not quietly override what was typed to start the process.
   */
  const applyCurrencyPreference = async (): Promise<void> => {
    const next = resolveCurrencyPreference({ currency: args.currency, country: args.country, environment, providerCurrency: prices?.currency ?? "USD" });
    if (next.currency === display) return;

    if (prices && next.currency !== prices.currency) {
      const convertible = () => rates.some((rate) => (rate.from === prices!.currency && rate.to === next.currency) || (rate.to === prices!.currency && rate.from === next.currency));
      if (!convertible() && environment.NOVA_FX_OFFLINE !== "true") {
        const daily = await fetchDailyFxRate(prices.currency, next.currency);
        if (daily) rates.push(daily);
      }
      // Refusing to switch beats switching to a currency every future cost then fails to convert
      // into — the session would keep working while reporting nothing.
      if (!convertible()) {
        out.write(style.yellow(`  No ${prices.currency}→${next.currency} rate is available, so costs stay in ${display}.\n`));
        return;
      }
    }
    display = next.currency;
    ledger.setDisplay(display, rates);
    for (const tab of tabs.all) tab.payload.ledger.setDisplay(display, rates);
    out.write(style.dim(`  costs now shown in ${display}${next.countryCode ? ` · location ${next.countryCode}` : ""}\n`));
  };

  /**
   * The settings menu, and everything that has to happen once it closes.
   *
   * A function rather than an inline block because `/settings` is no longer the only way in: the
   * model picker's "add a key" row opens the same flow, and a second copy would be a second place
   * for "reload the environment and rebuild the client" to be got wrong.
   */
  const openSettings = async (): Promise<"saved" | "cancelled" | "exit"> => {
    let nextSettings: NovaSettings;
    try {
      nextSettings = await runSettingsMenu(savedSettings, {
        ask: (question) => readline.question(question),
        askSecret: (question) => hiddenQuestion(readline, question),
        write: (text) => out.write(text),
        ...(interactive ? { choose: settingsChooser(readline) } : {}),
      }, {
        // Prices in the currency this session is already reporting in, rather than the provider's.
        modelChoices: (field, current) => modelChoicesForSettingsField(field, current, processEnvironment, display, rates),
      });
    } catch (error) {
      if (!isReadlineExit(error)) throw error;
      out.write(style.dim("\n  settings cancelled — no changes were saved\n"));
      return exitRequested ? "exit" : "cancelled";
    }
    savedSettings = nextSettings;
    const file = await saveSettings(savedSettings, processEnvironment);
    for (const field of SETTING_FIELDS) delete environment[field.key];
    Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
    language = resolveControlLanguage(args.language ?? environment.NOVA_LANGUAGE ?? environment.LANG);
    const previous = agent;
    const carried = await loadSession(args.root, previous.sessionId);
    await previous.relinquish();
    agent = await openClient(carried ?? undefined);
    out.write(style.green(`  settings saved to ${file}\n`));
    await applyCurrencyPreference();
    out.write(style.dim(`  Settings are active now${environment.EXA_API_KEY?.trim() ? "; Exa web_search is available" : ""}. Use /model only to change the selected model.\n`));
    return "saved";
  };

  /**
   * Work a screen decided on, waiting for the terminal to be free.
   *
   * A full-screen surface cannot start a model turn under itself — the turn would print into a
   * frame that is about to be erased, and there would be nothing to interrupt it with. So the
   * triage screen returns decisions, they land here, and the loop picks them up exactly as though
   * they had been typed. Drained before the prompt is drawn, so the queued objective is the next
   * thing that runs rather than the thing after whatever the user types next.
   */
  const queuedInput: string[] = [];

  for (;;) {
    showIdleStatus();
    screen?.positionInput();
    let rawInput: string;
    const queued = queuedInput.shift();
    if (queued !== undefined) {
      // Echoed, because work that starts without anyone typing it must still be visible as a
      // request in the transcript — otherwise the next answer has no question above it.
      out.write(`${renderUserTurn(queued)}\n`);
    }
    try {
      // With a pinned footer the prompt is the input bar's left border, so readline redraws it as
      // part of the prompt and the box keeps its side through every edit. Without one there is no
      // box to have a side of, and the old inline label is still the right thing — with the leading
      // blank line it has always had on a session with no screen of any kind to separate it from.
      const label = `${style.cyan(mode === "plan" ? "plan" : mode === "auto" ? "auto" : mode === "defender" ? "defender" : "nova")}${style.dim(` ${glyphs.caret} `)}`;
      const promptLabel = screen?.pinned
        ? promptFrame(idleStatusLine()).prefix
        : inlineBar()
          ? promptBox.draw(mode, where, idleStatusLine())
          : screen ? label : `\n${label}`;
      rawInput = queued ?? await readline.question(promptLabel);
    } catch (error) {
      if (isReadlineExit(error) || exitRequested) break;
      throw error;
    }
    // Erased before anything else prints, and with the submitted line in hand so the count covers
    // however many rows it wrapped onto. Leaves the cursor exactly where the top border was, which
    // is where the "you" bubble for this message is about to go.
    promptBox.erase(rawInput);
    // Before parking, so the transcript region is whole again before anything is written into it.
    screen?.clearSuggestions();
    screen?.parkInTranscript();
    let input = rawInput.trim();
    if (!input) continue;

    usage.record(input);

    // The palette resolves to a command and then falls through to the same dispatch a typed one
    // takes. Anything else would be a second place for a command's behaviour to live.
    if (input === "/palette") {
      const chosen = interactive
        ? await openPalette({ readline, input: process.stdin, output: process.stdout, registry: keys }, undefined, {
            // Ranked against this session: the empty-query view is otherwise the catalog in
            // alphabetical order, which is the least useful thing a palette can open on.
            rank: (entries, query) => rankWithContext(entries, query, navContext()),
          })
        : undefined;
      if (!chosen?.trim()) continue;
      input = chosen.trim();
    }

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help" || input === "/help all") {
      // Grouped and filtered to what this session can actually use, with everything one keystroke
      // away. The flag reference stays on `nova --help`, where someone reading about invocation is
      // looking; inside a session it is thirty lines about starting a session you are already in.
      out.write(`${renderGroupedHelp(navContext(), sectionStyle(), { all: input.endsWith(" all") })}\n`);
      continue;
    }
    const modeCommand = parseModeCommand(input);
    if (modeCommand?.type === "show") {
      const posture = mode === "plan" ? "read-only; write and command tools are unavailable" : mode === "build" ? "workspace changes ask for approval" : mode === "defender" ? "security review; every change still asks for approval" : "ordinary workspace changes are pre-approved; sensitive and external actions still ask";
      out.write(`  ${style.cyan(mode)} · ${style.dim(posture)}\n`);
      continue;
    }
    if (modeCommand?.type === "invalid") {
      out.write(style.yellow("  Choose /mode plan, /mode build, /mode auto, or /mode defender.\n"));
      continue;
    }
    if (modeCommand?.type === "switch") {
      const requestedMode: NovaMode = modeCommand.mode;
      if (requestedMode === mode) {
        out.write(style.dim(`  already in ${mode} mode\n`));
        continue;
      }
      mode = requestedMode;
      // A new mode is a new permission posture; the transcript carries over so the plan the agent
      // just produced is still in context when it starts building — Cline's behaviour, and the
      // reason Plan mode is useful rather than a separate conversation.
      const previous = agent;
      // Read before relinquishing: the client's sessionId is only valid while it is still open.
      const previousSessionId = previous.sessionId;
      await previous.relinquish();
      const carried = await loadSession(args.root, previousSessionId);
      agent = await openClient(carried ?? undefined);
      const posture = mode === "plan" ? "read-only; no write tools" : mode === "build" ? "edits and commands require approval" : mode === "defender" ? "security review; every fix still requires approval" : "ordinary edits and commands are pre-approved; sensitive and external actions require approval";
      out.write(style.dim(`  switched to ${mode} mode · ${posture}\n`));
      continue;
    }
    const modelCommand = parseModelCommand(input);
    if (modelCommand) {
      // Refreshed on demand: `/models refresh` is the answer to "a model shipped and it is not
      // here", and it is the only path that waits on the network.
      // The list is wanted now, so this is the moment to pay for it: on demand, and only when the
      // cache has nothing fresh to offer or the user asked for a refresh outright.
      const wantsRefresh = /\brefresh\b/.test(input);
      if (wantsRefresh || Object.keys(liveModels).length === 0) {
        if (wantsRefresh) out.write(style.dim("  asking every provider what it has…\n"));
        const { errors } = await refreshLiveModels(wantsRefresh ? { refresh: true } : {});
        for (const error of errors) out.write(style.yellow(`  ${error}\n`));
      }
      const catalog = buildModelCatalog(environment, undefined, liveModels);
      const paint = surfacePaint;
      const price = (choice: ModelChoice) => describePrice(choice.prices, display, (money) => convertTo(money, display, rates));
      /**
       * One side of a model's price, as a bare figure for a column of its own.
       *
       * `price` above renders both sides as a phrase, which is right for a menu row and useless in a
       * table: a column has to hold one number, and it has to hold it unpainted or the sort reads a
       * colour code instead of a value.
       */
      const modelRate = (choice: ModelChoice, side: "input" | "output"): string => {
        if (!choice.prices) return "";
        const micros = side === "input" ? choice.prices.inputPerMillion : choice.prices.outputPerMillion;
        const own = { currency: choice.prices.currency, micros };
        // Falls back to the provider's own currency when no rate is configured, which is what
        // `describePrice` does — a converted figure nobody can reconcile is worse than a foreign one.
        return formatMoney(convertTo(own, display, rates) ?? own);
      };

      let picked: ModelChoice | undefined;
      if (modelCommand.kind === "list") {
        // Nothing configured is not a list to show — it is one thing to do. Printing "run
        // /settings" here would be telling someone the name of the door they are standing at.
        if (catalog.choices.length === 0) {
          out.write(style.yellow("  No provider is configured yet — opening settings.\n"));
          if (await openSettings() === "exit") break;
          continue;
        }
        const modelTable = () => buildModelTable(catalog, {
          current: { provider: spec.id, model: resolvedModelId },
          rate: modelRate,
          paint,
          glyphs,
        });
        // A pipe or a non-TTY has no cursor to move, so it prints instead of opening a surface — as
        // a table now rather than a sentence per row, because the columns are worth as much to
        // something reading the output as to someone looking at it.
        if (!interactive) {
          const printed = modelTable();
          out.write(`${renderTable(printed.columns, printed.rows, INITIAL_TABLE_STATE, {
            paint: surfacePaint, width: contentWidth(), glyphs, legend: "", cursor: false,
          })}\n`);
          // The things the grid has no row for: a provider with no key, and how to choose.
          for (const note of printed.notes ?? []) out.write(`  ${note}\n`);
          continue;
        }
        // Two views of one list, each able to hand over to the other: the menu answers "what can I
        // switch to", the table answers "which of these is cheapest". Escape from the table comes
        // back here rather than closing `/models` outright, which is what a view toggle implies.
        let chosen: PickerResult | undefined;
        for (;;) {
          chosen = await openModelPicker({ readline, input: process.stdin, output: process.stdout }, {
            rows: buildPickerRows(catalog),
            current: { provider: spec.id, model: resolvedModelId },
            price,
            paint,
            glyphs,
          });
          if (chosen?.kind !== "table") break;
          const browsed = modelTable();
          const row = await openTable({ readline, input: process.stdin, output: process.stdout }, {
            columns: browsed.columns,
            rows: browsed.rows,
            paint: surfacePaint,
            glyphs,
            title: "models · by any column you like",
            height: 12,
            // Opens on the model in use, like the menu it came from: a view toggle that also moved
            // the cursor would make `t` feel like it had lost your place.
            initialIndex: Math.max(0, catalog.choices.findIndex((choice) => choice.provider === spec.id && choice.model === resolvedModelId)),
          });
          // `runTable` hands back the row itself, and `sortRows` preserves references, so the model
          // it stands for is found by identity — no un-sorting an index to get back to the datum.
          const fromTable = row ? catalog.choices[browsed.rows.indexOf(row)] : undefined;
          if (fromTable) { chosen = { kind: "model", choice: fromTable }; break; }
        }
        if (!chosen) { out.write(style.dim("  no change\n")); continue; }
        if (chosen.kind === "settings") {
          if (await openSettings() === "exit") break;
          continue;
        }
        picked = chosen.choice;
      }

      let providerArg: string | undefined;
      let modelArg: string | undefined;
      if (picked) {
        providerArg = picked.provider;
        modelArg = picked.model;
      } else if (modelCommand.kind === "pick") {
        const chosen = catalog.choices[modelCommand.index - 1];
        if (!chosen) {
          out.write(style.yellow(`  There is no model ${modelCommand.index}. Run /models to see the list.\n`));
          continue;
        }
        providerArg = chosen.provider;
        modelArg = chosen.model;
      } else if (modelCommand.kind === "query") {
        const found = matchModelQuery(catalog, modelCommand.text);
        if (found.kind === "none") {
          out.write(style.yellow(`  No configured model matches "${modelCommand.text}". Run /models to see the list.\n`));
          continue;
        }
        if (found.kind === "ambiguous") {
          // Naming the candidates makes the retry a copy rather than another guess.
          out.write(style.yellow(`  "${modelCommand.text}" matches ${found.candidates.length} models: ${found.candidates.map((choice) => choice.model).join(", ")}.\n`));
          continue;
        }
        providerArg = found.choice.provider;
        modelArg = found.choice.model;
      } else if (modelCommand.kind === "explicit") {
        ({ provider: providerArg, model: modelArg } = modelCommand);
      }

      const attempt = resolveProvider(environment, { provider: providerArg, model: modelArg });
      if ("error" in attempt) {
        out.write(`${style.red(attempt.error)}\n`);
        continue;
      }
      if (attempt.spec.id === spec.id && attempt.model === resolvedModelId) {
        out.write(style.dim(`  already on ${spec.label} ${resolvedModelId}\n`));
        continue;
      }
      model = attempt.provider;
      spec = attempt.spec;
      prices = attempt.prices;
      resolvedModelId = attempt.model;
      ledger.setPrices(prices);
      const previous = agent;
      const previousSessionId = previous.sessionId;
      await previous.relinquish();
      const carried = await loadSession(args.root, previousSessionId);
      agent = await openClient(carried ?? undefined);
      const priceNote = prices ? "" : " — no price configured, costs will show as unknown";

      // Persisted, because a switch the user had to make again on every launch is a switch they
      // never really made. Both halves are written: the model alone would be re-read under whatever
      // provider happened to sort first, which is how you ask for one model and get another.
      const modelKey = `${spec.id.toUpperCase()}_MODEL` as SettingKey;
      savedSettings = { ...savedSettings, NOVA_PROVIDER: spec.id, [modelKey]: resolvedModelId };
      let persistence = "";
      try {
        await saveSettings(savedSettings, processEnvironment);
        // A real environment variable outranks the file by design (mergedEnvironment), so saving
        // succeeds while changing nothing about the next launch. Saying so beats a silent no-op.
        const shadowed = [modelKey, "NOVA_PROVIDER"].filter((key) => processEnvironment[key]?.trim());
        persistence = shadowed.length > 0
          ? ` · saved, but ${shadowed.join(" and ")} in your environment will override it next launch`
          : " · saved as your default";
        Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
      } catch {
        // The switch itself already happened and is valid for this session; only the memory failed.
        persistence = " · could not save it as your default";
      }
      out.write(style.dim(`  switched to ${spec.label} ${resolvedModelId}${priceNote}${persistence}\n`));
      continue;
    }
    const expandCommand = parseExpandCommand(input);
    if (expandCommand) {
      if (expandCommand.kind === "invalid") { out.write(style.yellow(`  ${expandCommand.reason}\n`)); continue; }
      if (expandCommand.kind === "list") { out.write(`${renderExpandableList(expandables.all, depth, glyphs)}\n`); continue; }
      const chosen = expandCommand.kind === "one"
        ? [expandables.get(expandCommand.id)]
        : expandCommand.kind === "all" ? [...expandables.all] : [expandables.last];
      const found = chosen.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
      if (found.length === 0) {
        out.write(style.dim(`  nothing to expand${expandCommand.kind === "one" ? ` as ${expandCommand.id}` : ""} — /expand list shows what is folded\n`));
        continue;
      }
      for (const entry of found) {
        out.write(`${rule(sectionStyle(), { label: entry.label, tone: "accent" })}\n`);
        out.write(`${entry.full}\n`);
      }
      continue;
    }

    const memoryCommand = parseMemoryCommand(input);
    if (memoryCommand) {
      const style_ = sectionStyle();
      const files = { project: memoryFile("project", args.root, environment), user: memoryFile("user", args.root, environment) };
      switch (memoryCommand.kind) {
        case "invalid":
          out.write(style.yellow(`  ${memoryCommand.reason}\n`));
          break;
        case "where":
          out.write(`${note(`project ${glyphs.middot} ${files.project}`, style_)}\n${note(`you     ${glyphs.middot} ${files.user}`, style_)}\n`);
          break;
        case "list":
          out.write(`${renderMemories(memories, style_, files)}\n`);
          break;
        case "add": {
          try {
            const result = await addMemory(memoryCommand.scope, memoryCommand.text, args.root, environment, { kind: memoryCommand.memoryKind, pinned: memoryCommand.pinned });
            memories = await loadMemories(args.root, environment);
            recalledMemoryKeys.clear();
            out.write(result.changed
              ? `${describeAdded({ scope: memoryCommand.scope, text: memoryCommand.text }, style_)}\n`
              : style.dim("  already remembered\n"));
          } catch (error) {
            out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
          }
          break;
        }
        case "replace": {
          try {
            await replaceMemory(memoryCommand.scope, memoryCommand.oldText, memoryCommand.newText, args.root, environment);
            memories = await loadMemories(args.root, environment);
            recalledMemoryKeys.clear();
            out.write(style.green(`  memory updated: ${memoryCommand.newText}\n`));
          } catch (error) {
            out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
          }
          break;
        }
        case "recall": {
          const recalled = recallMemories(memories, memoryCommand.query);
          out.write(recalled.entries.length
            ? `${memoryPromptBlock(recalled.entries)}${style.dim(`  ${recalled.usedChars} chars recalled${recalled.omitted ? ` ${glyphs.middot} ${recalled.omitted} omitted by budget` : ""}\n`)}`
            : style.dim(`  no memory matched “${memoryCommand.query}”\n`));
          break;
        }
        case "forget": {
          const result = await forgetMemory(memoryCommand.scope, memoryCommand.index, args.root, environment);
          memories = await loadMemories(args.root, environment);
          recalledMemoryKeys.clear();
          out.write(result.removed
            ? style.green(`  forgot: ${result.removed.text}\n`)
            : style.yellow(`  there is no ${memoryCommand.scope} memory ${memoryCommand.index} — /memory lists them\n`));
          break;
        }
        case "clear": {
          const answer = (await readline.question(`  ${style.yellow("?")} Forget every ${memoryCommand.scope} memory? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
          if (answer !== "y" && answer !== "yes") { out.write(style.dim("  kept\n")); break; }
          await clearMemories(memoryCommand.scope, args.root, environment);
          memories = await loadMemories(args.root, environment);
          recalledMemoryKeys.clear();
          out.write(style.dim(`  ${memoryCommand.scope} memory cleared\n`));
          break;
        }
      }
      continue;
    }

    const paceCommand = parsePaceCommand(input, pace);
    if (paceCommand) {
      if (paceCommand.kind === "invalid") { out.write(style.yellow(`  ${paceCommand.reason}\n`)); continue; }
      if (paceCommand.kind === "show") { out.write(`${describePace(pace, sectionStyle())}\n`); continue; }
      pace = paceCommand.level;
      // The pace lives in the agent's budgets, which are fixed when the client is built — so the
      // client is rebuilt around the same session, exactly as a mode or model switch does.
      const previous = agent;
      const previousSessionId = previous.sessionId;
      await previous.relinquish();
      const carried = await loadSession(args.root, previousSessionId);
      agent = await openClient(carried ?? undefined);
      out.write(`${describePace(pace, sectionStyle())}\n`);
      continue;
    }

    if (input === "/workspace" || input === "/panel") {
      /**
       * The control panel: every tab and every watched job, live, side by side.
       *
       * This is the one screen Nova draws rather than scrolls, and it is deliberately a *view* —
       * it reads the session and never mutates it, so leaving it puts you back exactly where you
       * were with nothing to undo.
       */
      // Lives for as long as the panel is open, which is the only span its samples mean anything
      // over: "lines since the last frame" is a rate only while the frames keep coming.
      const paneActivity = new PaneActivity();
      const readSnapshot = (): WorkspaceSnapshot => {
        const views = tabs.views(describeTab);
        const activeIndex = Math.max(0, views.findIndex((view) => view.active));
        const panes = [
            ...tabPanes(views, (id) => {
              const held = tabs.find(id);
              return { lines: held?.payload.sink.log.lines ?? [], dropped: held?.payload.sink.log.dropped ?? 0 };
            }),
            ...watched.all.map((job) => ({
              kind: "job" as const,
              key: job.stream.id,
              title: `job ${job.stream.id.slice(-6)}`,
              subtitle: job.objective,
              status: (job.stream.done ? "done" : "running") as "done" | "running",
              lines: job.sink.log.lines,
              dropped: job.sink.log.dropped,
            })),
        ];
        const activity = paneActivity.sample(panes);
        return {
          panes: panes.map((pane) => ({ ...pane, activity: activity.get(pane.key) })),
          selected: activeIndex,
          scroll: 0,
          palette,
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
        };
      };

      // The panel takes the terminal: raw mode, the alternate screen, and every keystroke. readline
      // and the pinned footer both have to let go first, or two things will be reading stdin and
      // one of them will be writing over the other.
      const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
        const { runWorkspace } = await import("./workspace-screen");
        await runWorkspace({ read: readSnapshot });
      });
      // No text path for the panel — several live panes is the thing a transcript cannot express —
      // so a refusal is said plainly rather than swallowed.
      if (!outcome.ok) out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`));
      continue;
    }

    const guideCommand = parseGuideCommand(input);
    if (guideCommand) {
      const style_ = sectionStyle();

      /**
       * Opens the guide as a screen, and reports whether it happened.
       *
       * A `false` return is not an error — it means the printed guide below is the right answer for
       * this terminal, which is true for a pipe, a window too small to hold a page, and a build
       * where the framework was pruned. See `terminal_design_system.md` §10.
       */
      const openGuideScreen = async (startAt?: string): Promise<boolean> => {
        const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
          const { runGuideScreen } = await import("./guide-screen");
          await runGuideScreen({
            columns: process.stdout.columns ?? 80,
            rows: process.stdout.rows ?? 24,
            palette,
            ...(startAt ? { startAt } : {}),
          });
        });
        return outcome.ok;
      };

      if (guideCommand.kind === "index") {
        // A bare /guide is "show me the manual", which is a browsing job. The printed index stays
        // for pipes and for terminals that cannot draw a screen.
        if (await openGuideScreen()) continue;
        out.write(`${renderGuideIndex(style_)}\n`);
        continue;
      }
      if (guideCommand.kind === "all") {
        // Folded, because the whole guide is longer than a screen and printing it at someone is how
        // a manual becomes something they scroll past rather than read.
        const whole = renderWholeGuide(style_);
        const lines = whole.split("\n");
        out.write(`${lines.slice(0, FOLD_AFTER_LINES * 3).join("\n")}\n`);
        const hidden = Math.max(0, lines.length - FOLD_AFTER_LINES * 3);
        if (hidden > 0) {
          const id = expandables.add("guide", whole, hidden);
          out.write(`${GUTTER}${expandHint(id, hidden, renderDepth, glyphs)}\n`);
        }
        continue;
      }
      if (guideCommand.kind === "search") {
        const found = searchTopics(guideCommand.query);
        if (found.length === 0) { out.write(style.yellow(`  Nothing in the guide mentions "${guideCommand.query}".\n`)); continue; }
        out.write(`${heading(`guide ${glyphs.middot} "${guideCommand.query}"`, 2, style_)}\n`);
        for (const topic of found) out.write(`${GUTTER}${style.cyan(topic.id)}  ${style.dim(topic.summary)}\n`);
        continue;
      }
      if (guideCommand.kind === "unknown") {
        out.write(style.yellow(`  No guide topic called "${guideCommand.id}".\n`));
        out.write(style.dim("  /guide lists them · /guide search <text> finds one\n"));
        continue;
      }
      const topic = findTopic(guideCommand.id);
      // A named topic prints. Someone who typed `/guide tabs` asked for that page, and a page in
      // the transcript can be scrolled back to, copied and piped; a screen takes it away again.
      if (topic) out.write(`${renderGuideTopic(topic, style_)}\n`);
      continue;
    }

    if (input === "/files") {
      // The flat list already loaded for `@path` completion — opening the picker costs nothing
      // beyond what a session already pays for that, and the two now agree on exactly which files
      // are reachable.
      let picked: { path: string; intent: "mention" | "edit" } | undefined;
      const outcome = await withFullScreen(screenCapabilities(), terminalControls(), async () => {
        const { runFileScreen } = await import("./file-screen");
        picked = await runFileScreen({
          columns: process.stdout.columns ?? 80,
          rows: process.stdout.rows ?? 24,
          paths: projectFiles,
          palette,
          readFile: async (path) => {
            const result = await workspace.readFile(path, { limit: 200 });
            return { content: result.content, totalLines: result.totalLines, truncated: result.truncated };
          },
        });
      });
      if (!outcome.ok) { out.write(style.yellow(`  ${explainScreenRefusal(outcome)}\n`)); continue; }
      if (picked?.intent === "edit") { await editFile(picked.path); continue; }
      // Picking a file writes an `@path` mention into the line still being composed — the same
      // syntax typing `@` and tab-completing already produces, so the model sees one convention
      // for "this file", not two.
      if (picked) rl.write(`@${picked.path} `);
      continue;
    }

    if (input === "/edit" || input.startsWith("/edit ")) {
      const target = input.slice("/edit".length).trim();
      if (!target) { out.write(style.yellow("  Usage: /edit <path>, or press e on a file in /files.\n")); continue; }
      await editFile(target);
      continue;
    }

    const themeCommand = parseThemeCommand(input);
    if (themeCommand) {
      const style_ = sectionStyle();
      if (themeCommand.kind === "invalid") { out.write(style.yellow(`  ${themeCommand.reason}\n`)); continue; }
      if (themeCommand.kind === "where") {
        out.write(`${heading("themes", 2, style_)}\n`);
        for (const scope of ["project", "user"] as const) {
          out.write(`${note(`${scope}: ${themeDirectory(scope, args.root, environment)}`, style_)}\n`);
        }
        out.write(`${note("drop a .tss file in either — the same format TermUI themes use", style_)}\n`);
        continue;
      }
      if (themeCommand.kind === "list") {
        const available = await discoverThemes(args.root, environment);
        out.write(`${heading("themes", 2, style_)}\n`);
        for (const theme of available) {
          const marker = theme.name === themeName ? glyphs.circleFull : " ";
          const origin = theme.source === "builtin" ? "" : ` (${theme.source})`;
          out.write(`${GUTTER}${marker} ${style.cyan(theme.name)}${style.dim(origin)}${theme.description ? style.dim(` — ${theme.description}`) : ""}\n`);
        }
        out.write(`${note("/theme <name> to change it", style_)}\n`);
        continue;
      }
      if (themeCommand.kind === "show") {
        out.write(`${GUTTER}${style.cyan(themeName)}${activeTheme?.description ? style.dim(` — ${activeTheme.description}`) : ""}\n`);
        // A swatch of the roles, because the names mean nothing until they are seen next to
        // each other in the terminal that will actually be drawing them.
        out.write(`${GUTTER}${style.cyan("primary")}  ${style.accent("accent")}  ${style.green("success")}  ${style.yellow("warning")}  ${style.red("error")}  ${style.dim("muted")}\n`);
        continue;
      }
      const chosen = await findTheme(themeCommand.name, args.root, environment);
      if (!chosen) {
        out.write(style.yellow(`  No theme named "${themeCommand.name}". /theme list shows what there is.\n`));
        continue;
      }
      activeTheme = chosen;
      applyTheme(chosen);
      out.write(`${rule(sectionStyle(), { label: chosen.name, tone: "accent" })}\n`);
      out.write(`${GUTTER}${style.cyan("primary")}  ${style.accent("accent")}  ${style.green("success")}  ${style.yellow("warning")}  ${style.red("error")}  ${style.dim("muted")}\n`);
      continue;
    }

    const historyCommand = parseHistoryCommand(input);
    if (historyCommand) {
      const style_ = sectionStyle();
      let cachedEntries: HistoryEntry[] | undefined;
      const historyEntries = async (): Promise<HistoryEntry[]> => {
        if (cachedEntries) return cachedEntries;
        const indexed = await stateHistory.sessions(30);
        const listed = indexed
          ? indexed.map((session) => ({ id: session.sessionId, title: session.title, updatedAt: session.updatedAt ?? 0 }))
          : await listSessions(args.root, 30);
        cachedEntries = (await Promise.all(listed.map(async (summary) => {
          const record = await loadSession(args.root, summary.id);
          return record ? summarizeSession(record) : null;
        }))).filter((entry): entry is HistoryEntry => entry !== null);
        return cachedEntries;
      };
      switch (historyCommand.kind) {
        case "invalid":
          out.write(style.yellow(`  ${historyCommand.reason}\n`));
          break;
        case "list":
          {
            const entries = await historyEntries();
            out.write(`${renderHistoryList(entries, style_, { current: agent.sessionId })}\n`);
            const usage = renderHistoryUsage(entries, style_);
            if (usage) out.write(`${usage}\n`);
          }
          break;
        case "search": {
          const nativeHits = await stateHistory.search(historyCommand.query, 20);
          const found = nativeHits
            ? (await Promise.all(nativeHits.map(async (hit): Promise<HistoryEntry | null> => {
                const record = await loadSession(args.root, hit.sessionId);
                return record ? {
                  ...summarizeSession(record),
                  evidence: { source: hit.source, snippet: hit.snippet, why: hit.why },
                } : null;
              }))).filter((entry): entry is HistoryEntry => entry !== null)
            : searchHistory(await historyEntries(), historyCommand.query);
          out.write(`${heading(`"${historyCommand.query}" ${glyphs.middot} ${found.length} match${found.length === 1 ? "" : "es"}`, 2, style_)}\n`);
          out.write(`${renderHistoryList(found, style_, { current: agent.sessionId })}\n`);
          break;
        }
        case "status": {
          await stateHistory.refresh();
          const status = await stateHistory.status();
          out.write(`${heading("history engine", 2, style_)}\n`);
          if (status.mode === "fallback") {
            out.write(`${note("portable JSON history is active", style_)}\n`);
            out.write(`${note(status.reason ?? "native state engine unavailable", style_)}\n`);
          } else {
            out.write(`${note(`native SQLite + FTS5 ${status.indexed ? "is current" : "is ready"}`, style_)}\n`);
            if (status.report) {
              out.write(`${note(`${status.report.sessions} sessions ${glyphs.middot} ${status.report.documents} searchable documents ${glyphs.middot} ${status.report.failures.length} source failures`, style_)}\n`);
            }
          }
          break;
        }
        case "show": {
          const record = await loadSession(args.root, historyCommand.id);
          if (!record) { out.write(style.yellow(`  No session ${historyCommand.id}. /history lists them.\n`)); break; }
          out.write(`${renderReplay(record, style_, historyCommand.turns === undefined ? {} : { turns: historyCommand.turns })}\n`);
          break;
        }
        case "resume": {
          // Picked from a menu when no id was given: reading an id off a list and typing it back is
          // a transcription step a chooser removes, and the ids are deliberately not memorable.
          const entries = await historyEntries();
          let id = historyCommand.id === "latest" ? entries[0]?.id : historyCommand.id;
          if (!id && interactive && entries.length > 0) {
            id = await openChooser<string>(
              { readline, input: process.stdin, output: process.stdout },
              entries.map((entry) => ({
                value: entry.id,
                label: entry.title || entry.id,
                hint: relativeTime(entry.updatedAt),
                description: `${entry.turns} turn${entry.turns === 1 ? "" : "s"}`,
              })),
              { title: "Pick up a past conversation", filter: true, height: 12, glyphs, paint: { dim: style.dim, cyan: style.cyan, green: style.green, yellow: style.yellow } },
            );
          }
          if (!id) { out.write(style.dim("  no session chosen\n")); break; }
          const record = await loadSession(args.root, id);
          if (!record) { out.write(style.yellow(`  No session ${id}.\n`)); break; }
          await agent.relinquish();
          agent = await openClient(record);
          await carryResumedSpend(record);
          // A resumed thread has already been told what Nova remembers only if the memory set has
          // not changed since — which cannot be known, so it is told again on the next turn.
          recalledMemoryKeys.clear();
          expandables.clear();
          out.write(`${renderReplay(record, style_, { turns: 2 })}\n`);
          out.write(style.green(`  resumed ${record.id}\n`));
          break;
        }
      }
      continue;
    }

    if (input === "/todos") {
      const todos = agent.todos;
      if (todos.length === 0) { out.write(style.dim("  no plan yet\n")); writeHint(); continue; }
      const mark = { pending: glyphs.circleEmpty, in_progress: glyphs.circleHalf, done: glyphs.circleFull } as const;
      out.write(`${box(todos.map((todo) => `${mark[todo.status]} ${todo.text}`), { depth, title: "todos", glyphs })}\n`);
      continue;
    }
    if (input === "/diff" || input === "/diff stat") {
      // The stat is still one word away, because "how much changed" is a real question — it is
      // just not the one `/diff` was being asked.
      if (input === "/diff stat") {
        const stat = await agent.diffStat();
        if (stat) out.write(`${box(stat.split("\n"), { depth, title: "diff", glyphs })}\n`);
        else { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); }
        continue;
      }
      const patch = await agent.diffPatch();
      if (!patch.trim()) { out.write(style.dim("  nothing changed since the last checkpoint\n")); writeHint(); continue; }
      const rendered = renderPatch(patch, sectionStyle(), { maxLinesPerFile: FOLD_AFTER_LINES * 2 });
      out.write(`${rendered.text}\n`);
      // The whole patch stays addressable: a folded file is the common case on a real change, and
      // the alternative — printing four hundred lines at someone — is why people stop typing /diff.
      const hiddenLines = patch.split("\n").length;
      const id = expandables.add("diff", renderPatch(patch, sectionStyle()).text, hiddenLines);
      out.write(`${GUTTER}${expandHint(id, hiddenLines, renderDepth, glyphs)}\n`);
      continue;
    }
    const tabCommand = parseTabCommand(input);
    if (tabCommand) {
      try {
        switch (tabCommand.kind) {
          case "invalid":
            out.write(style.yellow(`  ${tabCommand.reason}\n`));
            break;
          case "list":
            showTabs();
            // The strip says what each tab *is*; neither it nor the titles say what a tab that is
            // not in front is doing, which is the thing people get wrong. Listing tabs is someone
            // asking exactly that question, so it is answered here.
            out.write(style.dim(tabs.size === 1
              ? "  one tab — /tab new opens another; only the tab in front runs\n"
              : `  ${SEQUENTIAL_TABS_NOTE}\n`));
            break;
          case "new": {
            // Resolved before anything is opened, so a typo in --model or an unreachable sandbox
            // costs nothing: the session is untouched and the old tab is still in front.
            const wanted = resolveProvider(environment, {
              ...(tabCommand.provider ? { provider: tabCommand.provider } : {}),
              ...(tabCommand.model ? { model: tabCommand.model } : {}),
            });
            if ("error" in wanted) {
              out.write(style.yellow(`  ${wanted.error}\n`));
              break;
            }
            const backend = tabCommand.backend ?? "local";
            // A tab asking for somewhere else gets its very own sandbox; a tab that asked for
            // nothing shares the session's, because starting a second local workspace on the same
            // directory would be two agents editing one checkout with no idea about each other.
            const ownsWorkspace = backend !== "local" || tabCommand.backend === "local";
            let tabWorkspace = workspace;
            if (tabCommand.backend && tabCommand.backend !== "local") {
              const started = await createWorkspace({ backend: tabCommand.backend });
              if ("error" in started) {
                out.write(style.yellow(`  ${started.error}\n`));
                break;
              }
              tabWorkspace = started.workspace;
            }

            // Saved before opening, or the tab being left behind keeps the incoming tab's state.
            stashActiveTab();
            // Opened before tabs.open() rather than inside its factory: WorkspaceController's
            // factory is synchronous, and the client itself is already live by the time the tab
            // record is created.
            const newTabClient = await openClient(undefined, {
              provider: wanted.provider,
              prices: wanted.prices,
              workspace: tabWorkspace,
            });
            const opened = tabs.open(tabCommand.title ?? `tab ${tabs.size + 1}`, () => ({
              agent: newTabClient,
              ledger: new CostLedger({ prices: wanted.prices, display, rates, catalog: PRICE_CATALOG, ...(approvedBudget ? { budget: approvedBudget } : {}) }),
              mode,
              sink: new TabSink(terminalStream),
              provider: wanted.provider,
              spec: wanted.spec,
              prices: wanted.prices,
              modelId: wanted.model,
              backend: tabCommand.backend ?? args.backend,
              workspace: tabWorkspace,
              ownsWorkspace: tabWorkspace !== workspace,
            }));
            // A tab that has never printed anything has nothing to replay, so it opens on a clean
            // screen the way a new tab should.
            enterTab(opened);
            out.write(`${GUTTER}${style.dim("running")} ${style.cyan(shortModel(wanted.model))} ${style.dim(`${glyphs.middot} ${describeLocation(opened.payload.backend)}`)}\n`);
            showTabs();
            // Once per session, on the tab that first creates the ambiguity. Every time would be
            // nagging; never is how someone comes back to a paused tab expecting a finished job.
            if (!explainedTabs) {
              explainedTabs = true;
              out.write(style.dim(`${GUTTER}${SEQUENTIAL_TABS_NOTE}\n`));
            }
            break;
          }
          case "next": case "previous": {
            stashActiveTab();
            enterTab(tabs.cycle(tabCommand.kind === "next" ? 1 : -1), { replay: true });
            showTabs();
            break;
          }
          case "select":
            if (!switchTab(tabCommand.id)) out.write(style.yellow(`  No tab ${tabCommand.id}.\n`));
            else showTabs();
            break;
          case "rename":
            tabs.active.title = tabCommand.title;
            showTabs();
            break;
          case "close": {
            const { closed, nextActive } = tabs.close(tabCommand.id ?? tabs.active.id);
            // Read before the sink is retired: whether the screen is about to change hands is
            // exactly whether the tab being closed was the one on it.
            const wasInFront = closed.payload.sink.isLive;
            // The tab is gone from the strip, but its agent may still hold a sandbox open.
            closed.payload.sink.setLive(false);
            await closed.payload.agent.dispose().catch(() => undefined);
            // A sandbox this tab started is a sandbox this tab stops paying for. The session's own
            // workspace is shared, and disposing it here would take every other tab down with it.
            if (closed.payload.ownsWorkspace) {
              out.write(style.dim(`  stopping ${describeLocation(closed.payload.backend)}\n`));
              await closed.payload.workspace.dispose().catch(() => undefined);
            }
            // Closing a background tab leaves the screen you were reading exactly as it was.
            enterTab(nextActive, { replay: wasInFront });
            showTabs();
            break;
          }
        }
      } catch (error) {
        out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }

    const wander = parseWanderCommand(input);
    if (wander) {
      if (wander.kind === "invalid") {
        out.write(style.yellow(`  ${wander.reason}\n`));
        continue;
      }
      if (wander.kind === "schedule") {
        // Recurring Wander is a durable job, not a turn: it has to survive this process exiting.
        // The first occurrence runs now; a completed one re-queues itself for the next, so one
        // detached worker process carries the whole schedule without needing a system cron entry.
        const id = newJobId();
        const objective = wanderJobObjective(wander);
        const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id), cadence: wander.cadence, runAt: Date.now() });
        await spawnJobWorker(args.root, job.id);
        out.write(`  ${style.cyan("scheduled")} — job ${job.id} runs now, then every ${wander.cadence === "daily" ? "day" : "week"} after the last one finishes.\n`);
        out.write(style.dim(`  /attach ${job.id} to watch it · /jobs cancel ${job.id} to stop it\n`));
        continue;
      }

      // The lab may cite only what the dossier holds, and the agent may have no network at all, so
      // the search happens here — once, before the turn — and the result is written where the
      // protocol says the scout left it.
      out.write(`  ${style.cyan("wander")} ${style.dim(wander.random ? `picked: ${wander.topic}` : wander.topic)}\n`);
      const evidence = await gatherWanderEvidence(wander.topic, createExaClient(environment));
      if (evidence.expense) ledger.recordExpense(evidence.expense);
      await workspace.writeFile(WANDER_LAB_FILES.evidence, evidence.markdown);
      out.write(style.dim(`  ${evidence.hits.length} source${evidence.hits.length === 1 ? "" : "s"} → ${WANDER_LAB_FILES.evidence}\n`));
      input = buildWanderPrompt(wander.topic);
      wanderRunning = true;
    }

    const jobsCommand = parseJobsCommand(input);
    if (jobsCommand) {
      try {
        switch (jobsCommand.kind) {
          case "invalid":
            out.write(style.yellow(`  ${jobsCommand.reason}\n`));
            break;
          case "list": {
            const jobs = await listJobs(args.root);
            if (jobs.length === 0) {
              out.write(style.dim("  no background jobs — /jobs run <task>, /detach <task>, or /wander daily to start one\n"));
              break;
            }
            // A table rather than the padded line this printed before. The columns were always
            // there — id, status, attempts, what it is waiting on — and `.padEnd(9)` only lined up
            // the second of them, so a long objective pushed every following field somewhere new on
            // each row and the one job that had failed was no easier to find than the rest.
            const listed = buildJobsTable(jobs, { paint: surfacePaint, glyphs });
            out.write(`${renderTable(listed.columns, listed.rows, INITIAL_TABLE_STATE, {
              paint: surfacePaint, width: contentWidth(), glyphs, legend: "", cursor: false,
            })}\n`);
            break;
          }
          case "run": {
            const job = await startBackgroundJob(jobsCommand.objective);
            out.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
            break;
          }
          case "cancel": {
            // The lease's owner (host:pid) is cleared the instant the store marks the job
            // cancelled, so the pid to signal has to be read before that happens.
            const before = await getJob(args.root, jobsCommand.id);
            const { ok } = await cancelJob(args.root, jobsCommand.id);
            if (!ok) { out.write(style.yellow(`  No job ${jobsCommand.id} to cancel — it may already be finished.\n`)); break; }
            const pid = Number(before?.lease?.workerId.split(":").pop());
            if (Number.isInteger(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
            out.write(`  cancelled ${jobsCommand.id}.\n`);
            break;
          }
          case "approve": {
            // `/jobs approve <id>` names a job, not an action, so the action has to be read back
            // and shown before the decision is bound to it — otherwise this authorizes whatever
            // the job happens to be asking for now, which is the hole this whole path closes.
            const pending = (await getJob(args.root, jobsCommand.id))?.pendingApproval;
            if (!pending) { out.write(style.yellow(`  ${jobsCommand.id} has no pending approval.\n`)); break; }
            out.write(style.dim(`  ${jobsCommand.decision === "deny" ? "denying" : "approving"}: ${pending.summary}\n`));
            const ok = await resolveJobApproval(args.root, jobsCommand.id, jobsCommand.decision, pending.actionDigest);
            out.write(ok ? `  delivered — the worker will pick it up shortly.\n` : style.yellow(`  that request changed before your answer arrived — nothing was authorized.\n`));
            break;
          }
        }
      } catch (error) {
        out.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }

    const detachCommand = parseDetachCommand(input);
    if (detachCommand) {
      if (detachCommand.kind === "invalid") {
        out.write(style.yellow(`  ${detachCommand.reason}\n`));
        continue;
      }
      const job = await startBackgroundJob(detachCommand.objective);
      out.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
      continue;
    }

    if (input === "/watch" || input.startsWith("/watch ")) {
      const rest = input.slice("/watch".length).trim().replace(/\s+/g, " ");
      const style_ = sectionStyle();

      if (!rest) {
        if (watched.size === 0) { out.write(style.dim("  watching nothing — /watch <job id>, or /jobs to see what exists\n")); continue; }
        out.write(`${heading("watching", 2, style_)}\n`);
        for (const job of watched.all) {
          const status = job.stream.done ? job.stream.status : "live";
          out.write(`${GUTTER}${style.cyan(job.stream.id)} ${style.dim(`${status} ${glyphs.middot} ${job.sink.log.size} lines`)}  ${job.objective}\n`);
        }
        out.write(`${note("/watch show <id> to read it · /watch stop <id> to stop", style_)}\n`);
        continue;
      }

      const [verb, ...words] = rest.split(" ");
      const target = words.join(" ").trim();

      if (verb === "stop") {
        if (target === "all") { watched.stopAll(); out.write(style.dim("  stopped watching everything\n")); continue; }
        const stopped = watched.stop(target);
        out.write(stopped ? style.dim(`  stopped watching ${target}\n`) : style.yellow(`  not watching ${target}\n`));
        continue;
      }

      if (verb === "show") {
        const job = watched.get(target);
        if (!job) { out.write(style.yellow(`  not watching ${target}\n`)); continue; }
        // Printed from the job's own record rather than re-read from the log: this is exactly what
        // the stream has received, which is the thing being asked about.
        const replay = replayLines(job.sink.log, 200);
        out.write(`${rule(style_, { label: `job ${target}`, tone: "accent", ...(replay.omitted > 0 ? { trailing: `${replay.omitted} earlier lines` } : {}) })}\n`);
        if (replay.lines.length === 0) out.write(`${note("nothing yet", style_)}\n`);
        for (const line of replay.lines) out.write(`${line}\n`);
        continue;
      }

      const id = verb;
      const job = await getJob(args.root, id);
      if (!job) { out.write(style.yellow(`  No job ${id}. /jobs lists what exists.\n`)); continue; }
      await startWatching(id, job.objective);
      out.write(style.dim(`  watching ${id} — it keeps running while you work; /watch show ${id} to read it\n`));
      continue;
    }

    const attachCommand = parseAttachCommand(input);
    if (attachCommand) {
      if (attachCommand.kind === "invalid") {
        out.write(style.yellow(`  ${attachCommand.reason}\n`));
        continue;
      }
      const first = await getJob(args.root, attachCommand.id);
      if (!first) {
        out.write(style.yellow(`  No job ${attachCommand.id}. /jobs lists what exists.\n`));
        continue;
      }
      out.write(style.dim(`  attached to ${attachCommand.id} — Ctrl+C returns to the prompt without stopping it\n`));
      let offset = 0;
      // Ctrl+C here must only end the attach view, not the whole session — swap the interrupt
      // handler for the duration so it does not fall through to the ordinary "quit" behaviour.
      let detachView = false;
      const onAttachSigint = () => { detachView = true; };
      unbindSigint();
      process.on("SIGINT", onAttachSigint);
      readline.on("SIGINT", onAttachSigint);
      try {
        for (;;) {
          const chunk = await readJobLog(args.root, attachCommand.id, offset);
          if (chunk.text) out.write(chunk.text);
          offset = chunk.nextByte;
          if (detachView) break;
          const current = await getJob(args.root, attachCommand.id);
          if (!current) break;
          if (current.pendingApproval) {
            // The digest read here is the one displayed; answering it authorizes that action only.
            // Re-reading the job after the question would race a worker that re-parked a different
            // call while the human was typing, and silently redirect the answer onto it.
            const { summary, actionDigest } = current.pendingApproval;
            const answer = (await readline.question(`  ${style.yellow("approval needed:")} ${summary} [y/N]: `)).trim().toLowerCase();
            const applied = await resolveJobApproval(args.root, attachCommand.id, answer === "y" || answer === "yes" ? "allow" : "deny", actionDigest);
            if (!applied) out.write(style.yellow("  That request changed before your answer arrived — nothing was authorized.\n"));
            continue;
          }
          if (isTerminal(current.status)) { out.write(style.dim(`  job ${current.status}\n`)); break; }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } finally {
        process.off("SIGINT", onAttachSigint);
        readline.off("SIGINT", onAttachSigint);
        bindSigint();
      }
      continue;
    }

    if (input === "/keys") {
      out.write(`${keys.render()}\n\n${renderKeyboardShortcuts(language)}\n`);
      continue;
    }
    if (input === "/undo" || input.startsWith("/undo ")) {
      const argument = input.slice("/undo".length).trim();
      const scope = argument === "code" || argument === "conversation" ? argument : argument === "" ? "both" : null;
      if (scope === null) {
        out.write(style.yellow(`  /undo takes no argument, "code", or "conversation" — not "${argument}".\n`));
        continue;
      }
      const restored = await agent.undo(scope);
      const label = scope === "code" ? "reverted the files for" : scope === "conversation" ? "rewound the conversation before" : "reverted";
      out.write(restored ? style.green(`  ${label} "${restored.label}"\n`) : style.yellow("  nothing to undo\n"));
      continue;
    }
    if (input === "/clear") {
      await agent.relinquish();
      agent = await openClient();
      // A new thread has neither the old thread's folded output nor its copy of what Nova
      // remembers: the first is unreachable output, the second is context the new thread lacks.
      expandables.clear();
      recalledMemoryKeys.clear();
      out.write(style.dim("  new thread\n"));
      continue;
    }
    if (input.startsWith("/pull")) {
      if (workspace.kind !== "e2b") { out.write(style.yellow("  already working locally — nothing to pull\n")); continue; }
      const destination = path.resolve(args.root, input.split(/\s+/)[1] ?? "nova-pull");
      const pulled = await downloadProject(workspace, destination);
      out.write(style.green(`  pulled ${pulled.written.length} files into ${destination}\n`));
      if (pulled.failed.length > 0) out.write(style.yellow(`  ${pulled.failed.length} could not be read\n`));
      continue;
    }
    if (input === "/providers") {
      out.write(`${renderProviders(environment, depth)}\n`);
      continue;
    }
    if (input === "/settings") {
      if (await openSettings() === "exit") break;
      continue;
    }
    if (input.startsWith("/voice")) {
      const supplied = input.slice("/voice".length).trim();
      let audioFile = supplied ? path.resolve(args.root, supplied) : "";
      let temporary = false;
      try {
        if (!audioFile) {
          const recording = await startRecording(environment);
          audioFile = recording.file;
          temporary = true;
          await readline.question(`  ${style.red("● recording")} — speak naturally, then press Enter to stop `);
          await recording.stop();
        }
        out.write(style.dim("  transcribing…\n"));
        let transcript = await transcribeAudio(audioFile, environment);
        out.write(`${box(transcript.split("\n"), { depth, title: "voice transcript", glyphs })}\n`);
        const decision = (await readline.question("  Send this prompt? [Y/n/e to edit]: ")).trim().toLowerCase();
        if (decision === "n" || decision === "no") continue;
        if (decision === "e" || decision === "edit") transcript = (await readline.question("  Edit prompt: ")).trim() || transcript;
        await runTurn(transcript);
      } catch (error) {
        out.write(style.red(`  Voice input failed: ${error instanceof Error ? error.message : String(error)}\n`));
      } finally {
        if (temporary && audioFile) await removeRecording(audioFile).catch(() => undefined);
      }
      continue;
    }
    if (input === "/cost") {
      const history = ledger.history;
      const fraction = ledger.budgetFraction;
      out.write(`${ledger.formatReport()}\n`);
      /**
       * The turns themselves, in columns, under the totals.
       *
       * The report above answers "what has this cost me" and cannot answer "which turn cost it",
       * which is the question with something to do at the end of it: a turn carrying forty tool
       * calls and no cached input is a prompt worth rewriting. The charts below show the shape of
       * spend over time; this is the same session as figures you can read off.
       */
      if (history.length > 1) {
        const spend = buildCostTable(history, {
          money: (cost) => (cost ? formatMoney(convertTo(cost, display, rates) ?? cost) : ""),
          paint: surfacePaint,
        });
        out.write(`${renderTable(spend.columns, spend.rows, INITIAL_TABLE_STATE, {
          paint: surfacePaint, width: contentWidth(), glyphs, legend: "", cursor: false,
        })}\n`);
      }
      // The shape of spend across turns, not just the total — a flat line and a spike to the same
      // total are two very different sessions to have had. A sparkline said that in one row and
      // compressed a long session into illegibility; a bar per turn stays readable and can carry
      // the figure beside it. Kept to the last dozen turns, since a chart taller than a screen is
      // not a chart. The sparkline remains the right tool inside the *status bar*, where there is
      // genuinely only one row.
      if (history.length > 1) {
        const recent = history.slice(-12);
        out.write(`${style.dim(`  spend per turn${history.length > recent.length ? ` (last ${recent.length} of ${history.length})` : ""}`)}\n`);
        for (const line of barChart(
          recent.map((turn) => ({ label: `turn ${turn.turnNumber}`, value: turn.cost?.micros ?? 0 })),
          { width: Math.min(72, contentWidth()), depth: renderDepth, glyphs, format: (value) => formatMoney({ micros: value, currency: recent.find((turn) => turn.cost)?.cost?.currency ?? "USD" }) },
        )) out.write(`  ${line}\n`);
      }
      // Throughput, which no view answered before: "why did that turn feel slow" is a question
      // about tokens per second, and a total cannot answer it. Needs a few turns before the shape
      // means anything.
      const throughput = history
        .filter((turn) => turn.elapsedMs > 0)
        .map((turn) => (turn.usage.totalTokens / turn.elapsedMs) * 1_000);
      if (throughput.length > 2) {
        out.write(`${style.dim("\n  tokens/sec per turn")}\n`);
        for (const line of lineChart(throughput, { width: Math.min(72, contentWidth()), height: 5, depth: renderDepth, glyphs })) {
          out.write(`  ${style.dim(line)}\n`);
        }
      }
      if (fraction !== undefined) {
        // Gradient runs the theme's own success colour toward its error colour — a bar barely
        // filled reads calm because that is all of the gradient it has exposed yet, and one nearly
        // spent reveals almost the whole run toward the warning end, without a separate threshold
        // check anywhere in this file deciding when to turn it red.
        const rgbToken = (value: string): Rgb | undefined => {
          const parsed = parseColor(value);
          // A named ANSI colour (e.g. high-contrast's "brightGreen") parses to a palette index, not
          // an RGB triple — the gradient has no use for one, so it falls back to progressBar's own
          // default rather than interpolating something that isn't a colour.
          return typeof parsed === "object" ? parsed : undefined;
        };
        const from = rgbToken(palette.tokens.success);
        const to = rgbToken(palette.tokens.error);
        // The bar fills from empty rather than jumping straight to the true fraction — spend
        // visibly "catches up" to where it actually is instead of teleporting there, the same
        // spring `progressBar` itself already leaves the gradient's shape to.
        const meterLine = (value: number) => `  ${style.dim("budget")} [${progressBar(value, 24, { depth: renderDepth, glyphs, from, to })}] ${style.dim(`${Math.round(Math.min(1, value) * 100)}%`)}`;
        const meter = new ReplaceableBlock(out);
        const handle = meter.append(meterLine(0));
        await new Promise<void>((resolve) => {
          const animator: SpringAnimator = new SpringAnimator(0, (value) => {
            meter.update(handle, meterLine(value));
            if (animator.settled) resolve();
          });
          animator.retarget(fraction);
        });
      }
      continue;
    }
    const payCommand = parsePayCommand(input);
    if (payCommand) {
      if (payCommand.kind === "invalid") {
        out.write(style.yellow(`  ${payCommand.reason}\n`));
        continue;
      }
      // Both settings or neither: refusing here, before any amount is discussed, is kinder than
      // failing at the moment someone is trying to hand over money.
      const gateway = billingFromEnvironment(environment);
      if (!gateway) {
        for (const line of BILLING_NOT_CONFIGURED) out.write(`  ${line}\n`);
        continue;
      }
      const sessionSpendRwf = (() => {
        const total = ledger.displayTotal;
        const rwf = total ? convertTo(total, "RWF", rates) : undefined;
        return rwf ? Math.round(rwf.micros / 1_000_000) : undefined;
      })();
      try {
        if (payCommand.kind === "balance") {
          const balance = await gateway.getBalance();
          for (const line of renderBalance(balance, { sessionSpendRwf })) out.write(`  ${line}\n`);
          continue;
        }
        if (payCommand.kind === "status") {
          const payment = await gateway.getPayment(payCommand.reference);
          // The balance is only ever read back, never worked out from the amount — a figure Nova
          // computed that disagrees with the provider's ledger is the disagreement users notice.
          const balance = payment.status === "paid" ? await gateway.getBalance().catch(() => undefined) : undefined;
          for (const line of renderPaymentOutcome(payment, { timedOut: false, balance })) out.write(`  ${line}\n`);
          continue;
        }

        const before = await gateway.getBalance().catch(() => undefined);
        out.write(`${box(renderTopUpQuote(payCommand.amountRwf, before), { depth: renderDepth, title: "payment", glyphs })}\n`);
        // Money never moves without a person saying so in this session. A piped or scripted run has
        // nobody to ask, so it stops rather than treating the command itself as consent.
        if (!interactive) {
          out.write(style.yellow("  Paying needs an interactive session — run /pay from the Nova prompt.\n"));
          continue;
        }
        statusBar.clear();
        const confirmation = (await readline.question(`  ${style.yellow("?")} Create this payment? ${style.dim("[y/N]: ")}`)).trim().toLowerCase();
        if (confirmation !== "y" && confirmation !== "yes") {
          out.write(style.dim("  Cancelled — nothing was charged.\n"));
          continue;
        }

        const checkout = await gateway.createCheckout({ amountRwf: payCommand.amountRwf, idempotencyKey: newIdempotencyKey() });
        for (const line of renderCheckout(checkout)) out.write(`  ${line}\n`);
        out.write(style.dim("  waiting for confirmation — Ctrl+C stops waiting; the payment itself continues\n"));

        // Same swap as /attach: Ctrl+C here must end the wait, not the session — and stopping the
        // wait must never be reported as a failed payment, because the money may already be moving.
        const stopped = { aborted: false };
        const onPaySigint = () => { stopped.aborted = true; };
        unbindSigint();
        process.on("SIGINT", onPaySigint);
        readline.on("SIGINT", onPaySigint);
        let outcome;
        try {
          outcome = await waitForPayment(gateway, checkout.reference, { signal: stopped });
        } finally {
          process.off("SIGINT", onPaySigint);
          readline.off("SIGINT", onPaySigint);
          bindSigint();
        }
        const after = outcome.payment.status === "paid" ? await gateway.getBalance().catch(() => undefined) : undefined;
        for (const line of renderPaymentOutcome(outcome.payment, { timedOut: outcome.timedOut, balance: after })) {
          out.write(`  ${outcome.payment.status === "paid" ? style.green(line) : line}\n`);
        }
      } catch (error) {
        out.write(style.red(`  ${error instanceof BillingError ? error.message : `Payment failed: ${error instanceof Error ? error.message : String(error)}`}\n`));
      }
      continue;
    }
    if (input === "/scan" || input.startsWith("/scan ")) {
      const include = input.slice("/scan".length).trim() || undefined;
      out.write(style.dim("  scanning for likely hardcoded secrets…\n"));
      const findings = await agent.scanSecrets(include);
      lastScanFindings = findings.length;
      if (findings.length === 0) {
        out.write(`  ${style.green(glyphs.check)} No likely secrets found by pattern${include ? ` in ${include}` : ""}.\n`);
        continue;
      }
      // Interactive: the queue, one finding at a time, with the evidence beside it and a decision
      // attached — because a flat list of forty findings is read once and dealt with never. Piped
      // or non-interactive: the same findings as lines, since there is nobody to press a key.
      if (interactive && liveTerminal) {
        out.write(`  ${style.yellow(`${findings.length} possible secret${findings.length === 1 ? "" : "s"}`)} found by pattern${include ? ` in ${include}` : ""} — verify each; a pattern match is a lead, not proof.\n`);
        const outcome = await openDefenderTriage(
          { readline, input: process.stdin, output: process.stdout },
          findings,
          {
            style: { depth: renderDepth, glyphs },
            // The matched line and its neighbours, read through the workspace so a sandboxed
            // session shows the sandbox's copy. Already masked by the scan; the file is read here
            // only to show the shape of the code around it.
            loadEvidence: async (finding) => {
              const window = await agent.readFile(finding.path, { offset: Math.max(1, finding.line - 2), limit: 5 }).catch(() => null);
              if (!window) return undefined;
              return window.content.split("\n").map((line, index) => {
                const number = window.startLine + index;
                // Never the file's own text for the matched line: the whole point of masking is
                // that the secret does not get printed, and the line it sits on is where it is.
                return number === finding.line ? `${number} | ${finding.masked}  (${finding.kind})` : `${number} | ${line}`;
              });
            },
          },
        );
        lastScanFindings = outcome.findings.filter((finding) => finding.triage === "open").length;
        for (const finding of outcome.toFix) {
          out.write(`  ${style.yellow(glyphs.pending)} queued for repair: ${finding.path}:${finding.line} ${style.dim(finding.kind)}\n`);
        }
        // Decisions become work, one turn each, in the order they were picked. Queued rather than
        // run inside the screen: a model turn needs the terminal back first.
        for (const finding of outcome.toFix.reverse()) queuedInput.unshift(fixObjective(finding));
        const ignored = outcome.findings.filter((finding) => finding.triage === "ignored").length;
        if (ignored > 0) out.write(style.dim(`  ${ignored} ignored this pass\n`));
        continue;
      }

      const bySeverity = new Map<string, number>();
      for (const finding of findings) bySeverity.set(finding.severity, (bySeverity.get(finding.severity) ?? 0) + 1);
      out.write(`  ${style.yellow(`${findings.length} possible secret${findings.length === 1 ? "" : "s"}`)} found by pattern, worst first — verify each; a pattern match is a lead, not proof.\n`);
      // Bar length is the count and the label is the severity. A heat strip shaded by count drew
      // fourteen mediums darker than two criticals, which reads as "the mediums are the worse
      // problem" — the one thing a security summary must never imply.
      for (const line of barChart(
        (["critical", "high", "medium"] as const)
          .filter((severity) => bySeverity.has(severity))
          .map((severity) => ({ label: severity, value: bySeverity.get(severity) ?? 0 })),
        { width: Math.min(60, contentWidth()), depth: renderDepth, glyphs, max: findings.length },
      )) out.write(`  ${line}\n`);
      out.write("\n");
      for (const finding of findings) {
        const severityColor = finding.severity === "critical" ? style.red : finding.severity === "high" ? style.yellow : style.dim;
        out.write(`  ${severityColor(`[${finding.severity}]`)} ${finding.path}:${finding.line}: ${finding.kind} — ${style.dim(displayMask(finding.masked, glyphs))}\n`);
      }
      continue;
    }
    if (input === "/where") {
      out.write(`  ${workspace.kind === "e2b" ? style.yellow(workspace.label) : style.dim(workspace.label)}\n`);
      continue;
    }
    if (input === "/tools") {
      const inspected = await agent.inspectTools();
      const contributing = new Set(inspected.tools.map((tool) => (tool.provenance && tool.provenance.kind !== "built-in" ? `${tool.provenance.kind}:${tool.provenance.providerId}` : "built-in")));
      out.write(`${renderTools({
        tools: inspected.tools,
        hooks: inspected.hooks,
        // A configured source that contributed nothing is worth naming — it usually means a wrong
        // path in a manifest. The always-present `.nova/skills` reader is not: a project with no
        // skills is the ordinary case, and reporting it as an anomaly to everyone who has none is
        // noise dressed as a warning.
        emptyProviders: inspected.providerIds
          .filter((id) => !contributing.has(id) && id !== `skill:${IMPLICIT_SKILL_PROVIDER_ID}`),
      }, style)}\n`);
      continue;
    }
    if (input.startsWith("/") && !isKnownCommand(input.split(/\s+/)[0])) {
      // Without this the typo is simply sent to the model, which costs a round trip to be told
      // it makes no sense.
      const name = input.split(/\s+/)[0];
      const suggestion = suggestCommand(name);
      out.write(`  ${style.yellow(`Unknown command ${name}.`)}${style.dim(suggestion ? ` Did you mean ${suggestion}?` : " Type /help for the list.")}\n`);
      continue;
    }

    await runTurn(input);

    // Alt+B fired while that turn was running: it is already stopped at a safe checkpoint and its
    // session already saved (agent.send persists after every turn, cancelled or not). Hand it to a
    // detached worker to pick up from exactly there, then give this tab a clean slate — continuing
    // to type into the same in-memory agent would leave two writers on one session file.
    if (detachRequested) {
      detachRequested = false;
      const sessionId = agent.sessionId;
      await agent.relinquish();
      agent = await openClient();
      const id = newJobId();
      const job = await enqueueJob(args.root, { id, objective: `Continue: ${input}`, logPath: jobLogPath(args.root, id), sessionId });
      await spawnJobWorker(args.root, job.id);
      out.write(`  ${style.cyan("sent to background")} — job ${job.id} continues it. /attach ${job.id} to watch.\n`);
    }
  }

  process.stdout.write(style.dim("  bye — this session stays saved and resumable ✦\n"));
  await agent.dispose();
  // A tab opened and left open (never closed, never made active again) never got its own explicit
  // dispose — this is the safety net for it, closing whatever the daemon still holds, sandboxes
  // included, rather than leaking them on exit. Idempotent: the active agent above is already gone
  // from the daemon's session map by the time this runs, so its own dispose is not repeated.
  await daemon.shutdown();
  await stateHistory.close();
  const promptHistory = ([...((readline as Interface & { history?: string[] }).history ?? [])]).reverse();
  await saveHistory(promptHistory, environment).catch(() => undefined);
  exitCleanly();
  return 0;
}

/**
 * True when this file is the program being run, rather than an import.
 *
 * `import.meta.main` is a Bun and Node ≥22 convenience that does not exist on the Node versions a
 * published CLI still has to support, so the argv comparison is the portable form — and this file
 * has to stay importable by tests either way.
 */
export function isEntryPoint(): boolean {
  if (typeof (import.meta as { main?: boolean }).main === "boolean") return (import.meta as { main: boolean }).main;
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    // Resolved through symlinks on purpose. npm installs a binary as a link in `.bin`, so argv[1]
    // is that link while `import.meta.url` is the real file — comparing them raw makes an installed
    // `nova` exit silently with status 0, doing nothing at all.
    return import.meta.url === pathToFileURL(realpathSync(invoked)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exit(1);
    });
}

export { main };
