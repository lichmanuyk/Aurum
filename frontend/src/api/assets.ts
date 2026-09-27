import { api } from "@/api/client";
import type { Asset, AssetExpenseReport, AssetInput, AssetUpdateInput, AssetValuationInput } from "@/types";

export function fetchAssets(currency?: string) {
  return api.get<Asset[]>(`/assets${currency ? `?currency=${encodeURIComponent(currency)}` : ""}`);
}

export function createAsset(input: AssetInput) {
  return api.post<Asset>("/assets", input);
}

export function updateAsset(id: number, input: AssetUpdateInput) {
  return api.patch<Asset>(`/assets/${id}`, input);
}

export function addAssetValuation(id: number, input: AssetValuationInput) {
  return api.post<Asset>(`/assets/${id}/valuations`, input);
}

export function deleteAsset(id: number) {
  return api.delete<void>(`/assets/${id}`);
}

export interface AssetExpenseFilters {
  year?: number;
  month?: number;
  page?: number;
  page_size?: number;
  // Same section display currency /assets itself accepts (see fetchAssets)
  // — the report's own reporting_currency/total_amount follow it.
  currency?: string;
}

/** Actual spending linked to one manually-tracked asset — see
 * docs/tasks/property-expense-links.md. */
export function fetchAssetExpenses(assetId: number, filters: AssetExpenseFilters = {}) {
  const params = new URLSearchParams();
  Object.entries(filters).forEach(([key, value]) => {
    if (value !== undefined && value !== null) params.set(key, String(value));
  });
  const query = params.toString();
  return api.get<AssetExpenseReport>(`/assets/${assetId}/expenses${query ? `?${query}` : ""}`);
}
