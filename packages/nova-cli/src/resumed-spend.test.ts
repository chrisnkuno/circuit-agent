import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventJournal } from "@circuit-nova/nova-core/nova-cli/protocol";
import { fromUnits, tokenPrices, toUnits, type FxRate } from "@circuit-nova/nova-core/money";
import { priceSessionModelTurns, readSessionModelTurns, type SessionModelTurn } from "./resumed-spend";

/**
 * Rebuilding what a resumed session already spent.
 *
 * The invariant under test is that this figure is derived from tokens — the one thing the journal
 * records unambiguously — and never from a stored number whose unit depends on how the process
 * that wrote it happened to be invoked. Everything else here follows from that: an unknown model
 * is named rather than counted as free, and each turn is priced at the rate of the model that
 * actually ran it.
 */

const opus = tokenPrices("USD", 5, 25);
const haiku = tokenPrices("USD", 1, 5);
const rwfPerUsd: FxRate = { from: "USD", to: "RWF", rate: 1_320, asOf: "2026-08-01", source: "test" };

const usage = (input: number, output: number, cached = 0) => ({
  inputTokens: input,
  outputTokens: output,
  totalTokens: input + output,
  cachedInputTokens: cached,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});

const turn = (model: string, input: number, output: number): SessionModelTurn => ({ model, usage: usage(input, output) });

describe("spend rebuilt from a session's journal", () => {
  it("reads back every model call, in the order they happened", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-spend-"));
    try {
      const journal = new EventJournal(root, "session_1");
      await journal.append({ type: "turn_status", turnId: "turn_1", from: "queued", to: "running" });
      await journal.append({ type: "runtime", turnId: "turn_1", event: { type: "model_turn", iteration: 1, responseId: "r1", model: "claude-opus-5", toolCallCount: 0, usage: usage(1_000, 100) } });
      // A tool call between the two, to prove the reader selects rather than counts positions.
      await journal.append({ type: "runtime", turnId: "turn_1", event: { type: "tool_call", toolCallId: "c1", toolName: "read_file", effect: "none", arguments: {} } });
      await journal.append({ type: "runtime", turnId: "turn_1", event: { type: "model_turn", iteration: 2, responseId: "r2", model: "claude-opus-5", toolCallCount: 0, usage: usage(2_000, 200) } });
      await journal.close();

      const turns = await readSessionModelTurns(root, "session_1");
      expect(turns.map((entry) => entry.usage.inputTokens)).toEqual([1_000, 2_000]);
      expect(turns.every((entry) => entry.model === "claude-opus-5")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reports nothing for a session that never reached the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-spend-"));
    try {
      // No journal file at all — a session created and abandoned before its first turn. Resuming
      // it is ordinary, and must not look like a read failure.
      expect(await readSessionModelTurns(root, "session_missing")).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("refuses a journal whose chain has been tampered with, rather than pricing it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "nova-spend-"));
    try {
      const journal = new EventJournal(root, "session_1");
      await journal.append({ type: "runtime", turnId: "turn_1", event: { type: "model_turn", iteration: 1, responseId: "r1", model: "claude-opus-5", toolCallCount: 0, usage: usage(1_000, 100) } });
      await journal.close();

      const file = path.join(root, ".nova", "events", "session_1.jsonl");
      const line = JSON.parse((await fs.readFile(file, "utf8")).trim());
      line.payload.event.usage.inputTokens = 1;
      await fs.writeFile(file, `${JSON.stringify(line)}\n`);

      // Editing the file to shrink a session's recorded usage is exactly how a budget would be
      // evaded, so the integrity check has to be the thing that decides, not a best effort read.
      await expect(readSessionModelTurns(root, "session_1")).rejects.toThrow(/integrity/i);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prices each turn at the rate of the model that ran it", () => {
    // A session that started on Opus and switched to Haiku spent at two rates. Charging the whole
    // thread at either one is a wrong number, and the journal records which was which.
    const { spent, unpriced } = priceSessionModelTurns(
      [turn("claude-opus-5", 1_000_000, 0), turn("claude-haiku-4-5", 1_000_000, 0)],
      { display: "USD", pricesFor: (model) => (model === "claude-opus-5" ? opus : haiku) },
    );
    expect(unpriced).toEqual([]);
    expect(toUnits(spent!)).toBeCloseTo(6, 6); // $5 of Opus input + $1 of Haiku input
  });

  it("names a model it cannot price instead of counting its turns as free", () => {
    const { spent, unpriced } = priceSessionModelTurns(
      [turn("claude-opus-5", 1_000_000, 0), turn("some-local-model", 5_000_000, 0)],
      { display: "USD", pricesFor: (model) => (model === "claude-opus-5" ? opus : undefined) },
    );
    // The priced part still counts — a floor is more useful than nothing — but the caller is told
    // which model is missing so it can say the total is a floor rather than a figure.
    expect(toUnits(spent!)).toBeCloseTo(5, 6);
    expect(unpriced).toEqual(["some-local-model"]);
  });

  it("converts into the display currency, and names what it could not convert", () => {
    const priced = priceSessionModelTurns([turn("claude-opus-5", 1_000_000, 0)], {
      display: "RWF",
      rates: [rwfPerUsd],
      pricesFor: () => opus,
    });
    expect(toUnits(priced.spent!)).toBeCloseTo(6_600, 6); // $5 at 1,320

    const unconvertible = priceSessionModelTurns([turn("claude-opus-5", 1_000_000, 0)], {
      display: "RWF",
      rates: [],
      pricesFor: () => opus,
    });
    // No rate means no honest figure. Reporting the dollar amount under a franc sign would be a
    // number off by three orders of magnitude that looks entirely reasonable.
    expect(unconvertible.spent).toBeUndefined();
    expect(unconvertible.unpriced).toEqual(["claude-opus-5"]);
  });

  it("returns nothing to carry for a session with no priceable turns at all", () => {
    expect(priceSessionModelTurns([], { display: "USD", pricesFor: () => opus }).spent).toBeUndefined();
    expect(fromUnits(0, "USD").micros).toBe(0);
  });
});
