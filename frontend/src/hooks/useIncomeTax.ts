import { useQuery } from "@tanstack/react-query";
import { fetchIncomeTaxReport, type IncomeTaxFilters } from "@/api/incomeTax";

export function useIncomeTaxReport(filters: IncomeTaxFilters = {}) {
  return useQuery({
    queryKey: ["income-tax", filters],
    queryFn: () => fetchIncomeTaxReport(filters),
  });
}
