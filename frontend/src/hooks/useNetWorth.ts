import { useSummaryCurrency } from "@/lib/summaryCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchNetWorthSummary } from "@/api/netWorth";
import type { NetWorthRange } from "@/types";

export function useNetWorthSummary(range: NetWorthRange) {
  const currency = useSummaryCurrency();
  return useQuery({
    queryKey: ["net-worth-summary", range, currency],
    queryFn: () => fetchNetWorthSummary(range, currency),
  });
}
