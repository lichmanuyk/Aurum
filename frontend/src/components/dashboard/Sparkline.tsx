import { useId } from "react";
import type { FxSeriesPoint, FxTrend } from "@/lib/fxTrend";

interface SparklineProps {
  series: FxSeriesPoint[];
  trend: FxTrend;
  width?: number;
  height?: number;
}

const TREND_CLASS: Record<FxTrend, string> = {
  up: "text-success",
  down: "text-danger",
  neutral: "text-text-muted",
};

/** Minimal trend-only mini chart — no axes/tooltip/legend, on purpose (see
 * docs/tasks/dashboard-fx-periods-sparklines.md). Renders one <polyline>
 * per contiguous run of resolved points so a gap in the series (a day with
 * no official rate) is never bridged by a fabricated straight line. The
 * left edge, nearest the card's own text, fades toward transparent via a
 * gradient stroke so the line doesn't visually collide with the numbers. */
export function Sparkline({ series, trend, width = 56, height = 28 }: SparklineProps) {
  const gradientId = useId();
  const values = series.map((point) => (point.value !== null ? Number(point.value) : null));
  const numeric = values.filter((value): value is number => value !== null);
  if (numeric.length === 0) return null;

  const min = Math.min(...numeric);
  const max = Math.max(...numeric);
  const span = max - min || 1;
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  const toY = (value: number) => height - ((value - min) / span) * height;

  const segments: string[][] = [];
  let current: string[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 1) segments.push(current);
      current = [];
      return;
    }
    current.push(`${index * stepX},${toY(value)}`);
  });
  if (current.length > 1) segments.push(current);

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={TREND_CLASS[trend]} aria-hidden="true">
      <defs>
        <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.15" />
          <stop offset="40%" stopColor="currentColor" stopOpacity="1" />
        </linearGradient>
      </defs>
      {segments.map((points, index) => (
        <polyline
          key={index}
          points={points.join(" ")}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth={1.75}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}
