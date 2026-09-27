import { api } from "@/api/client";
import type { IncomeTaxReport } from "@/types";

export interface IncomeTaxFilters {
  year?: number;
  month?: number;
  page?: number;
  page_size?: number;
  // The Reports section's own configured currency (see
  // lib/displayCurrency.tsx and docs/tasks/income-tax-separation.md) —
  // forwarded verbatim to the same `currency` override
  // get_reporting_session (api/deps.py) already accepts on every other
  // report. Supplied by useIncomeTaxReport, not the page itself.
  currency?: string;
}

export function fetchIncomeTaxReport(filters: IncomeTaxFilters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params.set(key, String(value));
  });
  return api.get<IncomeTaxReport>(`/income-tax?${params.toString()}`);
}
