#!/usr/bin/env bun
import { createInterface, type Interface } from "node:readline/promises";
import path from "node:path";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { NovaAgent, type NovaEvent } from "circuit-nova-core/nova-cli/agent";
import type { NovaMode, PermissionDecision } from "circuit-nova-core/nova-cli/permissions";
import { listSessions, loadSession } from "circuit-nova-core/nova-cli/session";
import { describeProviders, PRICE_ENVIRONMENT_HINT, PROVIDER_IDS, resolveProvider } from "circuit-nova-core/providers/agent-matrix";
import { fromUnits, formatMoney, isCurrency, type Currency, type FxRate } from "circuit-nova-core/money";
import { createExaClient } from "circuit-nova-core/providers/exa";
import { downloadProject, E2BWorkspace, LocalWorkspace, uploadProject, type NovaWorkspace } from "circuit-nova-core/nova-cli/backends";
import { CostLedger } from "circuit-nova-core/nova-cli/cost";
import { detectColorDepth, renderBanner, renderTagline } from "./banner";

/**
 * Nova CLI — the terminal front end.
 *
 * Everything that decides what the agent may do lives in `lib/nova-cli`; this file only reads
 * input, renders output, and asks the human when the agent needs permission. Keeping the boundary
 * there is what allows a second front end (an editor extension, an HTTP server in OpenCode's
 * shape) to be added later without re-litigating any of the safety behaviour.
 */

const RESET = "[0m";
const style = {
  dim: (value: string) => `[2m${value}${RESET}`,
  bold: (value: string) => `[1m${value}${RESET}`,
  cyan: (value: string) => `[36m${value}${RESET}`,
  green: (value: string) => `[32m${value}${RESET}`,
  yellow: (value: string) => `[33m${value}${RESET}`,
  red: (value: string) => `[31m${value}${RESET}`,
};

type ParsedArgs = {
  mode: NovaMode;
  prompt: string | null;
  resume: string | null;
  listSessions: boolean;
  listProviders: boolean;
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
};

/** Shape of the ids `newSessionId` mints, e.g. `20260808T001720Z-2ubjpz`. */
const SESSION_ID = /^\d{8}T\d{6}Z-[a-z0-9]{6}$/;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    mode: "build", prompt: null, resume: null, listSessions: false, listProviders: false, root: process.cwd(), help: false,
    backend: "local", upload: false, preset: undefined, sandboxMinutes: 30, budget: undefined, provider: undefined, model: undefined, currency: undefined,
  };
  const rest: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--plan" || argument === "-p") parsed.mode = "plan";
    else if (argument === "--auto" || argument === "-y") parsed.mode = "auto";
    else if (argument === "--build") parsed.mode = "build";
    else if (argument === "--help" || argument === "-h") parsed.help = true;
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
    else rest.push(argument);
  }
  if (rest.length > 0) parsed.prompt = rest.join(" ");
  return parsed;
}

const HELP = `
${style.bold("nova")} — a coding agent in your terminal

  nova                      Start an interactive session
  nova "add a health check" Run one request and exit
  nova --plan               Plan mode: read and reason, never write
  nova --auto               Auto mode: edits apply without per-call approval
  nova --resume [id]        Continue a previous session ("latest" by default)
  nova --sessions           List sessions in this project
  nova --cwd <dir>          Work in a different project root

${style.bold("Where the files go")}
  nova --sandbox            Work in a remote E2B sandbox, not on this machine
  nova --sandbox --upload   ...seeded with a copy of this project
  nova --image <preset>     Sandbox image to use (default: general)
  nova --sandbox-minutes N  Sandbox lifetime (default 30)

${style.bold("Model")}
  nova --provider <name>    ${PROVIDER_IDS.join(" | ")}
  nova --model <id>         Model to run (defaults to the provider's)
  nova --providers          Show which providers are configured, and what is missing

${style.bold("Cost")}
  nova --currency RWF|USD   Currency to display costs in
  nova --budget N           Stop before spending more than N (display currency)
  /cost                     Token and cost breakdown for this session

${style.bold("In a session")}
  /plan /build /auto        Switch mode          /undo     Revert the last turn
  /clear                    Start a fresh thread /sessions List sessions
  /pull [dir]               Copy sandbox files here  /where  Show the workspace
  /cost                     What this session has cost
  /providers                Which providers are configured
  /exit                     Leave               Ctrl-C    Interrupt the current turn
`;

/**
 * Tracks whether the cursor is sitting mid-line inside streamed assistant text.
 *
 * Deltas arrive without newlines, so anything printed afterwards — a tool line, a status line —
 * would land on the same row and corrupt both. Every other writer closes the stream line first.
 */
let streaming = false;

function endStreamedLine(): void {
  if (!streaming) return;
  process.stdout.write("\n");
  streaming = false;
}

function renderEvent(event: NovaEvent): void {
  if (event.type === "runtime" && event.event.type === "assistant_delta") {
    // Written straight through as it is generated: this is the difference between a session that
    // looks stalled for twenty seconds and one you can read while it thinks.
    process.stdout.write(event.event.text);
    streaming = true;
    return;
  }
  endStreamedLine();
  if (event.type === "checkpoint") {
    process.stdout.write(style.dim(`  ⎿ checkpoint ${event.checkpoint.tree.slice(0, 8)}\n`));
    return;
  }
  if (event.type === "compaction") {
    process.stdout.write(style.dim(`  ⎿ compacted context (${event.messagesBefore} → ${event.messagesAfter} messages)\n`));
    return;
  }
  const runtime = event.event;
  if (runtime.type === "model_turn" && runtime.toolCallCount > 0) {
    process.stdout.write(style.dim(`  ⎿ thinking (${runtime.toolCallCount} tool call${runtime.toolCallCount === 1 ? "" : "s"})\n`));
  }
  if (runtime.type === "tool_result") {
    const mark = runtime.isError ? style.red("✗") : style.green("✓");
    const firstLine = runtime.content.split("\n")[0]?.slice(0, 96) ?? "";
    process.stdout.write(`  ${mark} ${style.cyan(runtime.toolName)} ${style.dim(firstLine)}\n`);
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
  const rate = Number(environment.NOVA_FX_RWF_PER_USD);
  if (!Number.isFinite(rate) || rate <= 0) return [];
  return [{
    from: "USD",
    to: "RWF",
    rate,
    asOf: environment.NOVA_FX_ASOF?.trim() || new Date().toISOString().slice(0, 10),
    source: environment.NOVA_FX_SOURCE?.trim() || "NOVA_FX_RWF_PER_USD",
  }];
}

/** The approval gate, as a person experiences it. */
function createApprovalPrompt(readline: Interface, interactive: boolean) {
  return async ({ summary }: { summary: string }): Promise<PermissionDecision> => {
    // Without a terminal there is nobody to ask, and a prompt written to a pipe would either hang
    // or read the next line of piped input as an answer. Denying is the only honest result — and
    // it is reported, so the run does not look like the model simply chose not to act.
    if (!interactive) {
      process.stdout.write(`\n  ${style.yellow("!")} Nova needs approval to ${style.bold(summary)}, but stdin is not a terminal.\n`);
      process.stdout.write(`    ${style.dim("Re-run with --auto to pre-approve workspace edits.")}\n`);
      return "deny_always";
    }
    endStreamedLine();
    process.stdout.write(`\n  ${style.yellow("?")} Nova wants to ${style.bold(summary)}\n`);
    const answer = (await readline.question(`    ${style.dim("[y]es / [n]o / [a]lways / [d]eny always: ")}`)).trim().toLowerCase();
    if (answer === "a" || answer === "always") return "allow_always";
    if (answer === "d") return "deny_always";
    if (answer === "n" || answer === "no") return "deny";
    return answer === "" || answer === "y" || answer === "yes" ? "allow" : "deny";
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.listProviders) {
    process.stdout.write(`${renderProviders(process.env as Record<string, string | undefined>, detectColorDepth(process.env as Record<string, string | undefined>, Boolean(process.stdout.isTTY)))}\n`);
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

  const environment = process.env as Record<string, string | undefined>;
  const resolved = resolveProvider(environment, { provider: args.provider, model: args.model });
  if ("error" in resolved) {
    process.stderr.write(`${style.red("Nova is not configured.")} ${resolved.error}\n`);
    return 1;
  }
  const { provider: model, spec, prices } = resolved;

  // Display currency: the flag, then configuration, then the provider's own currency — so a cost
  // is never silently restated in a unit the user did not choose.
  const display: Currency = args.currency ?? (isCurrency(environment.NOVA_CURRENCY?.trim().toUpperCase() ?? "") ? environment.NOVA_CURRENCY!.trim().toUpperCase() as Currency : prices?.currency ?? "USD");
  const rates = readFxRates(environment);

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const interactive = Boolean(process.stdin.isTTY);
  let mode = args.mode;

  // Built once and shared by every agent instance in this process: a mode switch or /clear must
  // keep working in the same sandbox, not silently start a second one and lose the first's files.
  let workspace: NovaWorkspace;
  if (args.backend === "e2b") {
    // Imported here, not at the top: a local-only session should never load the E2B SDK, which is
    // what lets the published package treat it as an optional dependency.
    const { findWorkspacePreset } = await import("circuit-nova-core/sandbox-templates");
    const { createE2BProvider } = await import("circuit-nova-core/providers/factory");
    const preset = findWorkspacePreset(args.preset);
    const sandbox = createE2BProvider(environment, preset.templateAlias);
    if (!sandbox) {
      process.stderr.write(`${style.red("Remote sandboxes need E2B.")} Set E2B_API_KEY (and E2B_CODING_TEMPLATE for a custom image).\n`);
      readline.close();
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

  const ledger = new CostLedger({
    prices,
    display,
    rates,
    ...(args.budget ? { budget: fromUnits(args.budget, display) } : {}),
  });
  const newAgent = () => new NovaAgent({
    root: args.root,
    model,
    // The runtime keeps its own integer-unit ceiling as a runaway guard; the ledger below owns the
    // real, currency-aware budget. Feeding it the provider's own per-million rates keeps that guard
    // proportionate to actual spend instead of to a unit nobody configured.
    prices: prices
      ? { inputRwfPerMillionTokens: Math.max(1, Math.round(prices.inputPerMillion / 1_000_000)), outputRwfPerMillionTokens: Math.max(1, Math.round(prices.outputPerMillion / 1_000_000)) }
      : { inputRwfPerMillionTokens: 1, outputRwfPerMillionTokens: 1 },
    mode,
    workspace,
    approve: createApprovalPrompt(readline, interactive),
    search: createExaClient(environment),
    onEvent: (event: NovaEvent) => {
      if (event.type === "runtime" && event.event.type === "assistant_delta") streamedAnswer = true;
      renderEvent(event);
    },

  });
  let agent = newAgent();

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
  process.on("SIGINT", () => {
    agent.cancel();
    process.stdout.write(style.yellow("\n  interrupted — finishing the current tool call\n"));
  });

  let streamedAnswer = false;
  const runTurn = async (request: string): Promise<void> => {
    streamedAnswer = false;
    if (ledger.exhausted) {
      process.stdout.write(`${style.red("Budget spent.")} ${ledger.budgetWarning()}\n`);
      return;
    }
    const started = Date.now();
    try {
      const result = await agent.send(request);
      endStreamedLine();

      // On a non-completed status the runtime's summary explains the *stop*, not the work — so
      // printing it alone throws away everything the agent actually said. Observed on a real run
      // that wrote a working script: the answer vanished behind "needs verification".
      const spoken = [...result.messages].reverse().find(
        (message) => message.role === "assistant" && !("toolCalls" in message) && message.content.trim(),
      );
      if (result.status !== "completed" && spoken) process.stdout.write(`\n${spoken.content.trim()}\n`);
      // When the answer streamed, it is already on screen — reprinting it verbatim is noise.
      if (!(result.status === "completed" && streamedAnswer)) {
        process.stdout.write(`\n${result.status === "completed" ? result.summary : style.yellow(result.summary)}\n`);
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
    } catch (error) {
      endStreamedLine();
      const message = error instanceof Error ? error.message : String(error);
      // The runtime enforces the cap by throwing, which on its own reaches the user as a bare
      // internal sentence: no amount, no cap, no way forward. Name it for what it is.
      if (/exceeds the reserved model budget/i.test(message) && args.budget) {
        process.stdout.write(`\n${style.yellow(`Stopped at the ${formatMoney(fromUnits(args.budget, display))} cap for this request.`)}\n`);
        process.stdout.write(style.dim(`  Raise it with --budget, or ask for something smaller.\n`));
        return;
      }
      process.stdout.write(`${style.red("error")} ${message}\n`);
    }
  };

  if (args.prompt) {
    await runTurn(args.prompt);
    // A one-shot run against a sandbox would otherwise leave the work unreachable, so it is
    // offered back before the sandbox goes away.
    if (workspace.kind === "e2b") {
      const destination = path.resolve(args.root, "nova-pull");
      const pulled = await downloadProject(workspace, destination);
      process.stdout.write(style.dim(`  pulled ${pulled.written.length} files into ${destination}\n`));
    }
    await agent.dispose();
    readline.close();
    return 0;
  }

  if (!interactive) {
    process.stderr.write(`${style.red("No terminal attached.")} Pass a request as an argument to run a single turn: nova "your request".\n`);
    readline.close();
    return 1;
  }

  const depth = detectColorDepth(environment, Boolean(process.stdout.isTTY));
  const where = workspace.kind === "e2b" ? `sandbox ${workspace.label.split(":")[1]}` : path.basename(args.root);
  process.stdout.write(`${renderBanner({
    width: process.stdout.columns ?? 80,
    depth,
    subtitle: `${mode} · ${spec.label} ${resolved.model} · ${where}`,
    // Seeded per session, so the sky is stable while you are looking at it.
    seed: Date.now() & 0xffff,
  })}\n`);
  process.stdout.write(`${renderTagline("  /help for commands · /exit to leave", depth)}\n`);
  if (!prices) {
    process.stdout.write(`${style.yellow(`  No price configured for ${resolved.model} — costs will show as unknown.`)}\n`);
    process.stdout.write(`${style.dim(`  Set ${PRICE_ENVIRONMENT_HINT}, or run nova --providers.`)}\n`);
  }

  for (;;) {
    const input = (await readline.question(`\n${style.cyan(mode === "plan" ? "plan" : mode === "auto" ? "auto" : "nova")}${style.dim(" › ")}`)).trim();
    if (!input) continue;

    if (input === "/exit" || input === "/quit") break;
    if (input === "/help") { process.stdout.write(HELP); continue; }
    if (input === "/plan" || input === "/build" || input === "/auto") {
      mode = input.slice(1) as NovaMode;
      // A new mode is a new permission posture; the transcript carries over so the plan the agent
      // just produced is still in context when it starts building — Cline's behaviour, and the
      // reason Plan mode is useful rather than a separate conversation.
      const previous = agent;
      agent = newAgent();
      const carried = await loadSession(args.root, previous.sessionId);
      if (carried) agent.resume(carried);
      process.stdout.write(style.dim(`  switched to ${mode} mode\n`));
      continue;
    }
    if (input === "/undo") {
      const restored = await agent.undo();
      process.stdout.write(restored ? style.green(`  reverted to "${restored.label}"\n`) : style.yellow("  nothing to undo\n"));
      continue;
    }
    if (input === "/clear") {
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

    await runTurn(input);
  }

  await agent.dispose();
  readline.close();
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
