import { api } from "@/api/client";
import type { IncomeTaxReport } from "@/types";

export interface IncomeTaxFilters {
  year?: number;
  month?: number;
  page?: number;
  page_size?: number;
}

export function fetchIncomeTaxReport(filters: IncomeTaxFilters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params.set(key, String(value));
  });
  return api.get<IncomeTaxReport>(`/income-tax?${params.toString()}`);
}
