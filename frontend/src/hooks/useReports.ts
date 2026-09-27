import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchCategoryRanking, fetchCategorySpendingReport } from "@/api/reports";
import type { CategoryKind } from "@/types";

/** `options.enabled` (default true) — ANDed with `categoryId !== null`, so
 * passing `false` while a date-relative range's own bounds are still
 * "pending" (see lib/dateRange.ts's ComputedRange) never fires an
 * unbounded/wrong request that would render under the wrong period label. */
export function useCategorySpendingReport(
  categoryId: number | null, startDate?: string, endDate?: string, options?: { enabled?: boolean }
) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["category-spending-report", categoryId, startDate, endDate, currency],
    queryFn: () => fetchCategorySpendingReport(categoryId as number, startDate, endDate, currency),
    enabled: categoryId !== null && (options?.enabled ?? true),
  });
}

export function useCategoryRanking(
  kind: CategoryKind, startDate?: string, endDate?: string, options?: { enabled?: boolean }
) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["category-ranking", kind, startDate, endDate, currency],
    queryFn: () => fetchCategoryRanking(kind, startDate, endDate, currency),
    enabled: options?.enabled,
  });
}
