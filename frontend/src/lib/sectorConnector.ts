import { useLayoutEffect, useState, type RefObject } from "react";

export interface ConnectorLine {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Where the middle of one sector's outer arc sits, as a fraction (0–1) of
 * the chart's own square box — mirrors Recharts' default `<Pie>` layout
 * (startAngle=0, endAngle=360, sectors assigned in data order) without
 * touching Recharts internals, so it lines up with whatever it actually
 * drew for `outerRadius="100%"` (all three donuts in this app use that).
 * Exported for direct unit testing — see sectorConnector.test.ts. */
export function sectorMidpointFraction(values: number[], index: number): { x: number; y: number } | null {
  const total = values.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || index < 0 || index >= values.length || values[index] <= 0) return null;
  let cumulative = 0;
  for (let i = 0; i < index; i++) cumulative += values[i];
  const midAngleDeg = ((cumulative + values[index] / 2) / total) * 360;
  const RADIAN = Math.PI / 180;
  return {
    x: 0.5 + 0.5 * Math.cos(-midAngleDeg * RADIAN),
    y: 0.5 + 0.5 * Math.sin(-midAngleDeg * RADIAN),
  };
}

/** Wide-screen-only thin line from the active row to the middle of its
 * sector's outer arc (see docs/tasks/donut-chart-interaction.md) — null on
 * a narrow/stacked layout (matching the `sm:flex-row` breakpoint all three
 * donut+list cards already switch on), where the synchronized highlight
 * alone is enough. Reads plain DOM rects rather than reaching into
 * Recharts, so the same hook serves the dashboard donut and both crypto
 * donuts. Coordinates are relative to `containerRef` (which must be
 * `position: relative` for the caller's absolutely-positioned `<svg>`
 * overlay to line up). */
export function useSectorConnectorLine(
  containerRef: RefObject<HTMLElement | null>,
  chartAreaRef: RefObject<HTMLElement | null>,
  activeRowEl: HTMLElement | null,
  midpoint: { x: number; y: number } | null
): ConnectorLine | null {
  const [line, setLine] = useState<ConnectorLine | null>(null);
  const midpointX = midpoint?.x ?? null;
  const midpointY = midpoint?.y ?? null;

  useLayoutEffect(() => {
    const container = containerRef.current;
    const chartArea = chartAreaRef.current;
    if (!container || !chartArea || !activeRowEl || midpointX === null || midpointY === null) {
      setLine(null);
      return;
    }
    const x = midpointX;
    const y = midpointY;

    function recompute() {
      // matchMedia is absent in jsdom (component tests render this hook
      // too, via SpendingByCategoryCard) — treat that the same as "not
      // wide enough" rather than throwing; real browsers always have it.
      const isWide = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 640px)").matches;
      if (!isWide) {
        setLine(null);
        return;
      }
      // Non-null: already checked above — TypeScript can't carry that
      // narrowing into this nested closure on its own.
      const containerRect = container!.getBoundingClientRect();
      const chartRect = chartArea!.getBoundingClientRect();
      const rowRect = activeRowEl!.getBoundingClientRect();
      setLine({
        // The row's own edge nearest the chart — donut+list is always
        // chart-then-list left to right, so the line only ever crosses
        // the gap between them, never the row's own text/amount.
        x1: rowRect.left - containerRect.left,
        y1: rowRect.top + rowRect.height / 2 - containerRect.top,
        x2: chartRect.left + x * chartRect.width - containerRect.left,
        y2: chartRect.top + y * chartRect.height - containerRect.top,
      });
    }

    recompute();
    window.addEventListener("resize", recompute);
    return () => window.removeEventListener("resize", recompute);
  }, [containerRef, chartAreaRef, activeRowEl, midpointX, midpointY]);

  return line;
}
