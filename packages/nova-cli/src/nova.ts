#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NovaAgent, type NovaEvent } from "@circuit-nova/nova-core/nova-cli/agent";
import type { NovaMode, PermissionDecision } from "@circuit-nova/nova-core/nova-cli/permissions";
import { assessTaskSafety, type SafetyAssessment } from "@circuit-nova/nova-core/nova-cli/safety";
import { listSessions, loadSession } from "@circuit-nova/nova-core/nova-cli/session";
import { describeProviders, PRICE_ENVIRONMENT_HINT, PROVIDER_IDS, resolveProvider } from "@circuit-nova/nova-core/providers/agent-matrix";
import { convertTo, fromUnits, formatMoney, isCurrency, type Currency, type FxRate, type Money } from "@circuit-nova/nova-core/money";
import { createExaClient } from "@circuit-nova/nova-core/providers/exa";
import { downloadProject, E2BWorkspace, LocalWorkspace, uploadProject, type NovaWorkspace } from "@circuit-nova/nova-core/nova-cli/backends";
import { CostLedger } from "@circuit-nova/nova-core/nova-cli/cost";
import { PRICE_CATALOG } from "@circuit-nova/nova-core/providers/price-catalog";
import { detectColorDepth, renderBanner, renderTagline } from "./banner";
import { box, formatStatusLine, MarkdownStream, ReplaceableBlock, Spinner, StatusBar } from "./tui";
import { PinnedScreen } from "./screen";
import { describeToolCall, summarizeToolResult } from "./transcript";
import { renderMarkdown } from "./markdown";
import { completeInput, isKnownCommand, parseModeCommand, renderCommandHelp, renderKeyboardShortcuts, suggestCommand } from "./commands";
import { KeyBindingRegistry, parseBindingOverrides } from "./keybindings";
import { installShortcuts, openPalette } from "./shortcuts";
import { fetchDailyFxRate, resolveCurrencyPreference } from "./local-currency";
import { NOVA_CLI_VERSION, runSelfUpdate } from "./update";
import { SETTING_FIELDS, loadSettings, mergedEnvironment, runSettingsMenu, saveSettings, settingsFile, type NovaSettings } from "./settings";
import { loadHistory, saveHistory } from "./history";
import { renderTabStrip, parseTabCommand, WorkspaceController } from "./tabs";
import { buildWanderPrompt, gatherWanderEvidence, parseWanderCommand, wanderJobObjective } from "./wander";
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
import { removeRecording, startRecording, transcribeAudio } from "./voice";
import { controlLabel, resolveControlLanguage, type ControlLanguage } from "./i18n";

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
const style = {
  dim: wrap("[2m"),
  bold: wrap("[1m"),
  cyan: wrap("[36m"),
  green: wrap("[32m"),
  yellow: wrap("[33m"),
  red: wrap("[31m"),
};

type ParsedArgs = {
  mode: NovaMode;
  prompt: string | null;
  resume: string | null;
  listSessions: boolean;
  listProviders: boolean;
  update: boolean;
  checkUpdate: boolean;
  settings: boolean;
  estimateOnly: boolean;
  updateYes: boolean;
  packageManager: string | undefined;
  version: boolean;
  root: string;
  help: boolean;
  /** Where files are written: this machine, or a throwaway remote sandbox. */
  backend: "local" | "e2b";
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
};

/** Shape of the ids `newSessionId` mints, e.g. `20260808T001720Z-2ubjpz`. */
const SESSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const updateRequested = argv[0] === "update" || argv.includes("--update") || argv.includes("--check-update");
  const settingsRequested = argv[0] === "settings" || argv.includes("--settings");
  const parsed: ParsedArgs = {
    mode: "build", prompt: null, resume: null, listSessions: false, listProviders: false,
    update: updateRequested, checkUpdate: false, updateYes: false, packageManager: undefined, version: false, settings: settingsRequested, estimateOnly: false,
    root: process.cwd(), help: false,
    backend: "local", upload: false, preset: undefined, sandboxMinutes: 30, budget: undefined, provider: undefined, model: undefined, currency: undefined, country: undefined, language: undefined, allowSensitive: false,
  };
  const rest: string[] = [];

  for (let index = argv[0] === "update" || argv[0] === "settings" ? 1 : 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" || argument === "-p") parsed.mode = "plan";
    else if (argument === "--auto" || argument === "-y") parsed.mode = "auto";
    else if (argument === "--build") parsed.mode = "build";
    else if (argument === "--help" || argument === "-h") parsed.help = true;
    else if (argument === "--version" || argument === "-v") parsed.version = true;
    else if (argument === "--settings") parsed.settings = true;
    else if (argument === "--estimate") parsed.estimateOnly = true;
    else if (argument === "--allow-sensitive") parsed.allowSensitive = true;
    else if (argument === "--update") parsed.update = true;
    else if (argument === "--check-update") { parsed.update = true; parsed.checkUpdate = true; }
    else if (argument === "--check" && updateRequested) parsed.checkUpdate = true;
    else if (argument === "--yes" && updateRequested) parsed.updateYes = true;
    else if (argument === "--package-manager" && updateRequested) { parsed.packageManager = argv[index + 1]; index += 1; }
    else if (argument === "--sessions") parsed.listSessions = true;
    else if (argument === "--providers" || argument === "--doctor") parsed.listProviders = true;
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
      if (value === "local" || value === "e2b") { parsed.backend = value; index += 1; } else parsed.backend = "e2b";
    }
    else if (argument === "--upload") parsed.upload = true;
    else if (argument === "--image") { parsed.preset = argv[index + 1]; index += 1; }
    else if (argument === "--sandbox-minutes") { parsed.sandboxMinutes = Number(argv[index + 1] ?? 30); index += 1; }
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
  if (rest.length > 0) parsed.prompt = rest.join(" ");
  return parsed;
}

// A function, not a constant: it is built after `configureRendering` has learned whether the
// destination can render colour at all, which a module-level template literal would predate.
function helpText(language: ControlLanguage = "en"): string {
  return `
${style.bold("nova")} — a coding agent in your terminal

  nova                      Start an interactive session
  nova "add a health check" Run one request and exit
  nova --plan               Plan mode: read and reason, never write
  nova --auto               Auto mode: ordinary edits apply; sensitive actions ask
  nova --allow-sensitive    Approve a flagged task preflight (tool guards still apply)
  nova --resume [id]        Continue a previous session ("latest" by default)
  nova --sessions           List sessions in this project
  nova --cwd <dir>          Work in a different project root
  nova update               Check, confirm, and install the latest Nova CLI
  nova --update             Alias for nova update
  nova update --check       Check for an update without installing it
  nova update --yes         Update without an interactive confirmation
  nova --version            Print the installed CLI version

${style.bold("Where the files go")}
  nova --sandbox            Work in a remote E2B sandbox, not on this machine
  nova --sandbox --upload   ...seeded with a copy of this project
  nova --image <preset>     Sandbox image to use (default: general)
  nova --sandbox-minutes N  Sandbox lifetime (default 30)

${style.bold("Model")}
  nova --provider <name>    ${PROVIDER_IDS.join(" | ")}
  nova --model <id>         Model to run (defaults to the provider's)
  nova --providers          Show which providers are configured, and what is missing
  nova settings             Configure keys, URLs, models, pricing and voice input

${style.bold("Cost")}
  nova --location EG        Select a country (auto-detected from your locale by default)
  nova --currency EGP       Select any supported ISO display currency
  nova --budget N           Approve and enforce a cap in the display currency
  nova --estimate "task"    Show a token/cost forecast without calling the model
  /cost                     Token and cost breakdown for this session

${style.bold("In a session")}
${renderCommandHelp(language)}
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
const statusBar = new StatusBar();
const toolLines = new ReplaceableBlock();
let markdown = new MarkdownStream(process.stdout, "none");
let spinner: Spinner | undefined;
let screen: PinnedScreen | undefined;

/** Wrapping width for prose: the pinned screen's golden-ratio-capped measure, or the raw terminal otherwise. */
function contentWidth(): number {
  return screen?.current.contentWidth ?? (process.stdout.columns ?? 80);
}
const activity: { awaitingFirstDelta: boolean; toolCalls: number; tokens: number; phase: "thinking" | "operation"; operation?: string } = {
  awaitingFirstDelta: false,
  toolCalls: 0,
  tokens: 0,
  phase: "thinking",
};
/** Announced calls awaiting their result, by call id, so each can be rewritten where it sits. */
const pendingCalls = new Map<string, { line: number; detail: string; name: string }>();

/** Points the renderer at the colour depth and terminal the session actually has. */
export function configureRendering(
  depth: ReturnType<typeof detectColorDepth>,
  live: boolean = Boolean(process.stdout.isTTY),
): void {
  colorEnabled = depth !== "none";
  liveTerminal = live;
  markdown = new MarkdownStream(process.stdout, depth, contentWidth, live);
}

function endStreamedLine(): void {
  markdown.end();
}

/** Drops the block and the calls it held, once something else owns the bottom of the screen. */
function forgetToolLines(): void {
  toolLines.forget();
  pendingCalls.clear();
}

/** Composes one tool line: a mark, the tool, what it was called with, and how it went. */
function toolLineText(mark: string, name: string, detail: string, summary: string): string {
  const head = `  ${mark} ${style.cyan(name)}`;
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
 */
function renderUserTurn(text: string): string {
  return text
    .split("\n")
    .map((line) => `${style.bold(style.cyan("❯"))} ${style.bold(line)}`)
    .join("\n");
}

export function renderEvent(event: NovaEvent): void {
  // Every event clears the spinner before printing. If the spinner is still running its next tick
  // redraws the bar underneath whatever just printed, so feedback continues through a whole run of
  // tool calls rather than only filling the first gap.
  statusBar.clear();

  if (event.type === "runtime" && event.event.type === "assistant_delta") {
    // The first delta of a turn is the one moment worth a header: it is where a reader's eye needs
    // to land to tell "the assistant is now speaking" apart from the tool lines and the user's own
    // request above it. Every delta after the first is the same reply continuing, not a new one.
    if (activity.awaitingFirstDelta) process.stdout.write(`\n${style.dim("✦")} ${style.bold("Nova")}\n`);
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
    process.stdout.write(style.dim(`  ⎿ checkpoint ${event.checkpoint.tree.slice(0, 8)}\n`));
    return;
  }
  if (event.type === "compaction") {
    forgetToolLines();
    process.stdout.write(style.dim(`  ⎿ compacted context (${event.messagesBefore} → ${event.messagesAfter} messages)\n`));
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
    // Announcing then rewriting needs a cursor. Piped, the announcement would be a duplicate line
    // nobody can erase, so only the completed line below is printed.
    const line = liveTerminal ? toolLines.append(toolLineText(style.dim("⋯"), runtime.toolName, style.dim(detail), "")) : -1;
    pendingCalls.set(runtime.toolCallId, { line, detail, name: runtime.toolName });
    activity.phase = "operation";
    activity.operation = runtime.toolName;
    // A model can stream an explanation and then begin a long command. The first delta stopped
    // the thinking animation; restart it here so the operation never becomes silent dead air.
    spinner?.start();
    return;
  }
  if (runtime.type === "tool_result") {
    activity.toolCalls += 1;
    const mark = runtime.isError ? style.red("✗") : style.green("✓");
    const summary = summarizeToolResult(runtime.toolName, runtime.content, runtime.isError);
    // The announcement and the outcome are the same line, rewritten where it already sits. Reads
    // parallel-safe calls correctly too: several are announced before the first result returns, so
    // the line to rewrite is usually not the last one printed.
    const pending = pendingCalls.get(runtime.toolCallId);
    const completed = toolLineText(mark, runtime.toolName, style.dim(pending?.detail ?? ""), summary);
    if (pending === undefined || pending.line < 0 || !toolLines.update(pending.line, completed)) {
      process.stdout.write(`${completed}\n`);
    }
    pendingCalls.delete(runtime.toolCallId);
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
  const lines: string[] = [];

  for (const status of statuses) {
    const mark = status.configured ? paint("✓", style.green) : paint("○", style.dim);
    const detail = status.configured
      ? paint(`${status.model} · pricing: ${status.pricing}`, style.dim)
      : paint(`set ${status.missing.join(" and ")}`, style.yellow);
    lines.push(`  ${mark} ${status.label.padEnd(14)} ${detail}`);
  }
  const exaConfigured = Boolean(environment.EXA_API_KEY?.trim());
  lines.push(`  ${exaConfigured ? paint("✓", style.green) : paint("○", style.dim)} ${"Exa search".padEnd(14)} ${exaConfigured ? paint("web_search enabled", style.dim) : paint("set EXA_API_KEY or use nova settings", style.yellow)}`);

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
export function createApprovalPrompt(readline: Interface, interactive: boolean, signal: () => AbortSignal | undefined) {
  return async ({ summary, safety }: { summary: string; safety?: SafetyAssessment }): Promise<PermissionDecision> => {
    // Without a terminal there is nobody to ask, and a prompt written to a pipe would either hang
    // or read the next line of piped input as an answer. Denying is the only honest result — and
    // it is reported, so the run does not look like the model simply chose not to act.
    if (!interactive) {
      process.stdout.write(`\n  ${style.yellow("!")} Nova needs approval to ${style.bold(summary)}, but stdin is not a terminal.\n`);
      process.stdout.write(`    ${style.dim("Re-run with --auto to pre-approve workspace edits.")}\n`);
      return "deny_always";
    }
    // A tool call can arrive before the model emits visible text. In that case the TUI spinner is
    // still redrawing the last row and can overwrite the first approval question unless it is
    // explicitly stopped here.
    activity.awaitingFirstDelta = false;
    spinner?.stop();
    statusBar.clear();
    endStreamedLine();
    process.stdout.write(`\n  ${style.yellow("?")} Nova wants to ${style.bold(summary)}\n`);
    if (safety?.sensitive) process.stdout.write(`    ${style.yellow("Safety guard:")} ${safety.reasons.join(", ")}\n`);
    let answer: string;
    try {
      answer = (await readline.question(`    ${style.dim("[y]es / [n]o / [a]lways / [d]eny always: ")}`, { signal: signal() })).trim().toLowerCase();
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        process.stdout.write(style.yellow("\n  interrupted — treating as denied\n"));
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
    process.stdout.write(`  ${style.yellow("Safety guard:")} ${detail} — task preflight approved by --allow-sensitive.\n`);
    return true;
  }
  if (!interactive) {
    process.stdout.write(`  ${style.yellow("Safety guard blocked this task:")} ${detail}.\n`);
    process.stdout.write(`    ${style.dim("Review it, then re-run with --allow-sensitive. Sensitive tool operations remain separately gated.")}\n`);
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
  let language = resolveControlLanguage(args.language ?? environment.NOVA_LANGUAGE ?? environment.LANG);
  if (args.help) {
    process.stdout.write(helpText(language));
    return 0;
  }

  if (args.version) {
    process.stdout.write(`nova ${NOVA_CLI_VERSION}\n`);
    return 0;
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
      });
    } catch (error) {
      settingsReadline.close();
      if (isReadlineExit(error)) {
        process.stdout.write(style.dim("\nSettings cancelled — no changes were saved.\n"));
        return 0;
      }
      throw error;
    }
    const file = await saveSettings(savedSettings, processEnvironment);
    settingsReadline.close();
    process.stdout.write(`Settings saved to ${file}. Environment variables override saved values.\n`);
    return 0;
  }

  if (args.listProviders) {
    process.stdout.write(`${renderProviders(environment, detectColorDepth(environment, Boolean(process.stdout.isTTY)))}\n`);
    return 0;
  }

  if (args.listSessions) {
    const sessions = await listSessions(args.root);
    if (sessions.length === 0) process.stdout.write("No sessions in this project yet.\n");
    for (const session of sessions) {
      process.stdout.write(`${style.cyan(session.id)}  ${new Date(session.updatedAt).toLocaleString()}  ${session.title}\n`);
    }
    return 0;
  }

  const resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Nova is not configured.")} ${resolved.error}\n`);
    return 1;
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
    if (!configured && environment.NOVA_FX_OFFLINE !== "true") {
      const daily = await fetchDailyFxRate(prices.currency, display);
      if (daily) rates.push(daily);
    }
    const convertible = rates.some((rate) => (rate.from === prices!.currency && rate.to === display) || (rate.to === prices!.currency && rate.from === display));
    if (!convertible) {
      if (args.budget) {
        process.stderr.write(`${style.red("Cannot enforce the approved budget.")} No ${prices.currency}→${display} exchange rate is available. Set a manual FX rate, choose --currency ${prices.currency}, or reconnect and retry.\n`);
        return 1;
      }
      localCurrencyWarning = `No current ${prices.currency}→${display} rate was available; costs remain in ${prices.currency}.`;
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
    completer: (line: string) => completeInput(line, projectFiles),
    history: (await loadHistory(environment)).reverse(),
    historySize: 200,
    removeHistoryDuplicates: true,
  });
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
  const uninstallShortcuts = interactive
    ? installShortcuts({
      readline, input: process.stdin, output: process.stdout, registry: keys,
      onIntercept: (command) => {
        if (command !== "/detach" || !turnActive) return false;
        detachRequested = true;
        agent.cancel();
        return true;
      },
    })
    : () => {};
  // The status bar and spinner draw over the current line and redraw in place — meaningless
  // (and corrupting) output when either end of the pipe is not a real terminal.
  const ttyMode = interactive && Boolean(process.stdout.isTTY);
  const depth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
  configureRendering(depth);
  let mode = args.mode;

  /**
   * Every return point tears down the same three things, in the same order — reassigned once
   * `unbindSigint` exists (below) rather than duplicated, so an exit path added later can't forget
   * one. A scroll region left set when the process exits is inherited by the user's own shell
   * afterward, which reads as the terminal being broken until they notice and reset it themselves.
   */
  let exitCleanly = () => { screen?.exit(); uninstallShortcuts(); readline.close(); };

  const approvedBudget = args.budget ? fromUnits(args.budget, display) : undefined;
  if (approvedBudget && !await confirmSpendingCap(readline, interactive, formatMoney(approvedBudget))) {
    process.stdout.write(style.yellow("  Spending not approved — no sandbox or model was started.\n"));
    exitCleanly();
    return 0;
  }

  // Built once and shared by every agent instance in this process: a mode switch or /clear must
  // keep working in the same sandbox, not silently start a second one and lose the first's files.
  let workspace: NovaWorkspace;
  if (args.backend === "e2b" && !args.estimateOnly) {
    // Imported here, not at the top: a local-only session should never load the E2B SDK, which is
    // what lets the published package treat it as an optional dependency.
    const { findWorkspacePreset } = await import("@circuit-nova/nova-core/sandbox-templates");
    const { createE2BProvider } = await import("@circuit-nova/nova-core/providers/factory");
    const preset = findWorkspacePreset(args.preset);
    const sandbox = createE2BProvider(environment, preset.templateAlias);
    if (!sandbox) {
      process.stderr.write(`${style.red("Remote sandboxes need E2B.")} Set E2B_API_KEY (and E2B_CODING_TEMPLATE for a custom image).\n`);
      exitCleanly();
      return 1;
    }
    const minutes = Math.max(1, Math.min(args.sandboxMinutes, 60));
    process.stdout.write(style.dim(`Starting an E2B sandbox (${preset.label}, ${minutes}m)…\n`));
    const session = await sandbox.createSandbox({ taskId: `nova_${Date.now()}`, template: "coding", maxRuntimeSeconds: minutes * 60 });
    workspace = new E2BWorkspace({
      sandbox,
      sandboxId: session.sandboxId,
      workspaceRoot: "/workspace/repo",
      // Stopped rather than suspended: a CLI session that ends has no next step to resume into,
      // and a sandbox left paused keeps costing the user something they cannot see.
      onDispose: (id) => sandbox.stopSandbox(id),
    });
    process.stdout.write(style.dim(`  sandbox ${session.sandboxId} — files stay there, not on this machine\n`));

    if (args.upload) {
      const uploaded = await uploadProject(workspace, args.root);
      process.stdout.write(style.dim(`  uploaded ${uploaded.uploaded.length} files${uploaded.skipped.length > 0 ? `, skipped ${uploaded.skipped.length}` : ""}\n`));
    }
  } else {
    workspace = new LocalWorkspace(args.root);
  }

  refreshProjectFiles();

  let ledger = new CostLedger({
    prices,
    display,
    rates,
    catalog: PRICE_CATALOG,
    ...(approvedBudget ? { budget: approvedBudget } : {}),
  });

  // Read at ask-time by `createApprovalPrompt`, not captured once: it is replaced every turn (an
  // `AbortSignal` is single-use) but the prompt function itself is built once per agent and must
  // keep seeing whichever turn is currently running.
  let currentTurnAbort: AbortController | undefined;
  const newAgent = () => new NovaAgent({
    root: args.root,
    model,
    // The runtime keeps its own integer-unit ceiling as a runaway guard; the ledger below owns the
    // real, currency-aware budget. Feeding it the provider's own per-million rates keeps that guard
    // proportionate to actual spend instead of to a unit nobody configured.
    prices: modelPriceCatalogFor(prices, Boolean(approvedBudget)),
    ...(approvedBudget && prices ? { budgets: { maxRwf: convertTo(approvedBudget, prices.currency, rates)?.micros ?? approvedBudget.micros } } : {}),
    mode,
    workspace,
    approve: createApprovalPrompt(readline, interactive, () => currentTurnAbort?.signal),
    search: createExaClient(environment),
    onExpense: (expense) => ledger.recordExpense(expense),
    onEvent: (event: NovaEvent) => {
      if (event.type === "runtime" && event.event.type === "assistant_delta") streamedAnswer = true;
      renderEvent(event);
    },
  });
  let agent = newAgent();

  /**
   * One workspace, several pieces of work.
   *
   * Each tab owns its own agent, cost ledger and mode; switching swaps the three locals the rest of
   * this loop already reads. Threading a tab handle through every call site instead would touch
   * every line below without changing what any of them do.
   */
  const tabs = new WorkspaceController<{ agent: NovaAgent; ledger: CostLedger; mode: NovaMode }>();
  tabs.adopt(path.basename(args.root) || "nova", { agent, ledger, mode });
  const switchTab = (id: number): boolean => {
    const current = tabs.active;
    current.payload.agent = agent;
    current.payload.ledger = ledger;
    current.payload.mode = mode;
    const next = tabs.activate(id);
    if (!next) return false;
    ({ agent, ledger, mode } = next.payload);
    return true;
  };
  const showTabs = () => {
    const strip = renderTabStrip(tabs.views, { width: contentWidth() });
    if (strip) process.stdout.write(`  ${style.dim(strip)}\n`);
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
    const strip = tabs.size > 1 ? `${renderTabStrip(tabs.views, { width: screen?.current.columns ?? 80 })} · ` : "";
    const cost = ledger.displayTotal ? formatMoney(ledger.displayTotal) : "cost unknown";
    return `${strip}${style.cyan(mode)} ${style.dim(`· ${cost}`)}`;
  };

  /** Enqueues a fresh (non-continuation) job and starts its worker — the shared tail of `/jobs run` and `/detach <task>`. */
  const startBackgroundJob = async (objective: string) => {
    const id = newJobId();
    const job = await enqueueJob(args.root, { id, objective, logPath: jobLogPath(args.root, id) });
    await spawnJobWorker(args.root, job.id);
    return job;
  };

  if (args.estimateOnly) {
    if (!args.prompt) {
      process.stderr.write("Pass the task to estimate, for example: nova --estimate \"fix the failing tests\"\n");
      await agent.dispose();
      exitCleanly();
      return 1;
    }
    process.stdout.write(`${ledger.formatPrediction(await agent.estimateNextTurn(args.prompt))}\n`);
    await agent.dispose();
    exitCleanly();
    return 0;
  }

  if (args.resume) {
    const id = args.resume === "latest" ? (await listSessions(args.root, 1))[0]?.id : args.resume;
    const record = id ? await loadSession(args.root, id) : null;
    if (record) {
      agent.resume(record);
      process.stdout.write(style.dim(`Resumed ${record.id} — ${record.title}\n`));
    } else {
      process.stdout.write(style.yellow("No matching session; starting a new one.\n"));
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
      process.stdout.write(style.yellow("\n  interrupted — finishing the current tool call\n"));
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
  exitCleanly = () => { unbindSigint(); screen?.exit(); uninstallShortcuts(); readline.close(); };

  let streamedAnswer = false;
  const runTurn = async (request: string): Promise<boolean> => {
    streamedAnswer = false;
    if (screen) {
      screen.parkInTranscript();
      process.stdout.write(`${renderUserTurn(request)}\n`);
    }
    const taskSafety = assessTaskSafety(request);
    if (mode !== "plan" && !await confirmSensitiveTask(readline, interactive, taskSafety, args.allowSensitive)) {
      process.stdout.write(style.yellow("  Task cancelled before the model was contacted.\n"));
      return false;
    }
    if (ledger.exhausted) {
      process.stdout.write(`${style.red("Budget spent.")} ${ledger.budgetWarning()}\n`);
      return false;
    }
    if (approvedBudget && prices) {
      const spent = ledger.displayTotal?.micros ?? 0;
      const remainingDisplay: Money = { currency: approvedBudget.currency, micros: Math.max(0, approvedBudget.micros - spent) };
      const remainingProvider = convertTo(remainingDisplay, prices.currency, rates);
      if (!remainingProvider) {
        process.stdout.write(`${style.red("Cannot continue safely — the approved cap cannot be converted to the provider currency.")}\n`);
        return false;
      }
      agent.setModelSpendLimit(remainingProvider.micros);
    }
    try {
      process.stdout.write(style.dim(`  ${ledger.formatPrediction(await agent.estimateNextTurn(request))}\n`));
    } catch (error) {
      process.stdout.write(style.yellow(`  Could not estimate this turn: ${error instanceof Error ? error.message : String(error)}\n`));
    }
    const started = Date.now();
    // Per-turn counters, and a clean markdown state: an unclosed code fence from the last answer
    // must not colour this one as code.
    activity.toolCalls = 0;
    activity.tokens = 0;
    activity.phase = "thinking";
    activity.operation = undefined;
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
      });
      // A pinned footer redraws its own fixed row and never needs the erase-above-cursor dance
      // `StatusBar` does — that class stays the renderer for every session without one. The status
      // line uses the full terminal width, not the golden-ratio prose cap: it is one row of UI
      // chrome, not a paragraph, and narrowing it to match reading-width prose would just waste the
      // rest of the row.
      spinner = new Spinner(() => screen
        ? screen!.renderStatus(formatStatusLine(fields(), screen!.current.columns, depth))
        : statusBar.render(fields(), depth));
      spinner.start();
    }
    turnActive = true;
    currentTurnAbort = new AbortController();
    try {
      const result = await agent.send(request);
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
      if (!streamedAnswer) process.stdout.write(`\n${style.dim("✦")} ${style.bold("Nova")}\n`);
      if (result.status !== "completed" && spokenText && !streamedAnswer && !result.summary.includes(spokenText)) {
        process.stdout.write(`\n${asMarkdown(spokenText)}\n`);
      }
      // When the answer streamed, it is already on screen — reprinting it verbatim is noise.
      if (!(result.status === "completed" && streamedAnswer)) {
        process.stdout.write(`\n${result.status === "completed" ? asMarkdown(result.summary) : style.yellow(result.summary)}\n`);
      }

      const turn = ledger.record({
        usage: result.usage,
        iterations: result.iterations,
        toolCalls: result.toolCallsExecuted,
        elapsedMs: Date.now() - started,
      });
      process.stdout.write(style.dim(`\n  ${result.status} · ${ledger.formatTurn(turn)}\n`));
      const warning = ledger.budgetWarning();
      if (warning) process.stdout.write(`  ${style.yellow(warning)}\n`);
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
        process.stdout.write(`\n${style.yellow(`Stopped at the ${formatMoney(fromUnits(args.budget, display))} cap for this request.`)}\n`);
        process.stdout.write(style.dim(`  Raise it with --budget, or ask for something smaller.\n`));
        return false;
      }
      process.stdout.write(`${style.red("error")} ${message}\n`);
      return false;
    } finally {
      turnActive = false;
      currentTurnAbort = undefined;
    }
    return true;
  };

  if (args.prompt) {
    const ran = await runTurn(args.prompt);
    // A one-shot run against a sandbox would otherwise leave the work unreachable, so it is
    // offered back before the sandbox goes away.
    if (ran && workspace.kind === "e2b") {
      const destination = path.resolve(args.root, "nova-pull");
      const pulled = await downloadProject(workspace, destination);
      process.stdout.write(style.dim(`  pulled ${pulled.written.length} files into ${destination}\n`));
    }
    await agent.dispose();
    exitCleanly();
    return ran ? 0 : 1;
  }

  if (!interactive) {
    process.stderr.write(`${style.red("No terminal attached.")} Pass a request as an argument to run a single turn: nova "your request".\n`);
    exitCleanly();
    return 1;
  }

  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);
  process.stdout.write(`${renderBanner({
    width: process.stdout.columns ?? 80,
    depth,
    subtitle: `${mode} · ${spec.label} ${resolvedModelId} · ${where}`,
    // Seeded per session, so the sky is stable while you are looking at it.
    seed: Date.now() & 0xffff,
  })}\n`);
  process.stdout.write(`${renderTagline(`  /help ${controlLabel(language, "help")} · /exit ${controlLabel(language, "exit")} · /voice ${controlLabel(language, "voice")}`, depth)}\n`);
  process.stdout.write(style.dim(`  costs: ${display}${preference.countryCode ? ` · location ${preference.countryCode}` : ""} · ${preference.source === "location" ? "auto-detected" : preference.source}\n`));
  if (localCurrencyWarning) process.stdout.write(`${style.yellow(`  ${localCurrencyWarning}`)}\n`);
  if (!args.budget) process.stdout.write(`${style.yellow("  No session spend cap set — use --budget N to approve and enforce one.")}\n`);
  if (!prices) {
    process.stdout.write(`${style.yellow(`  No price configured for ${resolvedModelId} — costs will show as unknown.`)}\n`);
    process.stdout.write(`${style.dim(`  Set ${PRICE_ENVIRONMENT_HINT}, or run nova --providers.`)}\n`);
  }

  /**
   * The footer goes up after the banner, not before — the banner is the top of the transcript, not
   * chrome that belongs pinned. Only for a real interactive TTY: a one-shot `--prompt` run, a pipe,
   * or `--estimate` prints a few lines and exits, where a scroll region would be pure overhead with
   * nothing to keep separately scrolled from before it is torn down again a moment later.
   */
  if (ttyMode) {
    screen = new PinnedScreen(process.stdout);
    screen.enter();
    screen.renderStatus(idleStatusLine());
    process.stdout.on("resize", () => {
      screen?.resize();
      screen?.renderStatus(idleStatusLine());
    });
  }

  for (;;) {
    screen?.renderStatus(idleStatusLine());
    screen?.positionInput();
    let rawInput: string;
    try {
      const promptLabel = `${style.cyan(mode === "plan" ? "plan" : mode === "auto" ? "auto" : "nova")}${style.dim(" › ")}`;
      rawInput = await readline.question(screen ? promptLabel : `\n${promptLabel}`);
    } catch (error) {
      if (isReadlineExit(error) || exitRequested) break;
      throw error;
    }
    screen?.parkInTranscript();
    let input = rawInput.trim();
    if (!input) continue;

    // The palette resolves to a command and then falls through to the same dispatch a typed one
    // takes. Anything else would be a second place for a command's behaviour to live.
    if (input === "/palette") {
      const chosen = interactive
        ? await openPalette({ readline, input: process.stdin, output: process.stdout, registry: keys })
        : undefined;
      if (!chosen?.trim()) continue;
      input = chosen.trim();
    }

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") { process.stdout.write(helpText(language)); continue; }
    const modeCommand = parseModeCommand(input);
    if (modeCommand?.type === "show") {
      const posture = mode === "plan" ? "read-only; write and command tools are unavailable" : mode === "build" ? "workspace changes ask for approval" : "ordinary workspace changes are pre-approved; sensitive and external actions still ask";
      process.stdout.write(`  ${style.cyan(mode)} · ${style.dim(posture)}\n`);
      continue;
    }
    if (modeCommand?.type === "invalid") {
      process.stdout.write(style.yellow("  Choose /mode plan, /mode build, or /mode auto.\n"));
      continue;
    }
    if (modeCommand?.type === "switch") {
      const requestedMode: NovaMode = modeCommand.mode;
      if (requestedMode === mode) {
        process.stdout.write(style.dim(`  already in ${mode} mode\n`));
        continue;
      }
      mode = requestedMode;
      // A new mode is a new permission posture; the transcript carries over so the plan the agent
      // just produced is still in context when it starts building — Cline's behaviour, and the
      // reason Plan mode is useful rather than a separate conversation.
      const previous = agent;
      await previous.relinquish();
      agent = newAgent();
      const carried = await loadSession(args.root, previous.sessionId);
      if (carried) agent.resume(carried);
      const posture = mode === "plan" ? "read-only; no write tools" : mode === "build" ? "edits and commands require approval" : "ordinary edits and commands are pre-approved; sensitive and external actions require approval";
      process.stdout.write(style.dim(`  switched to ${mode} mode · ${posture}\n`));
      continue;
    }
    if (input.startsWith("/model")) {
      const [, providerArg, modelArg] = input.split(/\s+/);
      const attempt = resolveProvider(environment, { provider: providerArg, model: modelArg });
      if ("error" in attempt) {
        process.stdout.write(`${style.red(attempt.error)}\n`);
        continue;
      }
      model = attempt.provider;
      spec = attempt.spec;
      prices = attempt.prices;
      resolvedModelId = attempt.model;
      ledger.setPrices(prices);
      const previous = agent;
      await previous.relinquish();
      agent = newAgent();
      const carried = await loadSession(args.root, previous.sessionId);
      if (carried) agent.resume(carried);
      process.stdout.write(style.dim(`  switched to ${spec.label} ${resolvedModelId}${prices ? "" : " — no price configured, costs will show as unknown"}\n`));
      continue;
    }
    if (input === "/todos") {
      const todos = agent.todos;
      if (todos.length === 0) { process.stdout.write(style.dim("  no plan yet\n")); continue; }
      const mark = { pending: "○", in_progress: "◐", done: "●" } as const;
      process.stdout.write(`${box(todos.map((todo) => `${mark[todo.status]} ${todo.text}`), { depth, title: "todos" })}\n`);
      continue;
    }
    if (input === "/diff") {
      const stat = await agent.diffStat();
      process.stdout.write(stat ? `${box(stat.split("\n"), { depth, title: "diff" })}\n` : style.dim("  nothing changed since the last checkpoint\n"));
      continue;
    }
    const tabCommand = parseTabCommand(input);
    if (tabCommand) {
      try {
        switch (tabCommand.kind) {
          case "invalid":
            process.stdout.write(style.yellow(`  ${tabCommand.reason}\n`));
            break;
          case "list":
            showTabs();
            if (tabs.size === 1) process.stdout.write(style.dim("  one tab — /tab new opens another\n"));
            break;
          case "new": {
            // Saved before opening, or the tab being left behind keeps the incoming tab's state.
            const leaving = tabs.active;
            leaving.payload.agent = agent;
            leaving.payload.ledger = ledger;
            leaving.payload.mode = mode;
            const opened = tabs.open(tabCommand.title ?? `tab ${tabs.size + 1}`, () => ({ agent: newAgent(), ledger: new CostLedger({ prices, display, rates, catalog: PRICE_CATALOG, ...(approvedBudget ? { budget: approvedBudget } : {}) }), mode }));
            ({ agent, ledger, mode } = opened.payload);
            showTabs();
            break;
          }
          case "next": case "previous": {
            const current = tabs.active;
            current.payload.agent = agent;
            current.payload.ledger = ledger;
            current.payload.mode = mode;
            ({ agent, ledger, mode } = tabs.cycle(tabCommand.kind === "next" ? 1 : -1).payload);
            showTabs();
            break;
          }
          case "select":
            if (!switchTab(tabCommand.id)) process.stdout.write(style.yellow(`  No tab ${tabCommand.id}.\n`));
            else showTabs();
            break;
          case "rename":
            tabs.active.title = tabCommand.title;
            showTabs();
            break;
          case "close": {
            const { closed, nextActive } = tabs.close(tabCommand.id ?? tabs.active.id);
            // The tab is gone from the strip, but its agent may still hold a sandbox open.
            await closed.payload.agent.dispose().catch(() => undefined);
            ({ agent, ledger, mode } = nextActive.payload);
            showTabs();
            break;
          }
        }
      } catch (error) {
        process.stdout.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }

    const wander = parseWanderCommand(input);
    if (wander) {
      if (wander.kind === "invalid") {
        process.stdout.write(style.yellow(`  ${wander.reason}\n`));
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
        process.stdout.write(`  ${style.cyan("scheduled")} — job ${job.id} runs now, then every ${wander.cadence === "daily" ? "day" : "week"} after the last one finishes.\n`);
        process.stdout.write(style.dim(`  /attach ${job.id} to watch it · /jobs cancel ${job.id} to stop it\n`));
        continue;
      }

      // The lab may cite only what the dossier holds, and the agent may have no network at all, so
      // the search happens here — once, before the turn — and the result is written where the
      // protocol says the scout left it.
      process.stdout.write(`  ${style.cyan("wander")} ${style.dim(wander.random ? `picked: ${wander.topic}` : wander.topic)}\n`);
      const evidence = await gatherWanderEvidence(wander.topic, createExaClient(environment));
      if (evidence.expense) ledger.recordExpense(evidence.expense);
      await workspace.writeFile(WANDER_LAB_FILES.evidence, evidence.markdown);
      process.stdout.write(style.dim(`  ${evidence.hits.length} source${evidence.hits.length === 1 ? "" : "s"} → ${WANDER_LAB_FILES.evidence}\n`));
      input = buildWanderPrompt(wander.topic);
    }

    const jobsCommand = parseJobsCommand(input);
    if (jobsCommand) {
      try {
        switch (jobsCommand.kind) {
          case "invalid":
            process.stdout.write(style.yellow(`  ${jobsCommand.reason}\n`));
            break;
          case "list": {
            const jobs = await listJobs(args.root);
            if (jobs.length === 0) {
              process.stdout.write(style.dim("  no background jobs — /jobs run <task>, /detach <task>, or /wander daily to start one\n"));
              break;
            }
            const marker = { queued: "○", running: style.cyan("●"), paused: style.yellow("⏸"), completed: style.green("✓"), failed: style.red("✗"), cancelled: style.dim("⊘") } as const;
            for (const job of jobs) {
              process.stdout.write(`  ${marker[job.status]} ${job.id}  ${job.status.padEnd(9)} ${job.objective}${job.detail ? style.dim(`  — ${job.detail}`) : ""}\n`);
            }
            break;
          }
          case "run": {
            const job = await startBackgroundJob(jobsCommand.objective);
            process.stdout.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
            break;
          }
          case "cancel": {
            // The lease's owner (host:pid) is cleared the instant the store marks the job
            // cancelled, so the pid to signal has to be read before that happens.
            const before = await getJob(args.root, jobsCommand.id);
            const { ok } = await cancelJob(args.root, jobsCommand.id);
            if (!ok) { process.stdout.write(style.yellow(`  No job ${jobsCommand.id} to cancel — it may already be finished.\n`)); break; }
            const pid = Number(before?.lease?.workerId.split(":").pop());
            if (Number.isInteger(pid)) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
            process.stdout.write(`  cancelled ${jobsCommand.id}.\n`);
            break;
          }
          case "approve": {
            const ok = await resolveJobApproval(args.root, jobsCommand.id, jobsCommand.decision);
            process.stdout.write(ok ? `  delivered — the worker will pick it up shortly.\n` : style.yellow(`  ${jobsCommand.id} has no pending approval.\n`));
            break;
          }
        }
      } catch (error) {
        process.stdout.write(style.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
      }
      continue;
    }

    const detachCommand = parseDetachCommand(input);
    if (detachCommand) {
      if (detachCommand.kind === "invalid") {
        process.stdout.write(style.yellow(`  ${detachCommand.reason}\n`));
        continue;
      }
      const job = await startBackgroundJob(detachCommand.objective);
      process.stdout.write(`  ${style.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
      continue;
    }

    const attachCommand = parseAttachCommand(input);
    if (attachCommand) {
      if (attachCommand.kind === "invalid") {
        process.stdout.write(style.yellow(`  ${attachCommand.reason}\n`));
        continue;
      }
      const first = await getJob(args.root, attachCommand.id);
      if (!first) {
        process.stdout.write(style.yellow(`  No job ${attachCommand.id}. /jobs lists what exists.\n`));
        continue;
      }
      process.stdout.write(style.dim(`  attached to ${attachCommand.id} — Ctrl+C returns to the prompt without stopping it\n`));
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
          if (chunk.text) process.stdout.write(chunk.text);
          offset = chunk.nextByte;
          if (detachView) break;
          const current = await getJob(args.root, attachCommand.id);
          if (!current) break;
          if (current.pendingApproval) {
            const answer = (await readline.question(`  ${style.yellow("approval needed:")} ${current.pendingApproval.summary} [y/N]: `)).trim().toLowerCase();
            await resolveJobApproval(args.root, attachCommand.id, answer === "y" || answer === "yes" ? "allow" : "deny");
            continue;
          }
          if (isTerminal(current.status)) { process.stdout.write(style.dim(`  job ${current.status}\n`)); break; }
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
      process.stdout.write(`${keys.render()}\n\n${renderKeyboardShortcuts(language)}\n`);
      continue;
    }
    if (input === "/undo") {
      const restored = await agent.undo();
      process.stdout.write(restored ? style.green(`  reverted to "${restored.label}"\n`) : style.yellow("  nothing to undo\n"));
      continue;
    }
    if (input === "/clear") {
      await agent.relinquish();
      agent = newAgent();
      process.stdout.write(style.dim("  new thread\n"));
      continue;
    }
    if (input.startsWith("/pull")) {
      if (workspace.kind !== "e2b") { process.stdout.write(style.yellow("  already working locally — nothing to pull\n")); continue; }
      const destination = path.resolve(args.root, input.split(/\s+/)[1] ?? "nova-pull");
      const pulled = await downloadProject(workspace, destination);
      process.stdout.write(style.green(`  pulled ${pulled.written.length} files into ${destination}\n`));
      if (pulled.failed.length > 0) process.stdout.write(style.yellow(`  ${pulled.failed.length} could not be read\n`));
      continue;
    }
    if (input === "/providers") {
      process.stdout.write(`${renderProviders(environment, depth)}\n`);
      continue;
    }
    if (input === "/settings") {
      let nextSettings: NovaSettings;
      try {
        nextSettings = await runSettingsMenu(savedSettings, {
          ask: (question) => readline.question(question),
          askSecret: (question) => hiddenQuestion(readline, question),
          write: (text) => process.stdout.write(text),
        });
      } catch (error) {
        if (!isReadlineExit(error)) throw error;
        process.stdout.write(style.dim("\n  settings cancelled — no changes were saved\n"));
        if (exitRequested) break;
        continue;
      }
      savedSettings = nextSettings;
      const file = await saveSettings(savedSettings, processEnvironment);
      for (const field of SETTING_FIELDS) delete environment[field.key];
      Object.assign(environment, mergedEnvironment(savedSettings, processEnvironment));
      language = resolveControlLanguage(args.language ?? environment.NOVA_LANGUAGE ?? environment.LANG);
      const previous = agent;
      const carried = await loadSession(args.root, previous.sessionId);
      await previous.relinquish();
      agent = newAgent();
      if (carried) agent.resume(carried);
      process.stdout.write(style.green(`  settings saved to ${file}\n`));
      process.stdout.write(style.dim(`  Settings are active now${environment.EXA_API_KEY?.trim() ? "; Exa web_search is available" : ""}. Use /model only to change the selected model.\n`));
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
        process.stdout.write(style.dim("  transcribing…\n"));
        let transcript = await transcribeAudio(audioFile, environment);
        process.stdout.write(`${box(transcript.split("\n"), { depth, title: "voice transcript" })}\n`);
        const decision = (await readline.question("  Send this prompt? [Y/n/e to edit]: ")).trim().toLowerCase();
        if (decision === "n" || decision === "no") continue;
        if (decision === "e" || decision === "edit") transcript = (await readline.question("  Edit prompt: ")).trim() || transcript;
        await runTurn(transcript);
      } catch (error) {
        process.stdout.write(style.red(`  Voice input failed: ${error instanceof Error ? error.message : String(error)}\n`));
      } finally {
        if (temporary && audioFile) await removeRecording(audioFile).catch(() => undefined);
      }
      continue;
    }
    if (input === "/cost") {
      process.stdout.write(`${ledger.formatReport()}\n`);
      continue;
    }
    if (input === "/where") {
      process.stdout.write(`  ${workspace.kind === "e2b" ? style.yellow(workspace.label) : style.dim(workspace.label)}\n`);
      continue;
    }
    if (input === "/sessions") {
      for (const session of await listSessions(args.root)) {
        process.stdout.write(`  ${style.cyan(session.id)}  ${session.title}\n`);
      }
      continue;
    }

    if (input.startsWith("/") && !isKnownCommand(input.split(/\s+/)[0])) {
      // Without this the typo is simply sent to the model, which costs a round trip to be told
      // it makes no sense.
      const name = input.split(/\s+/)[0];
      const suggestion = suggestCommand(name);
      process.stdout.write(`  ${style.yellow(`Unknown command ${name}.`)}${style.dim(suggestion ? ` Did you mean ${suggestion}?` : " Type /help for the list.")}\n`);
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
      agent = newAgent();
      const id = newJobId();
      const job = await enqueueJob(args.root, { id, objective: `Continue: ${input}`, logPath: jobLogPath(args.root, id), sessionId });
      await spawnJobWorker(args.root, job.id);
      process.stdout.write(`  ${style.cyan("sent to background")} — job ${job.id} continues it. /attach ${job.id} to watch.\n`);
    }
  }

  await agent.dispose();
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
