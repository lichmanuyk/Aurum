import { useSectionCurrency } from "@/lib/displayCurrency";
import { useQuery } from "@tanstack/react-query";
import { fetchCategoryRanking, fetchCategorySpendingReport } from "@/api/reports";
import type { CategoryKind } from "@/types";

export function useCategorySpendingReport(categoryId: number | null, startDate?: string, endDate?: string) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["category-spending-report", categoryId, startDate, endDate, currency],
    queryFn: () => fetchCategorySpendingReport(categoryId as number, startDate, endDate, currency),
    enabled: categoryId !== null,
  });
}

export function useCategoryRanking(kind: CategoryKind, startDate?: string, endDate?: string) {
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["category-ranking", kind, startDate, endDate, currency],
    queryFn: () => fetchCategoryRanking(kind, startDate, endDate, currency),
  });
}
