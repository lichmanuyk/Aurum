import { api } from "@/api/client";
import type { DashboardSummary } from "@/types";

export function fetchDashboardSummary(year: number, month: number, currency?: string) {
  return api.get<DashboardSummary>(`/dashboard/summary?year=${year}&month=${month}${currency ? `&currency=${encodeURIComponent(currency)}` : ""}`);
}
