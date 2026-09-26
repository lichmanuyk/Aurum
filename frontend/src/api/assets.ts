import { api } from "@/api/client";
import type { Asset, AssetInput, AssetUpdateInput, AssetValuationInput } from "@/types";

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
