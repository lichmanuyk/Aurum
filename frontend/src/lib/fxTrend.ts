export type FxTrend = "up" | "down" | "neutral";

export interface FxSeriesPoint {
  date: string;
  value: string | null;
}

/** Green when the period's *last* value ended above its *first* — this is
 * the quoted price moving, not a user return: USD/BYN rising means the
 * dollar strengthened against BYN, not that BYN itself gained value.
 * Neutral for any series with a gap — a partial series' first/last
 * *available* points are arbitrary internal ones, not the period's true
 * edges (see docs/tasks/dashboard-fx-periods-sparklines.md) — and for 0/1
 * points. Compares the unrounded string values, never the rounded display
 * figure. */
export function computeTrend(series: FxSeriesPoint[]): FxTrend {
  if (series.length < 2 || series.some((point) => point.value === null)) return "neutral";
  const first = Number(series[0].value);
  const last = Number(series[series.length - 1].value);
  if (last > first) return "up";
  if (last < first) return "down";
  return "neutral";
}
