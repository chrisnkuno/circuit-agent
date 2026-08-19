import { costBars, costSummary, runningTotal, type TurnCostPoint } from "../lib/cost-chart";

/**
 * What the session has cost, per turn and in total.
 *
 * The panel showed a running total and a paragraph, which answers "how much so far" and never
 * "which turn did that". A single turn that fans out into eight tool calls can cost more than the
 * previous ten put together, and in a paragraph it is one line among many.
 *
 * Two charts rather than one with two scales. Cost per turn and cumulative spend are different
 * measures, and drawing them on a shared vertical axis would make their crossings look meaningful
 * when they are an artefact of the scaling.
 *
 * Drawn as inline SVG with no library: the window ships a strict CSP and fetches nothing at
 * runtime, and this is two dozen rectangles and a polyline.
 */

/** Bars are capped rather than filling their slot, so the band's leftover reads as air. */
const MAX_BAR = 18;
const BAR_GAP = 2;
const PLOT_HEIGHT = 56;
const LINE_HEIGHT = 40;
const WIDTH = 240;

export function CostChart(props: { turns: readonly TurnCostPoint[] }) {
  const turns = props.turns;
  if (turns.length === 0) return null;

  const bars = costBars(turns);
  const summary = costSummary(turns);
  const totals = runningTotal(turns);
  const peakTotal = totals[totals.length - 1] || 1;

  const slot = WIDTH / bars.length;
  const barWidth = Math.max(1, Math.min(MAX_BAR, slot - BAR_GAP));

  return (
    <div className="cost-charts">
      <figure className="chart">
        <figcaption className="chart-title">Cost per turn</figcaption>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${WIDTH} ${PLOT_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Cost of each of ${turns.length} turns. ${summary ? `The most expensive was turn ${summary.peakTurn}.` : "No turn has a known price."}`}
        >
          {/* One hairline baseline. A grid behind eighteen pixels of bar is ink that is not data. */}
          <line x1="0" y1={PLOT_HEIGHT - 0.5} x2={WIDTH} y2={PLOT_HEIGHT - 0.5} className="chart-axis" />
          {bars.map((bar, index) => {
            const height = Math.round(bar.height * (PLOT_HEIGHT - 6));
            const x = index * slot + (slot - barWidth) / 2;
            const y = PLOT_HEIGHT - height;
            const radius = Math.min(4, barWidth / 2, height);
            return (
              <path
                key={bar.turnNumber}
                className={`chart-bar${bar.peak ? " peak" : ""}`}
                // Rounded at the data end, square at the baseline: the baseline is a real zero and
                // a rounded foot would lift the bar off it.
                d={height <= 0
                  ? `M${x} ${PLOT_HEIGHT - 1}h${barWidth}`
                  : `M${x} ${PLOT_HEIGHT}V${y + radius}a${radius} ${radius} 0 0 1 ${radius} -${radius}h${barWidth - radius * 2}a${radius} ${radius} 0 0 1 ${radius} ${radius}V${PLOT_HEIGHT}z`}
              >
                <title>{`Turn ${bar.turnNumber} · ${bar.label}`}</title>
              </path>
            );
          })}
        </svg>
        {/* Selectively labelled: the extreme, not every bar. */}
        {summary ? (
          <p className="chart-note">
            Dearest turn {summary.peakTurn} · {bars.find((bar) => bar.peak)?.label}
          </p>
        ) : (
          <p className="chart-note">No turn here has a known price.</p>
        )}
      </figure>

      <figure className="chart">
        <figcaption className="chart-title">Spent so far</figcaption>
        <svg
          className="chart-svg"
          viewBox={`0 0 ${WIDTH} ${LINE_HEIGHT}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Cumulative spend across ${turns.length} turns.`}
        >
          <line x1="0" y1={LINE_HEIGHT - 0.5} x2={WIDTH} y2={LINE_HEIGHT - 0.5} className="chart-axis" />
          <polyline
            className="chart-line"
            points={totals
              .map((total, index) => {
                const x = totals.length === 1 ? WIDTH : (index / (totals.length - 1)) * WIDTH;
                const y = LINE_HEIGHT - (total / peakTotal) * (LINE_HEIGHT - 6);
                return `${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(" ")}
          />
          {/* An end marker, ringed in the surface colour so it stays legible over the line. */}
          <circle
            className="chart-end"
            cx={WIDTH - 4}
            cy={LINE_HEIGHT - (peakTotal / peakTotal) * (LINE_HEIGHT - 6)}
            r="4"
          />
        </svg>
      </figure>
    </div>
  );
}
