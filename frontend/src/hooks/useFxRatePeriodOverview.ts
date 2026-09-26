import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import type { FxSeriesPoint } from "@/lib/fxTrend";

export interface FxPeriodLeg {
  currency: string;
  rate_date: string;
  source: string;
}

export interface FxPeriodPair {
  base_currency: string;
  quote_currency: string;
  /** null = unavailable for `unavailable_reason` — never a guessed 0 or 1:1. */
  value: string | null;
  unavailable_reason: "fx_rate_missing" | "incomplete_coverage" | null;
  legs: FxPeriodLeg[];
  series: FxSeriesPoint[];
  coverage_expected_days: number;
  coverage_available_days: number;
}

export interface FxRatePeriodOverviewResponse {
  mode: "latest" | "average";
  label: "latest" | "average" | "ytd";
  start_date: string | null;
  end_date: string;
  series_start: string;
  series_end: string;
  items: FxPeriodPair[];
}

function buildQuery(year: number | null, month: number | null): string {
  const params = new URLSearchParams();
  if (year !== null) params.set("year", String(year));
  if (month !== null) params.set("month", String(month));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

// null year = all time; null month = every month of `year` — the same
// period the Dashboard summary itself takes (see hooks/useDashboard.ts).
// Deliberately does NOT depend on the display-currency setting: the
// card's four pairs are fixed regardless of it, so currency stays out of
// the queryKey (see docs/tasks/dashboard-fx-periods-sparklines.md).
export function useFxRatePeriodOverview(year: number | null, month: number | null) {
  return useQuery({
    queryKey: ["fx-rate-period-overview", year, month],
    queryFn: () => api.get<FxRatePeriodOverviewResponse>(`/fx-rates/overview/period${buildQuery(year, month)}`),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
}
