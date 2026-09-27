import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchCashFlow } from "@/api/cashFlow";

/** `options.enabled` (default true) — pass `false` while a date-relative
 * range's own bounds are still "pending" (see lib/dateRange.ts's
 * ComputedRange) so this never fires with an unbounded/wrong request that
 * would render under the wrong period label. */
export function useCashFlow(startDate?: string, endDate?: string, options?: { enabled?: boolean }) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["cash-flow", startDate, endDate, currency],
    queryFn: () => fetchCashFlow(startDate, endDate, currency),
    enabled: options?.enabled,
  });
}
