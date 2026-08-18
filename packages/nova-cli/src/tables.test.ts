import { describe, expect, it } from "vitest";
import type { JobSummary } from "@circuit-nova/nova-core/nova-cli/jobs";
import type { TurnCost } from "@circuit-nova/nova-core/nova-cli/cost";
import { UNICODE_GLYPHS } from "./glyphs";
import type { ModelCatalog } from "./models";
import { numericValue, renderTable, sortRows, INITIAL_TABLE_STATE } from "./table";
import { buildCostTable, buildJobsTable, buildModelTable, jobStatusMark, type TableData } from "./tables";

const plain = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");
const paint = {
  dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
  cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
  green: (text: string) => `\x1b[32m${text}\x1b[0m`,
  yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
};

/**
 * Every table shares one invariant that matters more than any of its columns: a column a reader would
 * sort has to *be* sortable. A cell painted for emphasis, or carrying its unit, reads as text to
 * `numericValue`, and the sort then answers "which was most expensive" wrong rather than not at all.
 */
function expectSortableColumn(data: TableData, title: string) {
  const index = data.columns.findIndex((column) => column.title === title);
  expect(index, `no ${title} column`).toBeGreaterThanOrEqual(0);
  const cells = data.rows.map((row) => row[index] ?? "");
  expect(cells.length).toBeGreaterThan(0);
  for (const cell of cells) {
    expect(numericValue(cell), `${title} cell ${JSON.stringify(cell)} does not read as a number`).toBeTypeOf("number");
  }
}

const CATALOG: ModelCatalog = {
  choices: [
    { provider: "anthropic", providerLabel: "Anthropic", model: "claude-opus-5", isProviderDefault: true, prices: undefined },
    { provider: "anthropic", providerLabel: "Anthropic", model: "claude-sonnet-5", isProviderDefault: false, prices: undefined, live: true },
    { provider: "openai", providerLabel: "OpenAI", model: "gpt-5.6", isProviderDefault: true, prices: undefined },
  ] as ModelCatalog["choices"],
  unconfigured: [],
};

const RATES: Record<string, [string, string]> = {
  "claude-opus-5": ["15.00", "75.00"],
  "claude-sonnet-5": ["3.00", "15.00"],
  "gpt-5.6": ["1.25", "10.00"],
};

const modelTable = () => buildModelTable(CATALOG, {
  current: { provider: "anthropic", model: "claude-sonnet-5" },
  rate: (choice, side) => RATES[choice.model]?.[side === "input" ? 0 : 1] ?? "",
  paint,
});

describe("buildModelTable", () => {
  it("gives one row per model, with the prices in their own sortable columns", () => {
    const data = modelTable();
    expect(data.rows).toHaveLength(3);
    expectSortableColumn(data, "$/M in");
    expectSortableColumn(data, "$/M out");
  });

  it("orders by price when asked, which is the question a printed list could not answer", () => {
    const data = modelTable();
    const column = data.columns.findIndex((entry) => entry.title === "$/M in");
    const cheapestFirst = sortRows(data.rows, { column, direction: "asc" }).map((row) => plain(row[2] ?? ""));
    expect(cheapestFirst).toEqual(["gpt-5.6", "claude-sonnet-5", "claude-opus-5"]);
  });

  it("keeps the number /model <n> takes with the row, so sorting cannot renumber it", () => {
    const data = modelTable();
    expect(data.rows.map((row) => row[0])).toEqual(["1", "2", "3"]);
    const column = data.columns.findIndex((entry) => entry.title === "$/M in");
    const cheapestFirst = sortRows(data.rows, { column, direction: "asc" });
    // gpt-5.6 is the third model in the catalog and stays "3" even when it sorts first, so the
    // number on screen and the number `/model 3` resolves are the same model in every order.
    expect(cheapestFirst[0][0]).toBe("3");
    expect(plain(cheapestFirst[0][2] ?? "")).toBe("gpt-5.6");
  });

  it("marks the model in use, so the table says where you already are", () => {
    const data = modelTable();
    const current = data.rows.find((row) => plain(row[2] ?? "") === "claude-sonnet-5") ?? [];
    expect(plain(current[1] ?? "")).toBe(UNICODE_GLYPHS.circleFull);
    // And only that one.
    expect(data.rows.filter((row) => plain(row[1] ?? "") !== "")).toHaveLength(1);
  });

  it("names a model the provider reported but this build has no price for, rather than hiding it", () => {
    const data = modelTable();
    const live = data.rows.find((row) => plain(row[2] ?? "") === "claude-sonnet-5") ?? [];
    expect(plain(live[6] ?? "")).toContain("live");
  });

  it("numbers every choice from one, contiguously, so /model N always resolves", () => {
    // The number is the entire interface for `/model N`; a gap or a repeat makes an entry unreachable.
    const data = modelTable();
    expect(data.rows.map((row) => Number(row[0]))).toEqual(data.rows.map((_, index) => index + 1));
  });

  it("still explains a provider it cannot offer, which a grid of models has no row for", () => {
    const data = buildModelTable(
      { choices: CATALOG.choices, unconfigured: [{ provider: "openai", label: "OpenAI", missing: ["OPENAI_API_KEY"] }] } as ModelCatalog,
      { current: { provider: "anthropic", model: "claude-opus-5" }, rate: () => "", paint },
    );
    expect(plain((data.notes ?? []).join("\n"))).toContain("set OPENAI_API_KEY");
    expect(plain((data.notes ?? []).join("\n"))).toContain("nova settings");
  });

  it("still says how to choose, and says nothing at all when there is nothing to choose from", () => {
    expect(plain((modelTable().notes ?? []).join("\n"))).toContain("/model <number>");
    const empty = buildModelTable({ choices: [], unconfigured: [] }, { current: { provider: "openai", model: "gpt-5.6" }, rate: () => "", paint });
    expect(empty.notes).toEqual([]);
    expect(empty.rows).toEqual([]);
  });

  it("survives a model with no known price without inventing one", () => {
    const data = buildModelTable(CATALOG, {
      current: { provider: "openai", model: "gpt-5.6" },
      rate: () => "",
      paint,
    });
    for (const row of data.rows) expect(row[4]).toBe("");
    // Blank rather than a number, and the renderer still draws a rectangle around it.
    const frame = renderTable(data.columns, data.rows, INITIAL_TABLE_STATE, { paint, width: 100, legend: "" });
    expect(frame.split("\n").every((line) => line.length > 0)).toBe(true);
  });
});

const HISTORY: TurnCost[] = [
  { turnNumber: 1, usage: { inputTokens: 12_400, outputTokens: 800, totalTokens: 13_200, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, cost: { micros: 90_000, currency: "USD" }, iterations: 1, toolCalls: 2, elapsedMs: 4_200 },
  { turnNumber: 2, usage: { inputTokens: 31_000, outputTokens: 2_400, totalTokens: 33_400, cachedInputTokens: 24_000, cacheWriteTokens: 0, reasoningTokens: 600 }, cost: { micros: 1_240_000, currency: "USD" }, iterations: 3, toolCalls: 11, elapsedMs: 18_900 },
  { turnNumber: 3, usage: { inputTokens: 9_000, outputTokens: 300, totalTokens: 9_300, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }, cost: undefined, iterations: 1, toolCalls: 0, elapsedMs: 900 },
];

const money = (cost: TurnCost["cost"]) => (cost ? `$${(cost.micros / 1_000_000).toFixed(2)}` : "");

describe("buildCostTable", () => {
  it("gives one row per turn, with every number in a column that sorts as a number", () => {
    const data = buildCostTable(HISTORY, { money, paint });
    expect(data.rows).toHaveLength(3);
    for (const title of ["Turn", "In", "Cached", "Out", "Tools", "Secs"]) expectSortableColumn(data, title);
  });

  it("answers which turn was the expensive one", () => {
    const data = buildCostTable(HISTORY, { money, paint });
    const column = data.columns.findIndex((entry) => entry.title === "Cost");
    const dearest = sortRows(data.rows, { column, direction: "desc" })[0];
    expect(dearest[0]).toBe("2");
  });

  it("puts a turn with no known price at the cheap end rather than interleaving it", () => {
    const data = buildCostTable(HISTORY, { money, paint });
    const column = data.columns.findIndex((entry) => entry.title === "Cost");
    expect(sortRows(data.rows, { column, direction: "asc" })[0][0]).toBe("3");
  });

  it("names the unit in the header and keeps the values bare, so elapsed sorts by duration", () => {
    // The bug this closes: a column mixing `900ms` and `18.9s` sorts the slowest turn as the fastest,
    // because the only thing a comparator can see is the number in front of the unit.
    const data = buildCostTable(HISTORY, { money, paint });
    const column = data.columns.findIndex((entry) => entry.title === "Secs");
    expect(sortRows(data.rows, { column, direction: "desc" })[0][0]).toBe("2");
    expect(data.rows.map((row) => row[column])).toEqual(["4.2", "18.9", "0.9"]);
  });

  it("holds up with a single turn and with none at all", () => {
    expect(buildCostTable([], { money, paint }).rows).toHaveLength(0);
    expect(buildCostTable(HISTORY.slice(0, 1), { money, paint }).rows).toHaveLength(1);
  });
});

const JOBS: JobSummary[] = [
  { id: "4f2a91", status: "running", objective: "Port the CLI table component", attempts: 1, detail: "on step 3 of 6" },
  { id: "77bc10", status: "failed", objective: "Upgrade the linter", attempts: 3, detail: "tsc exited 2" },
  { id: "0091ab", status: "paused", objective: "Refactor the ledger", attempts: 1, detail: "waiting on approval: run_command" },
];

describe("buildJobsTable", () => {
  it("gives one row per job, keeping the status mark the printed list used", () => {
    const data = buildJobsTable(JOBS, { paint });
    expect(data.rows).toHaveLength(3);
    expect(plain(data.rows[0][0] ?? "")).toBe(UNICODE_GLYPHS.circleFull);
    expect(plain(data.rows[1][0] ?? "")).toBe(UNICODE_GLYPHS.cross);
    expect(plain(data.rows[2][0] ?? "")).toBe(UNICODE_GLYPHS.paused);
  });

  it("groups the statuses together when sorted, which is how you find what is stuck", () => {
    const data = buildJobsTable(JOBS, { paint });
    const column = data.columns.findIndex((entry) => entry.title === "Status");
    expect(sortRows(data.rows, { column, direction: "asc" }).map((row) => plain(row[column] ?? ""))).toEqual(["failed", "paused", "running"]);
  });

  it("keeps what a job is waiting on visible rather than clipped away with the objective", () => {
    const data = buildJobsTable(JOBS, { paint });
    const frame = plain(renderTable(data.columns, data.rows, INITIAL_TABLE_STATE, { paint, width: 120, legend: "" }));
    expect(frame).toContain("waiting on approval");
  });

  it("puts the free-text objective last, so no column moves from row to row", () => {
    const data = buildJobsTable(JOBS, { paint });
    const objective = data.columns.findIndex((entry) => entry.title === "Objective");
    const fixed = data.columns.slice(0, objective);
    for (const column of fixed) expect(column.width, `${column.title} has no width`).toBeGreaterThan(0);
  });

  it("has a mark for every status a job can be in", () => {
    for (const status of ["queued", "running", "paused", "completed", "failed", "cancelled"] as const) {
      expect(plain(jobStatusMark(status, paint))).not.toBe("");
    }
  });
});
