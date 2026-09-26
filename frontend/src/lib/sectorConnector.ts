import { useLayoutEffect, useState, type RefObject } from "react";
import { buildDonutRoutePoints, CHART_MARGIN_PX, outerArcPoint, type ConnectorLine, type Point } from "./sectorGeometry";

// The actual geometry (angle math, margin/radius, route construction) lives
// in sectorGeometry.ts, which imports nothing but does its own math — see
// that file's own header comment for why. Re-exported here unchanged so
// every existing consumer (SpendingByCategoryCard.tsx,
// CryptoAllocationBody.tsx, CryptoNetworkAllocationBody.tsx) keeps
// importing from "@/lib/sectorConnector" without caring about the split.
export { sectorMidAngleDeg, outerArcPoint, segmentCrossesCircle, buildDonutRoutePoints } from "./sectorGeometry";
export type { ConnectorLine, Point } from "./sectorGeometry";

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

/** Same wide-screen-only gating and DOM measurement as
 * `useSectorConnectorLine`, but returns the routed polyline's waypoints
 * (container-relative, ready for an SVG `<polyline points=...>`) instead of
 * one straight line's endpoints — SpendingByCategoryCard only, see
 * docs/tasks/dashboard-donut-colors-routing.md. CryptoAllocationBody,
 * CryptoNetworkAllocationBody and AssetAllocationCard keep using
 * `useSectorConnectorLine` above untouched. */
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
