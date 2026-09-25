import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchDashboardSummary } from "@/api/dashboard";

// null year = all time; null month = every month of `year` — see
// lib/dashboardPeriod.ts.
export function useDashboardSummary(year: number | null, month: number | null) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["dashboard-summary", year, month, currency],
    queryFn: () => fetchDashboardSummary(year, month, currency),
  });
}
