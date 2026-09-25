import { api } from "@/api/client";
import type { CashFlowResponse } from "@/types";

export function fetchCashFlow(startDate?: string, endDate?: string, currency?: string) {
  const params = new URLSearchParams();
  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);
  if (currency) params.set("currency", currency);
  const query = params.toString();
  return api.get<CashFlowResponse>(`/cash-flow${query ? `?${query}` : ""}`);
}
