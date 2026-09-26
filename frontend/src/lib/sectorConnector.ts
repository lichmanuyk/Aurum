import { useLayoutEffect, useState, type RefObject } from "react";

export interface ConnectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

const RADIAN = Math.PI / 180;

/** Recharts' own default chart margin — none of the three donuts here
 * override it — subtracted from the container box on every side before the
 * pie's own center/radius are resolved. See `defaultMargin` in
 * recharts/es6/chart/PolarChart.js and `parseCoordinateOfPie`/`getMaxRadius`
 * in recharts/es6/polar/Pie.js. */
const CHART_MARGIN_PX = 5;

/** Mid-angle (degrees) of one sector's own arc, in Recharts' own
 * startAngle=0/endAngle=360 convention (angle 0 = 3 o'clock, increasing
 * clockwise) — mirrors `computePieSectors` in recharts/es6/polar/Pie.js
 * exactly, not just a naive proportional split:
 * - a `paddingAngle` gap is inserted before every sector after the first,
 *   but only when *that* sector's own value is non-zero;
 * - the whole 360° span is first shrunk by paddingAngle × the count of
 *   non-zero sectors (a full circle needs a gap before wrapping back to
 *   sector 0 too, to close the loop);
 * - and, matching Recharts' own override, padding is ignored entirely for
 *   a single-sector chart regardless of what `paddingAngle` the caller
 *   passes in (`displayedData.length <= 1 ? 0 : paddingAngle`).
 * `minAngle` isn't modeled — none of the three donuts set it, so Recharts'
 * own default of 0 makes that term a no-op. Returns null for an empty/
 * all-zero chart or an out-of-range/zero-value sector — nothing to point
 * at. Exported for direct unit testing — see sectorConnector.test.ts. */
export function sectorMidAngleDeg(values: number[], index: number, paddingAngle: number): number | null {
  if (index < 0 || index >= values.length || !(values[index] > 0)) return null;
  const total = values.reduce((sum, value) => sum + value, 0);
  if (!(total > 0)) return null;

  const effectivePadding = values.length <= 1 ? 0 : paddingAngle;
  const nonZeroCount = values.filter((value) => value !== 0).length;
  const availableAngle = 360 - nonZeroCount * effectivePadding;

  let angle = 0;
  for (let i = 0; i <= index; i++) {
    const value = values[i];
    if (i > 0 && value !== 0) angle += effectivePadding;
    const span = (value / total) * availableAngle;
    if (i === index) return angle + span / 2;
    angle += span;
  }
  return null; // unreachable — index was already range-checked above
}

/** Where a mid-angle lands on the *outer* edge of the donut, in pixels
 * relative to the chart box's own top-left corner — mirrors
 * `parseCoordinateOfPie`/`getMaxRadius` in recharts/es6/polar/Pie.js for
 * `outerRadius="100%"` (all three donuts here use that): the box is shrunk
 * by the chart margin on every side first, *then* centered and sized from
 * what's left. Because the margin is symmetric, cx/cy still land exactly on
 * the box's own center — only the radius ends up smaller than half the raw
 * box, by the margin. Uses the same `polarToCartesian` formula Recharts
 * itself uses (recharts/es6/util/PolarUtils.js), not just an
 * empirically-matched approximation. Exported for direct unit testing —
 * see sectorConnector.test.ts. */
export function outerArcPoint(midAngleDeg: number, boxWidth: number, boxHeight: number): { x: number; y: number } {
  const plotWidth = boxWidth - 2 * CHART_MARGIN_PX;
  const plotHeight = boxHeight - 2 * CHART_MARGIN_PX;
  const radius = Math.min(plotWidth, plotHeight) / 2;
  return {
    x: boxWidth / 2 + Math.cos(-midAngleDeg * RADIAN) * radius,
    y: boxHeight / 2 + Math.sin(-midAngleDeg * RADIAN) * radius,
  };
}

/** Wide-screen-only thin line from the active row to the middle of its
 * sector's outer arc (see docs/tasks/donut-chart-interaction.md) — null on
 * a narrow/stacked layout (matching the `sm:flex-row` breakpoint all three
 * donut+list cards already switch on), where the synchronized highlight
 * alone is enough. Reads the chart box's actual rendered size at recompute
 * time (via `chartAreaRef`), so `outerArcPoint` above always matches
 * whatever size Recharts actually drew at, not a fixed assumption.
 * Coordinates are relative to `containerRef` (which must be
 * `position: relative` for the caller's absolutely-positioned `<svg>`
 * overlay to line up). */
export function useSectorConnectorLine(
  containerRef: RefObject<HTMLElement | null>,
  chartAreaRef: RefObject<HTMLElement | null>,
  activeRowEl: HTMLElement | null,
  midAngleDeg: number | null
): ConnectorLine | null {
  const [line, setLine] = useState<ConnectorLine | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const chartArea = chartAreaRef.current;
    if (!container || !chartArea || !activeRowEl || midAngleDeg === null) {
      setLine(null);
      return;
    }
    // Non-null: already checked above — TypeScript can't carry that
    // narrowing into this nested closure on its own.
    const angle = midAngleDeg;

    function recompute() {
      // matchMedia is absent in jsdom (component tests render this hook
      // too, via SpendingByCategoryCard) — treat that the same as "not
      // wide enough" rather than throwing; real browsers always have it.
      const isWide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
      if (!isWide) {
        setLine(null);
        return;
      }
      const containerRect = container!.getBoundingClientRect();
      const chartRect = chartArea!.getBoundingClientRect();
      const rowRect = activeRowEl!.getBoundingClientRect();
      const point = outerArcPoint(angle, chartRect.width, chartRect.height);
      setLine({
        // The row's own edge nearest the chart — donut+list is always
        // chart-then-list left to right, so the line only ever crosses
        // the gap between them, never the row's own text/amount.
        x1: rowRect.left - containerRect.left,
        y1: rowRect.top + rowRect.height / 2 - containerRect.top,
        x2: chartRect.left + point.x - containerRect.left,
        y2: chartRect.top + point.y - containerRect.top,
      });
    }

    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [containerRef, chartAreaRef, activeRowEl, midAngleDeg]);

  return line;
}
