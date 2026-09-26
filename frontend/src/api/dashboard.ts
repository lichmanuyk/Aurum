import { api } from "@/api/client";
import type { DashboardSummary } from "@/types";

// null year = all time; null month = every month of `year` — see
// lib/dashboardPeriod.ts. Always sends `period` explicitly (never relies
// on the backend's own default, which stays "month" for backward
// compatibility with callers that predate the two new modes — see
// backend/app/api/routes/dashboard.py).
export function fetchDashboardSummary(year: number | null, month: number | null, currency?: string) {
  const params = new URLSearchParams();
  if (year === null) {
    params.set("period", "all");
  } else if (month === null) {
    params.set("period", "year");
    params.set("year", String(year));
  } else {
    params.set("period", "month");
    params.set("year", String(year));
    params.set("month", String(month));
  }
  if (currency) params.set("currency", currency);
  return api.get<DashboardSummary>(`/dashboard/summary?${params.toString()}`);
}
