import { api } from "@/api/client";
import type { DashboardSummary } from "@/types";

// null year = all time; null month = every month of `year` (omitted from
// the query string entirely — the backend's own optional-params contract,
// see backend/app/api/routes/dashboard.py).
export function fetchDashboardSummary(year: number | null, month: number | null, currency?: string) {
  const params = new URLSearchParams();
  if (year !== null) params.set("year", String(year));
  if (year !== null && month !== null) params.set("month", String(month));
  if (currency) params.set("currency", currency);
  return api.get<DashboardSummary>(`/dashboard/summary?${params.toString()}`);
}
