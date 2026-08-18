import type { JobStatus, JobSummary } from "@circuit-nova/nova-core/nova-cli/jobs";
import type { TurnCost } from "@circuit-nova/nova-core/nova-cli/cost";
import type { GlyphSet } from "./glyphs";
import { UNICODE_GLYPHS } from "./glyphs";
import type { ModelCatalog, ModelChoice } from "./models";
import type { TableColumn, TablePaint, TableRow } from "./table";

/**
 * Which columns each of Nova's tables has — and nothing about how a table is drawn.
 *
 * Three surfaces grew the same shape by hand and each answered it differently: `/models` padded model
 * ids with `.padEnd`, `/jobs` padded a status with `.padEnd(9)`, and `/cost` printed a paragraph
 * because a paragraph was easier than aligning six numbers. They are all the same question — what are
 * this thing's columns, and which one is worth sorting by — so they are all answered here, in pure
 * functions a test can read without a terminal, a ledger, or a job store.
 *
 * The cells arrive painted where colour carries meaning (a red `failed`, the dot on the model in use).
 * `table.ts` measures with `visibleWidth` and clips with the sequences intact, so that is safe; what
 * is *not* safe is painting a column that will be sorted numerically, so the money and token columns
 * are left plain and the sort reads them.
 */

export type TableData = {
  columns: TableColumn[];
  rows: TableRow[];
  /**
   * Lines to print under the table — the things a grid cannot say.
   *
   * A table has one shape and some facts do not fit it: a provider with no key has no model to give a
   * row to, and "choose with /model <n>" is an instruction, not a datum. The printed list said both
   * and would have lost both in the move to columns, which is the usual way a rewrite quietly removes
   * the part that was helping someone.
   */
  notes?: string[];
};

/**
 * `/models` as a table: what you can switch to, and what each one costs.
 *
 * The printed list said the same things in a sentence per row — `claude-opus-5  $1.20 per M in ·
 * $6.00 per M out  (default, current)`. The columns are the improvement, because the question people
 * actually bring to this list is comparative: which of these is cheapest, which is the one I am on.
 * A sentence answers neither without reading every row.
 *
 * Prices stay in two plain columns rather than one painted phrase, which is what makes `s` on either
 * of them mean "cheapest first".
 */
export function buildModelTable(
  catalog: ModelCatalog,
  options: {
    current: { provider: string; model: string };
    /** Formats one side of a model's price in the display currency, or "" when it has none. */
    rate: (choice: ModelChoice, side: "input" | "output") => string;
    paint: TablePaint;
    glyphs?: GlyphSet;
  },
): TableData {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const { paint } = options;
  const notes = [
    // A provider Nova could use but has no key for is the most common reason this list is short, and
    // naming the variable is the difference between a short list and an actionable one.
    ...catalog.unconfigured.map((entry) => `${paint.dim(entry.label)} ${paint.yellow(`— nova settings, or set ${entry.missing.join(" and ")}`)}`),
    ...(catalog.choices.length > 0
      ? [paint.dim("Choose with /model <number>, or /model <name> — /model opus is enough. Your choice is remembered.")]
      : []),
  ];
  return {
    notes,
    columns: [
      /**
       * The number `/model <n>` takes, carried as data rather than drawn by the renderer.
       *
       * It has to be a column because it has to survive sorting. The printed list numbered its rows
       * by position, so ordering the table by price would have renumbered every one of them and
       * `/model 3` would name a different model than the row labelled 3 on screen. Kept with the row
       * instead, the number means the same thing in every order — and the reference the old list
       * taught people goes on working.
       */
      { title: "#", width: 4, align: "right" },
      // The marker column is one glyph wide and unnamed: a header over it would be wider than the
      // thing it labels, and "the row with the dot" needs no explaining.
      { title: "", width: 1 },
      { title: "Model", width: 34 },
      { title: "Provider", width: 14 },
      { title: "$/M in", width: 9, align: "right" },
      { title: "$/M out", width: 9, align: "right" },
      { title: "Notes", width: 16 },
    ],
    rows: catalog.choices.map((choice, index) => {
      const isCurrent = choice.provider === options.current.provider && choice.model === options.current.model;
      const notes = [choice.isProviderDefault ? "default" : "", choice.live ? "live" : ""].filter(Boolean).join(", ");
      return [
        String(index + 1),
        isCurrent ? paint.green(glyphs.circleFull) : "",
        isCurrent ? paint.green(choice.model) : choice.model,
        paint.dim(choice.providerLabel),
        options.rate(choice, "input"),
        options.rate(choice, "output"),
        // Unpainted when empty: a colour code wrapped around nothing is bytes on the wire that no
        // terminal has anything to do.
        notes ? paint.dim(notes) : "",
      ];
    }),
  };
}

/**
 * `/cost` per turn: where the session's money and time actually went.
 *
 * The report above this table gives the totals, which is the right shape for "what has this cost me".
 * It cannot answer "which turn was expensive", and that is the question that leads somewhere — a turn
 * with forty tool calls and a big cached input is a prompt worth rewriting.
 *
 * Elapsed is seconds, plainly, with the unit in the header rather than on every value. Mixing `1.2s`
 * and `340ms` down a column is what makes it unsortable (`numericValue` refuses a unit precisely so
 * that a mixed column cannot sort wrong), and a header is the cheaper place to say it once.
 */
export function buildCostTable(
  history: readonly TurnCost[],
  options: { money: (cost: TurnCost["cost"]) => string; paint: TablePaint },
): TableData {
  const { paint } = options;
  return {
    columns: [
      { title: "Turn", width: 5, align: "right" },
      { title: "In", width: 10, align: "right" },
      { title: "Cached", width: 10, align: "right" },
      { title: "Out", width: 10, align: "right" },
      { title: "Tools", width: 6, align: "right" },
      { title: "Secs", width: 7, align: "right" },
      { title: "Cost", width: 10, align: "right" },
    ],
    rows: history.map((turn) => [
      String(turn.turnNumber),
      turn.usage.inputTokens.toLocaleString("en-US"),
      turn.usage.cachedInputTokens > 0 ? turn.usage.cachedInputTokens.toLocaleString("en-US") : paint.dim("0"),
      turn.usage.outputTokens.toLocaleString("en-US"),
      String(turn.toolCalls),
      (turn.elapsedMs / 1_000).toFixed(1),
      options.money(turn.cost),
    ]),
  };
}

/** The status marks `/jobs` has always used, kept in one place now that two renderers want them. */
export function jobStatusMark(status: JobStatus, paint: TablePaint, glyphs: GlyphSet = UNICODE_GLYPHS): string {
  switch (status) {
    case "queued": return glyphs.circleEmpty;
    case "running": return paint.cyan(glyphs.circleFull);
    case "paused": return paint.yellow(glyphs.paused);
    case "completed": return paint.green(glyphs.check);
    case "failed": return paint.yellow(glyphs.cross);
    case "cancelled": return paint.dim(glyphs.cancelled);
  }
}

/**
 * `/jobs` as a table: every piece of background work, and what it is waiting on.
 *
 * The objective column comes last and takes what is left, because it is the one field with no natural
 * width — a task description is a sentence — and putting it anywhere else makes the columns after it
 * move from row to row, which is the thing a table exists to stop.
 */
export function buildJobsTable(
  jobs: readonly JobSummary[],
  options: { paint: TablePaint; glyphs?: GlyphSet },
): TableData {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const { paint } = options;
  return {
    columns: [
      { title: "", width: 1 },
      { title: "Job", width: 10 },
      { title: "Status", width: 10 },
      { title: "Tries", width: 5, align: "right" },
      { title: "Objective", width: 40 },
      { title: "Detail", width: 28 },
    ],
    rows: jobs.map((job) => [
      jobStatusMark(job.status, paint, glyphs),
      job.id,
      job.status,
      String(job.attempts),
      job.objective,
      job.detail ? paint.dim(job.detail) : "",
    ]),
  };
}
