import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchDashboardSummary } from "@/api/dashboard";

export function useDashboardSummary(year: number, month: number) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["dashboard-summary", year, month, currency],
    queryFn: () => fetchDashboardSummary(year, month, currency),
  });
}
