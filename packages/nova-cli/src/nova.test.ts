import { describe, expect, it } from "vitest";
import { parseArgs, readFxRates, renderProviders } from "./nova";

const plain = (value: string) => value.replace(/\[[0-9;]*m/g, "");

describe("argument parsing", () => {
  it("defaults to a local build-mode session in the working directory", () => {
    const args = parseArgs([]);
    expect(args).toMatchObject({ mode: "build", backend: "local", prompt: null, upload: false });
    expect(args.root).toBe(process.cwd());
  });

  it("reads the mode flags, including their short forms", () => {
    expect(parseArgs(["--plan"]).mode).toBe("plan");
    expect(parseArgs(["-p"]).mode).toBe("plan");
    expect(parseArgs(["--auto"]).mode).toBe("auto");
    expect(parseArgs(["-y"]).mode).toBe("auto");
    expect(parseArgs(["--build"]).mode).toBe("build");
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

  it("parses provider, model, currency and budget", () => {
    const args = parseArgs(["--provider", "anthropic", "--model", "claude-sonnet-5", "--currency", "usd", "--budget", "25"]);
    expect(args).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", currency: "USD", budget: 25 });
  });

  it("ignores a currency it cannot honour rather than inventing one", () => {
    expect(parseArgs(["--currency", "EUR"]).currency).toBeUndefined();
    expect(parseArgs(["--currency", "rwf"]).currency).toBe("RWF");
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
    expect(parseArgs(["--doctor"]).listProviders).toBe(true);
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
    expect(rendered).toContain("claude-opus-5 · pricing: catalog");
    expect(rendered).not.toContain("set ANTHROPIC_API_KEY");
  });

  it("explains an unpriced-but-working provider, which is otherwise baffling", () => {
    const rendered = plain(renderProviders({ CIRCUITNOTION_API_KEY: "k", CIRCUITNOTION_MODEL: "gpt-5.6-luna" }, "none"));
    expect(rendered).toContain("pricing: unknown");
    expect(rendered).toContain("costs show as unknown");
    expect(rendered).toContain("MODEL_INPUT_PER_MILLION");
  });

  it("stops nagging about the exchange rate once one is configured", () => {
    expect(plain(renderProviders({ ANTHROPIC_API_KEY: "k" }, "none"))).toContain("NOVA_FX_RWF_PER_USD");
    expect(plain(renderProviders({ ANTHROPIC_API_KEY: "k", NOVA_FX_RWF_PER_USD: "1320" }, "none"))).not.toContain("Set NOVA_FX_RWF_PER_USD");
  });

  it("emits no escape codes when colour is unwanted", () => {
    const rendered = renderProviders({ ANTHROPIC_API_KEY: "k" }, "none");
    expect(rendered).not.toMatch(/\[/);
  });
});
