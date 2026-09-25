import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchNetWorthSummary } from "@/api/netWorth";
import type { NetWorthRange } from "@/types";

export function useNetWorthSummary(range: NetWorthRange) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["net-worth-summary", range, currency],
    queryFn: () => fetchNetWorthSummary(range, currency),
  });
}
