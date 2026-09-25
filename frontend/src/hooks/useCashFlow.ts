import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchCashFlow } from "@/api/cashFlow";

export function useCashFlow(startDate?: string, endDate?: string) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["cash-flow", startDate, endDate, currency],
    queryFn: () => fetchCashFlow(startDate, endDate, currency),
  });
}
