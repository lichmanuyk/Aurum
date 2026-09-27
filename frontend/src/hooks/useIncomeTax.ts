import { useQuery } from "@tanstack/react-query";
import { useSectionCurrency } from "@/lib/displayCurrency";
import { fetchIncomeTaxReport, type IncomeTaxFilters } from "@/api/incomeTax";

export function useIncomeTaxReport(filters: IncomeTaxFilters = {}) {
  // Income & Taxes reuses the Reports section's own currency preference
  // (see lib/displayCurrency.tsx's SECTIONS table) — same pattern as
  // useCashFlow/useDashboardSummary, so this report stops being the one
  // page in the app permanently stuck in the ledger's own raw currency.
  const currency = useSectionCurrency();
  return useQuery({
    queryKey: ["income-tax", filters, currency],
    queryFn: () => fetchIncomeTaxReport({ ...filters, currency }),
  });
}
