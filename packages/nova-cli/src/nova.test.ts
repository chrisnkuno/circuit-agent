import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Interface } from "node:readline/promises";
import { visibleWidth } from "./markdown";
import {
  configureRendering,
  confirmSensitiveTask,
  confirmSpendingCap,
  createApprovalPrompt,
  isReadlineExit,
  parseArgs,
  readFxRates,
  renderEvent,
  renderProviders,
  renderUserMessage,
} from "./nova";

const ESCAPE = /\x1b\[[0-9;]*m/g;
const plain = (value: string) => value.replace(/\[[0-9;]*m/g, "");

/** Captures every `process.stdout.write` call as plain (colour-stripped) strings. */
function captureStdout(): { writes: string[]; restore: () => void } {
  const writes: string[] = [];
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    writes.push(plain(String(chunk)));
    return true;
  });
  return { writes, restore: () => spy.mockRestore() };
}

describe("argument parsing", () => {
  it("defaults to a local build-mode session in the working directory", () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ mode: "build", backend: "local", prompt: null, upload: false });
    expect(args.modeExplicit).toBe(false);
    expect(args.root).toBe(process.cwd());
  });

  it("reads the mode flags, including their short forms", () => {
    expect(parseArgs(["--plan"]).mode).toBe("plan");
    expect(parseArgs(["-p"]).mode).toBe("plan");
    expect(parseArgs(["--auto"]).mode).toBe("auto");
    expect(parseArgs(["-y"]).mode).toBe("auto");
    expect(parseArgs(["--build"]).mode).toBe("build");
    expect(parseArgs(["--defender"])).toMatchObject({ mode: "defender", modeExplicit: true });
  });

  it("takes --json and its --headless alias, and keeps the request intact", () => {
    expect(parseArgs([]).json).toBe(false);
    expect(parseArgs(["--json", "fix", "the", "tests"])).toMatchObject({ json: true, prompt: "fix the tests" });
    expect(parseArgs(["--headless", "ship", "it"])).toMatchObject({ json: true, prompt: "ship it" });
    // Composes with the mode flags rather than replacing them — a headless run still has a mode.
    expect(parseArgs(["--json", "--auto", "go"])).toMatchObject({ json: true, mode: "auto", prompt: "go" });
  });

  it("accepts doctor as a command and emits an optional support report", () => {
    expect(parseArgs(["doctor"])).toMatchObject({ doctor: true, doctorReport: false, prompt: null });
    expect(parseArgs(["doctor", "--report"])).toMatchObject({ doctor: true, doctorReport: true, prompt: null });
    expect(parseArgs(["--doctor", "--report"])).toMatchObject({ doctor: true, doctorReport: true, prompt: null });
  });

  it("treats every non-flag word as the request, so quoting is optional", () => {
    expect(parseArgs(["fix", "the", "failing", "test"]).prompt).toBe("fix the failing test");
    expect(parseArgs(["--plan", "why", "is", "it", "slow"])).toMatchObject({ mode: "plan", prompt: "why is it slow" });
  });

  it("takes the sandbox flag with or without an explicit backend", () => {
    expect(parseArgs(["--sandbox"]).backend).toBe("e2b");
    expect(parseArgs(["--sandbox", "e2b"]).backend).toBe("e2b");
    expect(parseArgs(["--sandbox", "local"]).backend).toBe("local");
    // A bare --sandbox followed by the request must not eat the request as its value.
    expect(parseArgs(["--sandbox", "write", "a", "test"])).toMatchObject({ backend: "e2b", prompt: "write a test" });
  });

  it("selects the local Docker backend, which was previously unreachable from the CLI", () => {
    expect(parseArgs(["--sandbox", "docker"]).backend).toBe("docker");
    // Still defaults to E2B when bare, so the existing meaning of --sandbox is unchanged.
    expect(parseArgs(["--sandbox"]).backend).toBe("e2b");
    // And a bare --sandbox before a request must not swallow the request as its value.
    expect(parseArgs(["--sandbox", "docker", "write", "a", "test"])).toMatchObject({ backend: "docker", prompt: "write a test" });
  });

  it("takes a docker image from the flag, and otherwise has a usable default", () => {
    expect(parseArgs(["--sandbox", "docker", "--docker-image", "node:22-slim"]).dockerImage).toBe("node:22-slim");
    expect(parseArgs(["--sandbox", "docker"]).dockerImage).toBeTruthy();
  });

  it("reads the pace flag, bare or with a level, without eating the request", () => {
    expect(parseArgs([]).pace).toBe("off");
    expect(parseArgs(["--slow"]).pace).toBe("gentle");
    expect(parseArgs(["--pace", "strict"]).pace).toBe("strict");
    expect(parseArgs(["--slow", "off"]).pace).toBe("off");
    // A bare --slow before a request must not swallow the first word as its level.
    expect(parseArgs(["--slow", "fix", "the", "tests"])).toMatchObject({ pace: "gentle", prompt: "fix the tests" });
  });

  it("takes the ASCII flag under both of its names, for terminals that cannot draw the glyphs", () => {
    expect(parseArgs([]).ascii).toBe(false);
    expect(parseArgs(["--ascii"]).ascii).toBe(true);
    expect(parseArgs(["--no-unicode"]).ascii).toBe(true);
  });

  it("parses provider, model, currency and budget", () => {
    const args = parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5", "--currency", "usd", "--budget", "25"]);
    expect(args).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", currency: "USD", budget: 25 });
  });

  it("accepts supported ISO currencies and ignores values it cannot honour", () => {
    expect(parseArgs(["--currency", "EUR"]).currency).toBe("EUR");
    expect(parseArgs(["--currency", "NOPE"]).currency).toBeUndefined();
    expect(parseArgs(["--currency", "rwf"]).currency).toBe("RWF");
  });

  it("accepts an explicit country for automatic currency selection", () => {
    expect(parseArgs(["--location", "eg"])).toMatchObject({ country: "EG" });
  });

  it("keeps --max-rwf working as the old name for --budget", () => {
    expect(parseArgs(["--max-rwf", "500"]).budget).toBe(500);
  });

  it("resolves --cwd to an absolute path", () => {
    expect(parseArgs(["--cwd", "."]).root).toBe(process.cwd());
  });

  it("reads --resume with and without an explicit session id", () => {
    expect(parseArgs(["--resume"]).resume).toBe("latest");
    expect(parseArgs(["--resume", "20260808T000000Z-abc123"]).resume).toBe("20260808T000000Z-abc123");
    // The request must never be mistaken for a session id — that silently resumes nothing and
    // then drops into the REPL with the user's actual request thrown away.
    expect(parseArgs(["--resume", "keep", "going"])).toMatchObject({ resume: "latest", prompt: "keep going" });
    expect(parseArgs(["--resume", "fix the failing test"])).toMatchObject({ resume: "latest", prompt: "fix the failing test" });
  });

  it("bounds the sandbox lifetime flag and the image preset", () => {
    expect(parseArgs(["--sandbox-minutes", "45"]).sandboxMinutes).toBe(45);
    expect(parseArgs(["--image", "python-data"]).preset).toBe("python-data");
    expect(parseArgs([]).sandboxMinutes).toBe(30);
  });

  it("recognises the informational flags", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
    expect(parseArgs(["--sessions"]).listSessions).toBe(true);
    expect(parseArgs(["--providers"]).listProviders).toBe(true);
    expect(parseArgs(["--doctor"]).doctor).toBe(true);
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("parses model-free history subcommands without turning them into prompts", () => {
    expect(parseArgs(["history"])).toMatchObject({ historyCommand: { kind: "list" }, prompt: null });
    expect(parseArgs(["history", "search", "payment", "retry"])).toMatchObject({ historyCommand: { kind: "search", query: "payment retry" }, prompt: null });
    expect(parseArgs(["history", "status", "--cwd", "."])).toMatchObject({ historyCommand: { kind: "status" }, prompt: null, root: process.cwd() });
  });

  it("recognises both self-update entry forms and their safe controls", () => {
    expect(parseArgs(["update"])).toMatchObject({ update: true, checkUpdate: false, updateYes: false, prompt: null });
    expect(parseArgs(["--update", "--yes", "--package-manager", "pnpm"])).toMatchObject({
      update: true,
      updateYes: true,
      packageManager: "pnpm",
      prompt: null,
    });
    expect(parseArgs(["update", "--check"])).toMatchObject({ update: true, checkUpdate: true, prompt: null });
    expect(parseArgs(["--check-update"])).toMatchObject({ update: true, checkUpdate: true, prompt: null });
  });

  it("recognises settings, localized controls and cost-only estimation", () => {
    expect(parseArgs(["settings"])).toMatchObject({ settings: true, prompt: null });
    expect(parseArgs(["--estimate", "fix", "tests"])).toMatchObject({ estimateOnly: true, prompt: "fix tests" });
    expect(parseArgs(["--language", "ar", "help"])).toMatchObject({ language: "ar", prompt: "help" });
    expect(parseArgs(["--auto", "--allow-sensitive", "deploy to production"])).toMatchObject({ mode: "auto", allowSensitive: true, prompt: "deploy to production" });
  });
});

describe("exchange rates", () => {
  it("reads a configured rate and records where it came from", () => {
    const rates = readFxRates({ NOVA_FX_RWF_PER_USD: "1320", NOVA_FX_ASOF: "2026-08-08", NOVA_FX_SOURCE: "BNR" });
    expect(rates).toEqual([{ from: "USD", to: "RWF", rate: 1_320, asOf: "2026-08-08", source: "BNR" }]);
  });

  it("dates an undated rate to today rather than leaving it unattributable", () => {
    const rates = readFxRates({ NOVA_FX_RWF_PER_USD: "1300" });
    expect(rates[0].asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rates[0].source).toBe("NOVA_FX_RWF_PER_USD");
  });

  it("returns no rate at all for missing or nonsensical configuration", () => {
    // No rate means costs stay in the provider's currency — better than a guessed conversion.
    expect(readFxRates({})).toEqual([]);
    expect(readFxRates({ NOVA_FX_RWF_PER_USD: "0" })).toEqual([]);
    expect(readFxRates({ NOVA_FX_RWF_PER_USD: "-5" })).toEqual([]);
    expect(readFxRates({ NOVA_FX_RWF_PER_USD: "not-a-number" })).toEqual([]);
  });

  it("supports an auditable manual rate for any currency pair", () => {
    expect(readFxRates({ NOVA_FX_FROM: "USD", NOVA_FX_TO: "EGP", NOVA_FX_RATE: "48.5", NOVA_FX_ASOF: "2026-08-08" })[0]).toEqual({
      from: "USD", to: "EGP", rate: 48.5, asOf: "2026-08-08", source: "NOVA_FX_RATE",
    });
  });
});

describe("the message echoed into the transcript", () => {
  it("labels the bubble with the speaker and keeps the text inside it", () => {
    const rendered = plain(renderUserMessage("ship the release", "none", 40));
    const [top, ...rest] = rendered.split("\n");
    expect(top).toContain("you");
    expect(rest.join(" ")).toContain("ship the release");
  });

  it("wraps a long message rather than letting one line run past the border", () => {
    const rendered = plain(renderUserMessage("word ".repeat(60).trim(), "none", 40));
    const lines = rendered.split("\n");
    expect(lines.length).toBeGreaterThan(3); // top border, several body rows, bottom border
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(40);
  });

  it("stays inside the width it is given, at any width and for any message", () => {
    // The bubble is printed into the transcript region of a pinned screen. A line wider than the
    // terminal wraps, which scrolls the region by a row the caller did not account for.
    for (const width of [20, 40, 80, 120]) {
      for (const text of ["hi", "a".repeat(300), "日本語のメッセージです", "one two three four five six seven"]) {
        for (const line of renderUserMessage(text, "none", width).split("\n")) {
          expect(visibleWidth(plain(line)), `width ${width}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it("emits colour only when colour was asked for", () => {
    expect(renderUserMessage("hello", "none", 40)).not.toMatch(ESCAPE);
    expect(renderUserMessage("hello", "truecolor", 40)).toMatch(ESCAPE);
  });

  it("draws the corners the active theme's border style asks for, not a fixed shape", () => {
    expect(renderUserMessage("hi", "none", 40, undefined, "round")).toContain("╭");
    expect(renderUserMessage("hi", "none", 40, undefined, "single")).toContain("┌");
    expect(renderUserMessage("hi", "none", 40, undefined, "double")).toContain("╔");
  });
});

describe("provider status view", () => {
  it("names the exact variable that would make an unconfigured provider work", () => {
    const rendered = plain(renderProviders({}, "none"));
    expect(rendered).toContain("set ANTHROPIC_API_KEY");
    expect(rendered).toContain("set OPENAI_API_KEY");
    expect(rendered).toContain("set CIRCUITNOTION_API_KEY");
  });

  it("shows a configured provider with its model and where its price came from", () => {
    const rendered = plain(renderProviders({ ANTHROPIC_API_KEY: "sk-ant" }, "none"));
    expect(rendered).toContain("claude-sonnet-5 · pricing: catalog");
    expect(rendered).not.toContain("set ANTHROPIC_API_KEY");
  });

  it("explains an unpriced-but-working provider, which is otherwise baffling", () => {
    // OpenAI's catalog is deliberately unverified here — unlike CircuitNotion, which ships a real
    // RWF rate card from the operator, a scraped OpenAI list price risks being confidently wrong.
    const rendered = plain(renderProviders({ OPENAI_API_KEY: "k", OPENAI_MODEL: "gpt-5.6-terra" }, "none"));
    expect(rendered).toContain("pricing: unknown");
    expect(rendered).toContain("costs show as unknown");
    expect(rendered).toContain("MODEL_INPUT_PER_MILLION");
  });

  it("prices CircuitNotion from its own RWF catalog, not just a working credential", () => {
    const rendered = plain(renderProviders({ CIRCUITNOTION_API_KEY: "k", CIRCUITNOTION_MODEL: "gpt-5.6-luna" }, "none"));
    expect(rendered).toContain("gpt-5.6-luna · pricing: catalog");
  });

  it("stops nagging about the exchange rate once one is configured", () => {
    expect(plain(renderProviders({ ANTHROPIC_API_KEY: "k" }, "none"))).toContain("NOVA_FX_RWF_PER_USD");
    expect(plain(renderProviders({ ANTHROPIC_API_KEY: "k", NOVA_FX_RWF_PER_USD: "1320" }, "none"))).not.toContain("Set NOVA_FX_RWF_PER_USD");
  });

  it("emits no escape codes when colour is unwanted", () => {
    const rendered = renderProviders({ ANTHROPIC_API_KEY: "k" }, "none");
    expect(rendered).not.toMatch(/\[/);
  });

  it("shows whether Exa-backed web search is available", () => {
    expect(plain(renderProviders({}, "none"))).toContain("set EXA_API_KEY");
    expect(plain(renderProviders({ EXA_API_KEY: "exa-test" }, "none"))).toContain("web_search enabled");
  });
});

describe("clean terminal exit", () => {
  it("classifies Ctrl-D and a closed readline as normal exits", () => {
    const ctrlD = new Error("Aborted with Ctrl+D"); ctrlD.name = "AbortError";
    expect(isReadlineExit(ctrlD)).toBe(true);
    expect(isReadlineExit(new Error("readline was closed"))).toBe(true);
    expect(isReadlineExit(new Error("provider failed"))).toBe(false);
  });
});

describe("renderEvent", () => {
  // The renderer owns one screen, so its markdown and tool-line state is module-level. Rebuilding
  // it per test is what keeps a half-streamed line from one case leaking into the next.
  beforeEach(() => configureRendering("none", true));

  it("prints a checkpoint line naming a short prefix of the tree", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "checkpoint", checkpoint: { tree: "abcdef1234567890", label: "before", createdAt: 0, turnId: "t1", messageCount: 0 } });
    restore();
    expect(writes.join("")).toContain("checkpoint abcdef12");
  });

  it("reports a compaction with the before and after message counts", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "compaction", tokensBefore: 0, messagesBefore: 40, messagesAfter: 6 });
    restore();
    expect(writes.join("")).toContain("compacted context (40 → 6 messages)");
  });

  it("shows why a provider request is retrying and the bounded attempt count", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "provider_retry", iteration: 1, nextAttempt: 2, maxAttempts: 3, delayMs: 100, reason: "rate_limit" } });
    restore();
    expect(writes.join("")).toContain("rate limited");
    expect(writes.join("")).toContain("2/3");
    expect(writes.join("")).toContain("100ms");
  });

  it("announces a tool call with what it was called with, before any result exists", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "src/app.ts" } } });
    restore();
    expect(writes.join("")).toContain("tool activity");
    const call = writes.find((chunk) => chunk.includes("read_file"))!;
    expect(call).toContain("src/app.ts"); // the argument is the useful half of the line
  });

  it("upgrades the announcement in place rather than printing a second line for the result", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "src/app.ts" } } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "a\nb\nc" } });
    restore();
    expect(writes).toContain("\x1b[1A\x1b[2K"); // the announcement row was erased
    const final = writes.at(-1)!;
    expect(final).toContain("✓");
    expect(final).toContain("src/app.ts"); // the argument survives into the completed line
    expect(final).toContain("3 lines");
  });

  it("prints the result on its own line when something interleaved after the announcement", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "a.ts" } } });
    // A checkpoint between the call and its result means the announcement is no longer the last
    // line on screen, so rewriting it would clobber the checkpoint line instead.
    renderEvent({ type: "checkpoint", checkpoint: { tree: "abcdef1234567890", label: "x", createdAt: 0, turnId: "t1", messageCount: 0 } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "a" } });
    restore();
    expect(writes.filter((chunk) => chunk === "\x1b[1A\x1b[2K")).toHaveLength(0);
    expect(writes.at(-1)).toContain("✓");
  });

  it("marks a successful tool call distinctly from a failed one", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "file contents" } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c2", toolName: "run_command", isError: true, effect: "workspace", content: "exit 1\nboom" } });
    restore();
    const [ok, failed] = writes;
    expect(ok).toContain("✓");
    expect(ok).toContain("read_file");
    expect(failed).toContain("✗");
    expect(failed).toContain("run_command");
    expect(failed).toContain("exit 1");
  });

  it("marks a workspace-writing call differently from a read-only one", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "a.ts" } } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "x" } });
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c2", toolName: "write_file", effect: "workspace", arguments: { path: "b.ts", content: "" } } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c2", toolName: "write_file", isError: false, effect: "workspace", content: "wrote" } });
    restore();
    expect(writes[0]).not.toContain("✎");
    expect(writes.some((chunk) => chunk.includes("✎"))).toBe(true);
  });

  it("groups concurrent calls into a lane, retroactively marking the one already on screen", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: { path: "a.ts" } } });
    // c1's line is not yet part of a batch — no lane bar.
    expect(writes[0]).not.toContain("│");
    renderEvent({ type: "runtime", event: { type: "tool_call", toolCallId: "c2", toolName: "read_file", effect: "none", arguments: { path: "b.ts" } } });
    // Announcing c2 while c1 is still open retroactively bars c1's line and bars c2's own.
    const rewriteOfC1 = writes.find((chunk) => chunk.includes("a.ts") && chunk.includes("│"));
    expect(rewriteOfC1).toBeDefined();
    expect(writes.at(-1)).toContain("│");
    expect(writes.at(-1)).toContain("b.ts");
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: "x" } });
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c2", toolName: "read_file", isError: false, effect: "none", content: "y" } });
    restore();
  });

  it("summarizes a long tool result instead of pasting it into the transcript", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "tool_result", toolCallId: "c1", toolName: "read_file", isError: false, effect: "none", content: `${"x".repeat(200)}\nsecond line never shown` } });
    restore();
    expect(writes[0]).not.toContain("second line never shown");
    expect(writes[0]).toContain("2 lines");
    expect(writes[0].length).toBeLessThan(200);
  });

  it("says nothing for a model turn, whose calls announce themselves one by one", () => {
    const usage = { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "model_turn", iteration: 1, responseId: "r1", model: "m", toolCallCount: 3, usage } });
    restore();
    // A "thinking (3 tool calls)" line would only restate what the next three lines say.
    expect(writes).toHaveLength(0);
  });

  it("streams assistant text raw as it arrives, then renders it once the line is whole", () => {
    const { writes, restore } = captureStdout();
    renderEvent({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: "Set **the port**" } });
    expect(writes).toEqual(["Set **the port**"]); // live, unstyled, no trailing newline
    renderEvent({ type: "runtime", event: { type: "assistant_delta", iteration: 1, text: " to 8080\n" } });
    restore();
    expect(writes.at(-1)).toBe("Set the port to 8080\n"); // re-rendered with the markers consumed
  });
});

describe("createApprovalPrompt", () => {
  function fakeReadline(answer: string): Interface {
    return { question: async () => answer } as unknown as Interface;
  }

  it("denies without asking when stdin is not a terminal, and says why", async () => {
    const { writes, restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("y"), false, () => undefined);
    const decision = await approve({ summary: "delete the database" });
    restore();
    expect(decision).toBe("deny_always");
    expect(writes.join("")).toContain("stdin is not a terminal");
  });

  it.each([
    ["y", "allow"], ["yes", "allow"], ["", "allow"],
    ["n", "deny"], ["no", "deny"],
    ["a", "allow_always"], ["always", "allow_always"],
    ["d", "deny_always"],
    ["gibberish", "deny"],
  ] as const)("reads %j as %s", async (answer, expected) => {
    const { restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline(answer), true, () => undefined);
    const decision = await approve({ summary: "write a file" });
    restore();
    expect(decision).toBe(expected);
  });

  it("is case-insensitive and trims whitespace", async () => {
    const { restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("  YES  "), true, () => undefined);
    const decision = await approve({ summary: "write a file" });
    restore();
    expect(decision).toBe("allow");
  });

  it("denies instead of hanging when the turn is cancelled while the question is pending", async () => {
    // The bug this guards against: `agent.cancel()` alone only flips a flag `BoundedAgentRuntime`
    // checks between steps, and a blocked `readline.question()` here is not a step it loops over —
    // so without wiring an abort signal through, Ctrl+C during an approval prompt printed
    // "interrupted" but left the process stuck on a question nobody could still answer.
    const controller = new AbortController();
    const readline = {
      question: (_query: string, options?: { signal?: AbortSignal }) => new Promise<string>((_resolve, reject) => {
        const abort = () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener("abort", abort, { once: true });
      }),
    } as unknown as Interface;
    const { writes, restore } = captureStdout();
    const approve = createApprovalPrompt(readline, true, () => controller.signal);
    const pending = approve({ summary: "run rm -rf /tmp/scratch" });
    controller.abort();
    const decision = await pending;
    restore();
    expect(decision).toBe("deny");
    expect(writes.join("")).toContain("interrupted");
  });

  it("shows the exact change before asking, when the request carries a preview", async () => {
    const { writes, restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("n"), true, () => undefined);
    await approve({ summary: "edit src/app.ts", preview: { toolName: "edit_file", path: "src/app.ts", oldText: "port = 3000", newText: "port = 8080" } });
    restore();
    const output = writes.join("");
    expect(output).toContain("3000");
    expect(output).toContain("8080");
  });

  it("asks with just the summary when there is nothing to preview, e.g. run_command", async () => {
    const { writes, restore } = captureStdout();
    const approve = createApprovalPrompt(fakeReadline("n"), true, () => undefined);
    await approve({ summary: "run npm test" });
    restore();
    expect(writes.join("")).toContain("run npm test");
  });
});

describe("spending approval", () => {
  function fakeReadline(answer: string): Interface {
    return { question: async () => answer } as unknown as Interface;
  }

  it.each([["", true], ["y", true], ["yes", true], ["n", false], ["anything else", false]] as const)("treats %j as approved=%s", async (answer, expected) => {
    const { restore } = captureStdout();
    await expect(confirmSpendingCap(fakeReadline(answer), true, "E£500.00")).resolves.toBe(expected);
    restore();
  });

  it("treats an explicit --budget in a non-interactive command as the approval", async () => {
    await expect(confirmSpendingCap(fakeReadline("n"), false, "$5.00")).resolves.toBe(true);
  });
});

describe("sensitive task preflight", () => {
  const assessment = { sensitive: true, categories: ["production" as const], reasons: ["production deployment or release"] };
  function fakeReadline(answer: string): Interface {
    return { question: async () => answer } as unknown as Interface;
  }

  it.each([["y", true], ["yes", true], ["", false], ["n", false]] as const)("treats %j as approved=%s", async (answer, expected) => {
    const { restore } = captureStdout();
    await expect(confirmSensitiveTask(fakeReadline(answer), true, assessment)).resolves.toBe(expected);
    restore();
  });

  it("fails closed unattended unless the operator passed the explicit flag", async () => {
    const { writes, restore } = captureStdout();
    await expect(confirmSensitiveTask(fakeReadline("y"), false, assessment)).resolves.toBe(false);
    await expect(confirmSensitiveTask(fakeReadline("n"), false, assessment, true)).resolves.toBe(true);
    restore();
    expect(writes.join(" ")).toContain("--allow-sensitive");
  });

  it("does not prompt for an ordinary task", async () => {
    let asked = 0;
    const readline = { question: async () => { asked += 1; return "n"; } } as unknown as Interface;
    await expect(confirmSensitiveTask(readline, true, { sensitive: false, categories: [], reasons: [] })).resolves.toBe(true);
    expect(asked).toBe(0);
  });
});

describe("main() — branches that resolve before any interactive input is needed", () => {
  const originalArgv = process.argv;
  const originalEnv = { ...process.env };
  let tmpRoot: string;

  beforeEach(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    tmpRoot = await mkdtemp(path.join(os.tmpdir(), "nova-main-"));
    // A clean slate: no provider keys leak in from the developer's own shell into the "unconfigured" tests.
    for (const key of Object.keys(process.env)) {
      if (/^(ANTHROPIC|OPENAI|CIRCUITNOTION|E2B|NOVA)_/.test(key)) delete process.env[key];
    }
    // ...and no keys leak in from the developer's own *saved settings* either. Clearing the
    // environment alone was not enough and was in fact counterproductive: the loop above deletes
    // `NOVA_CONFIG_DIR`, which sends `loadSettings` to the real per-user config file, so
    // "unconfigured" meant "unconfigured unless whoever runs this suite actually uses Nova". It
    // passed on CI and on a fresh checkout and failed for anyone who had run `nova settings` —
    // the one population most likely to be running the tests.
    process.env.NOVA_CONFIG_DIR = await mkdtemp(path.join(os.tmpdir(), "nova-main-config-"));
  });

  afterEach(async () => {
    process.argv = originalArgv;
    process.env = { ...originalEnv };
    const { rm } = await import("node:fs/promises");
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const out = captureStdout();
    const err = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => { errWrites.push(plain(String(chunk))); return true; });
    const errWrites: string[] = [];
    process.argv = ["node", "nova", ...args];
    const { main } = await import("./nova");
    const code = await main();
    out.restore();
    err.mockRestore();
    return { code, stdout: out.writes.join(""), stderr: errWrites.join("") };
  }

  it("--help prints the command list and exits 0 without touching stdin", async () => {
    const { code, stdout } = await run(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("a coding agent in your terminal");
    expect(stdout).toContain("/todos");
    expect(stdout).toContain("nova update");
  });

  it("--version prints the bundled package version without provider setup", async () => {
    const { code, stdout } = await run(["--version"]);
    expect(code).toBe(0);
    expect(stdout).toMatch(/^nova \d+\.\d+\.\d+\n$/);
  });

  it("--providers reports every provider as unconfigured with nothing set", async () => {
    const { code, stdout } = await run(["--providers"]);
    expect(code).toBe(0);
    expect(stdout).toContain("set ANTHROPIC_API_KEY");
  });

  it("--sessions reports an empty project plainly", async () => {
    const { code, stdout } = await run(["--sessions", "--cwd", tmpRoot]);
    expect(code).toBe(0);
    expect(stdout).toContain("No sessions in this project yet.");
  });

  it("history works without model credentials and reports its active storage path", async () => {
    const listed = await run(["history", "--cwd", tmpRoot]);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain("no past sessions");

    const status = await run(["history", "status", "--cwd", tmpRoot]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/native SQLite \+ FTS5|portable JSON history/);
  });

  it("refuses to run with no model provider configured, and says so on stderr", async () => {
    const { code, stderr } = await run(["--cwd", tmpRoot, "hello"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Nova is not configured.");
  });

  it("refuses a sandbox session without E2B credentials, even with a model configured", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { code, stderr } = await run(["--cwd", tmpRoot, "--sandbox", "hello"]);
    expect(code).toBe(1);
    expect(stderr).toContain("Remote sandboxes need E2B");
  });

  it("never sends a one-shot slash command to the model", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const { code, stderr, stdout } = await run(["--cwd", tmpRoot, "/models refresh"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Slash commands run inside an interactive Nova session");
    expect(stdout).not.toContain("Estimated:");
  });

  it("refuses an interactive session with no terminal attached and no one-shot request", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    try {
      const { code, stderr } = await run(["--cwd", tmpRoot]);
      expect(code).toBe(1);
      expect(stderr).toContain("No terminal attached");
    } finally {
      if (originalIsTTY) Object.defineProperty(process.stdin, "isTTY", originalIsTTY);
    }
  });
});
