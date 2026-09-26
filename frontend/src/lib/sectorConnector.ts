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

// ---------------------------------------------------------------------------
// Routed connector (SpendingByCategoryCard only — see
// docs/tasks/dashboard-donut-colors-routing.md). CryptoAllocationBody,
// CryptoNetworkAllocationBody and AssetAllocationCard keep using the
// straight `useSectorConnectorLine` above untouched; this is a separate,
// additive export, not a replacement.

export interface Point {
  x: number;
  y: number;
}

/** Default clearance kept between the routed line and the donut's own
 * outer edge — small enough to stay visually snug, big enough that a few
 * pixels of stroke width/anti-aliasing never reads as touching the ring
 * anywhere but the one intended endpoint. */
const ROUTE_CLEARANCE_PX = 10;

/** How far every row's connector runs horizontally before it's allowed to
 * turn — the *same* for every row (see the task's "равную длину первого
 * горизонтального участка" acceptance point), regardless of how far above
 * or below the donut's own center that row happens to sit. */
const ROUTE_HORIZONTAL_RUN_PX = 16;

/** Whether the segment p1→p2 actually passes *through* the disc of
 * `radius` around `center`, not just near it — the standard closest-point-
 * on-segment-to-center distance test. `epsilonPx` treats a point sitting
 * within that many pixels of the boundary as "on it, not through it," so a
 * segment whose only contact is the exact endpoint this whole route is
 * built to land on (radius R, by construction) doesn't flag itself.
 * Exported for direct unit testing — a route is only trustworthy if every
 * one of its own segments passes this, not just its overall bounding box. */
export function segmentCrossesCircle(p1: Point, p2: Point, center: Point, radius: number, epsilonPx = 0.5): boolean {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lengthSquared = dx * dx + dy * dy;
  const closest =
    lengthSquared === 0
      ? p1
      : (() => {
          const t = Math.max(0, Math.min(1, ((center.x - p1.x) * dx + (center.y - p1.y) * dy) / lengthSquared));
          return { x: p1.x + t * dx, y: p1.y + t * dy };
        })();
  const distance = Math.hypot(closest.x - center.x, closest.y - center.y);
  return distance < radius - epsilonPx;
}

/** The routed polyline's own waypoints, in the same page-pixel space as the
 * `center`/`outerRadius` passed in (page coordinates, matching
 * `getBoundingClientRect()` — the caller subtracts the container's own
 * offset when it renders these, same as `useSectorConnectorLine` already
 * does for its single line).
 *
 * From the row (`rowAnchor`) the line always runs horizontally by exactly
 * `ROUTE_HORIZONTAL_RUN_PX` first. From there, if a straight run the rest
 * of the way to just outside the target arc wouldn't cross the donut, it
 * takes it — the near half of the donut (facing the list) usually can.
 * Otherwise it steps *around* the donut's own keep-out circle (radius
 * `outerRadius + clearancePx`) via whichever of the top/bottom is on the
 * target's own side: two segments held at/beyond that circle's own
 * tangent height are provably clear of the smaller, real donut regardless
 * of how far the corner has to reach horizontally — no per-case fallback,
 * no chord approximation, no universal path search, just the one
 * construction this shape always needs. The final segment always runs
 * radially into the target point — the only place the line ever actually
 * touches the donut. Exported for direct unit testing —
 * see sectorConnector.test.ts. */
export function buildDonutRoutePoints(
  rowAnchor: Point,
  center: Point,
  outerRadius: number,
  midAngleDeg: number,
  options: { horizontalRunPx?: number; clearancePx?: number } = {}
): Point[] {
  const horizontalRunPx = options.horizontalRunPx ?? ROUTE_HORIZONTAL_RUN_PX;
  const clearancePx = options.clearancePx ?? ROUTE_CLEARANCE_PX;

  const rowPoint = rowAnchor;
  const afterRun: Point = { x: rowPoint.x - horizontalRunPx, y: rowPoint.y };

  const keepOutRadius = outerRadius + clearancePx;
  const pointAtRadius = (radius: number): Point => ({
    x: center.x + Math.cos(-midAngleDeg * RADIAN) * radius,
    y: center.y + Math.sin(-midAngleDeg * RADIAN) * radius,
  });
  const target = pointAtRadius(outerRadius);
  const approach = pointAtRadius(keepOutRadius);

  if (!segmentCrossesCircle(afterRun, approach, center, outerRadius)) {
    return [rowPoint, afterRun, approach, target];
  }

  // The near (list-facing) straight shot doesn't clear the donut — the
  // target sits on the far half. Go around via whichever of the top/
  // bottom tangent heights the target itself is on: a horizontal run
  // *at* that tangent height never comes closer to the center than
  // `keepOutRadius` (by definition of "tangent"), and the vertical hops
  // connecting it to `afterRun`/`approach` stay at or outside that same
  // radius too, since neither ever needs to cross back past the tangent
  // height itself to reach either endpoint.
  const viaTop = approach.y <= center.y;
  const corridorY = viaTop ? center.y - keepOutRadius : center.y + keepOutRadius;
  const corner1: Point = { x: afterRun.x, y: corridorY };
  const corner2: Point = { x: approach.x, y: corridorY };
  return [rowPoint, afterRun, corner1, corner2, approach, target];
}

/** Same wide-screen-only gating and DOM measurement as
 * `useSectorConnectorLine`, but returns the routed polyline's waypoints
 * (container-relative, ready for an SVG `<polyline points=...>`) instead of
 * one straight line's endpoints. */
export function useDonutConnectorPath(
  containerRef: RefObject<HTMLElement | null>,
  chartAreaRef: RefObject<HTMLElement | null>,
  activeRowEl: HTMLElement | null,
  midAngleDeg: number | null
): Point[] | null {
  const [path, setPath] = useState<Point[] | null>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const chartArea = chartAreaRef.current;
    if (!container || !chartArea || !activeRowEl || midAngleDeg === null) {
      setPath(null);
      return;
    }
    const angle = midAngleDeg;

    function recompute() {
      const isWide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
      if (!isWide) {
        setPath(null);
        return;
      }
      const containerRect = container!.getBoundingClientRect();
      const chartRect = chartArea!.getBoundingClientRect();
      const rowRect = activeRowEl!.getBoundingClientRect();
      const center: Point = { x: chartRect.left + chartRect.width / 2, y: chartRect.top + chartRect.height / 2 };
      const outerRadius = Math.min(chartRect.width - 2 * CHART_MARGIN_PX, chartRect.height - 2 * CHART_MARGIN_PX) / 2;
      const rowAnchor: Point = { x: rowRect.left, y: rowRect.top + rowRect.height / 2 };
      const points = buildDonutRoutePoints(rowAnchor, center, outerRadius, angle);
      setPath(points.map((point) => ({ x: point.x - containerRect.left, y: point.y - containerRect.top })));
    }

    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [containerRef, chartAreaRef, activeRowEl, midAngleDeg]);

  return path;
}
